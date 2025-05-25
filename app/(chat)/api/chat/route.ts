import {
  createDataStream,
  smoothStream,
  type UIMessage,
  type Message as SDKMessage,
  type ToolInvocation as SDKToolInvocation,
  type ToolCallPart as SDKToolCallPart,
  type TextPart as SDKTextPart,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { auth, type UserType } from '@/app/(auth)/auth';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getStreamIdsByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation, type Geo } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat, DBMessage } from '@/lib/db/schema';
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import { systemPrompt, type RequestHints } from '@/lib/ai/prompts';

export const maxDuration = 60;
let globalStreamContext: ResumableStreamContext | null = null;

function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(' > Resumable streams are disabled due to missing REDIS_URL');
      } else {
        console.error(error);
      }
    }
  }
  return globalStreamContext;
}

type ExpectedSDKMessageRole = 'user' | 'data' | 'system' | 'assistant';

function transformDBMessagesToSDKMessages(dbMessages: DBMessage[], incomingUserMessage: UIMessage): SDKMessage[] {
  const sdkMessages: SDKMessage[] = [];

  dbMessages.forEach(dbMsg => {
    const currentDbRole = dbMsg.role as string;
    let textPartsAggregated: string[] = [];
    let toolCallPartsForSdk: SDKToolCallPart[] = [];

    if (Array.isArray(dbMsg.parts)) {
      dbMsg.parts.forEach((part: any) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          textPartsAggregated.push(part.text);
        } else if (currentDbRole === 'assistant' && part.type === 'tool-invocation' && part.toolInvocation) {
          toolCallPartsForSdk.push({
            type: 'tool-call',
            toolCallId: part.toolInvocation.toolCallId || generateUUID(),
            toolName: part.toolInvocation.toolName,
            args: part.toolInvocation.args,
          });
        }
      });
    } else if (typeof dbMsg.parts === 'string') {
      textPartsAggregated.push(dbMsg.parts);
    }
    const aggregatedTextContent = textPartsAggregated.join('\n');

    const baseSdkMessageProps = {
      id: dbMsg.id,
      createdAt: dbMsg.createdAt,
      experimental_attachments: (dbMsg.attachments as any[]) ?? undefined,
    };

    if (currentDbRole === 'user' || currentDbRole === 'system') {
      sdkMessages.push({
        ...baseSdkMessageProps,
        role: currentDbRole as 'user' | 'system',
        content: aggregatedTextContent, // Content is string
      });
    } else if (currentDbRole === 'assistant') {
      let assistantContent: string | Array<SDKTextPart | SDKToolCallPart>;
      if (toolCallPartsForSdk.length > 0) {
        const contentParts: Array<SDKTextPart | SDKToolCallPart> = [];
        if (aggregatedTextContent.trim() !== '') {
          contentParts.push({ type: 'text', text: aggregatedTextContent });
        }
        contentParts.push(...toolCallPartsForSdk);
        assistantContent = contentParts;
      } else {
        assistantContent = aggregatedTextContent;
      }
      sdkMessages.push({ // This was approx line 120 where the previous error occurred
        ...baseSdkMessageProps,
        role: 'assistant',
        content: assistantContent, // This can be string or Array<SDKTextPart | SDKToolCallPart>
      });
    } else if (currentDbRole === 'data') {
        // Directly addressing: Type 'unknown' is not assignable to type 'string'.
        // This means even for role: 'data', content is expected as string in this context.
        const contentForDataRole = typeof dbMsg.parts === 'string'
            ? dbMsg.parts
            : JSON.stringify(dbMsg.parts); // Stringify the JSON parts

        sdkMessages.push({ // THIS IS LIKELY LINE 104 (or new 120) causing the error
            ...baseSdkMessageProps,
            role: 'data',
            content: contentForDataRole, // Ensure content is string
        });
    } else if (currentDbRole === 'tool') {
      console.warn(`Filtering out DB message with role 'tool' (ID: ${dbMsg.id}) as it's not directly supported or mapped for history in this context.`);
    } else {
      console.warn(`Unknown or unhandled role '${currentDbRole}' from DB message (ID: ${dbMsg.id}). Skipping.`);
    }
  });

  let currentUserMessageContent = '';
  if (Array.isArray(incomingUserMessage.parts)) {
      currentUserMessageContent = incomingUserMessage.parts
          .filter(part => part.type === 'text')
          .map(part => (part as { type: 'text'; text: string }).text)
          .join('\n');
  } else if (typeof incomingUserMessage.content === 'string') {
      currentUserMessageContent = incomingUserMessage.content;
  }

  sdkMessages.push({
    id: incomingUserMessage.id,
    role: 'user',
    content: currentUserMessageContent,
    createdAt: new Date(incomingUserMessage.createdAt),
    experimental_attachments: incomingUserMessage.experimental_attachments
  });

  return sdkMessages;
}


export async function POST(request: Request) {
  let requestBody: PostRequestBody;
  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    console.error("Request body parsing error:", error);
    return new ChatSDKError('bad_request:api', (error as Error).message).toResponse();
  }

  const { id, message: incomingMessage, selectedChatModel, selectedVisibilityType } = requestBody;

  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const userType: UserType = session.user.type;
  const messageCount = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });

  if (messageCount >= entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: incomingMessage as UIMessage });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  } else if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const previousDBMessages = await getMessagesByChatId({ id });
  const messagesForSDK: SDKMessage[] = transformDBMessagesToSDKMessages(previousDBMessages, incomingMessage as UIMessage);


  await saveMessages({
    messages: [
      {
        chatId: id,
        id: incomingMessage.id,
        role: 'user',
        parts: incomingMessage.parts as any[],
        attachments: (incomingMessage.experimental_attachments as any[]) ?? [],
        createdAt: new Date(incomingMessage.createdAt),
      },
    ],
  });

  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });

  const requestHints = geolocation(request) as RequestHints;
  const openAIClient = myProvider.languageModel(selectedChatModel);

  const stream = createDataStream({
     execute: async (dataStream) => {
      const result = openAIClient.experimental_streamAssistant({
        assistantId: process.env.OPENAI_ASSISTANT_ID!,
        system: systemPrompt({ selectedChatModel, requestHints }),
        messages: messagesForSDK,
        maxSteps: 5,
        experimental_activeTools:
          selectedChatModel === 'chat-model-reasoning'
            ? []
            : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
        experimental_transform: smoothStream({ chunking: 'word' }),
        experimental_generateMessageId: generateUUID,
        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream }),
          updateDocument: updateDocument({ session, dataStream }),
          requestSuggestions: requestSuggestions({ session, dataStream }),
        },
        onFinish: async ({ response }) => {
          if (session.user?.id) {
            try {
              const lastAssistantMessage = response.messages.filter(m => m.role === 'assistant').pop();
              if (lastAssistantMessage && lastAssistantMessage.id) {
                 let dbParts: any[] = [];
                 if (typeof lastAssistantMessage.content === 'string') {
                    dbParts.push({ type: 'text', text: lastAssistantMessage.content });
                 } else if (Array.isArray(lastAssistantMessage.content)) {
                    dbParts = lastAssistantMessage.content.map(part => {
                        if (part.type === 'text') return { type: 'text', text: part.text };
                        if (part.type === 'tool-call') return { type: 'tool-invocation', toolInvocation: part };
                        return part; // Or handle other/unknown part types
                    });
                 }

                 await saveMessages({
                    messages: [
                      {
                        id: lastAssistantMessage.id,
                        chatId: id,
                        role: lastAssistantMessage.role,
                        parts: dbParts, 
                        attachments: (lastAssistantMessage.experimental_attachments as any[]) ?? [],
                        createdAt: lastAssistantMessage.createdAt ?? new Date(),
                      },
                    ],
                  });
              } else {
                console.error('No assistant message or ID found in response to save.');
              }
            } catch (e) {
              console.error('Failed to save assistant message:', e);
            }
          }
        },
        experimental_telemetry: {
          isEnabled: isProductionEnvironment,
          functionId: 'stream-assistant',
        },
      });

      result.consumeStream();
      result.mergeIntoDataStream(dataStream as any, { sendReasoning: true });
    },
    onError: (e) => {
      console.error("Error in stream execution:", e);
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ChatSDKError('bad_request:stream', `Stream execution failed: ${errorMessage}`).toResponse();
    }
  });

  const streamContext = getStreamContext();
  if (streamContext) {
    return new Response(await streamContext.resumableStream(streamId, () => stream));
  }
  return new Response(stream);
}

// GET and DELETE handlers
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');

  if (!chatId) {
    return new ChatSDKError(
      'bad_request:api',
      'Parameter "chatId" is required',
    ).toResponse();
  }

  const streamContext = getStreamContext();
  if (!streamContext) {
    console.log('Stream context (Redis) not available for GET /api/chat');
    return new Response(null, { status: 404 });
  }

  const streamIds = await getStreamIdsByChatId({ chatId });
  const activeStreamId = streamIds.at(-1);

  if (!activeStreamId) {
    return new Response(null, { status: 404 });
  }

  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:stream').toResponse();
  }

  const chat = (await getChatById({ id: chatId })) as Chat;
  if (!chat) {
    return new ChatSDKError('not_found:chat').toResponse();
  }

  if (chat.visibility === 'private' && chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:stream').toResponse();
  }

  const resumableStream = await streamContext.getResumableStream(activeStreamId);

  if (resumableStream && resumableStream.status === 'found') {
    const isStreamExpired = differenceInSeconds(
      new Date(),
      new Date(resumableStream.lastUpdatedAt),
    );

    if (isStreamExpired > 60) {
      await streamContext.deleteResumableStream(activeStreamId);
      return new Response(null, { status: 200 });
    }

    return new Response(resumableStream.data);
  }
  return new Response(null, { status: 404 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError(
      'bad_request:api',
      'Parameter "id" is required',
    ).toResponse();
  }

  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });
  if (!chat) {
    return new ChatSDKError('not_found:chat').toResponse();
  }

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  const streamContext = getStreamContext();
  if (streamContext) {
    const streamIds = await getStreamIdsByChatId({ chatId: id });
    for (const streamId of streamIds) {
      await streamContext.deleteResumableStream(streamId);
    }
  }

  return Response.json(deletedChat, { status: 200 });
}
