import {
  createDataStream,
  smoothStream,
  type UIMessage,
  type Message as SDKMessage,
  // Tool-related part types might not be directly used in messagesForSDK if content is always string
  // type ToolInvocation as SDKToolInvocation,
  // type ToolCallPart as SDKToolCallPart,
  // type TextPart as SDKTextPart,
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

// Based on Vercel build error history, the SDKMessage type for experimental_streamAssistant
// appears to expect roles: 'user' | 'data' | 'system' | 'assistant'
// and for historical messages, it seems to enforce 'content: string'.
type ExpectedSDKMessageRole = 'user' | 'data' | 'system' | 'assistant';

function transformDBMessagesToSDKMessages(dbMessages: DBMessage[], incomingUserMessage: UIMessage): SDKMessage[] {
  const sdkMessages: SDKMessage[] = [];

  dbMessages.forEach(dbMsg => {
    const currentDbRole = dbMsg.role as string;
    let concatenatedTextContent = '';

    // Always build a string representation of content from parts for history.
    if (Array.isArray(dbMsg.parts)) {
      dbMsg.parts.forEach((part: any) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          concatenatedTextContent += (concatenatedTextContent ? '\n' : '') + part.text;
        } else if (part.type === 'tool-invocation' && part.toolInvocation) {
          // Stringify tool call information if it needs to be part of the historical context.
          concatenatedTextContent += (concatenatedTextContent ? '\n' : '') +
            `[Tool call: ${part.toolInvocation.toolName}, Args: ${JSON.stringify(part.toolInvocation.args)}]`;
        } else if (part.type === 'tool-result' && part.toolResult) {
            concatenatedTextContent += (concatenatedTextContent ? '\n' : '') +
            `[Tool result for ${part.toolResult.toolName}: ${JSON.stringify(part.toolResult.result)}]`;
        }
        // Add handling for other part types if they should contribute to string content
      });
    } else if (typeof dbMsg.parts === 'string') { // Legacy or simple text
      concatenatedTextContent = dbMsg.parts;
    }

    const baseSdkMessageProps = {
      id: dbMsg.id,
      createdAt: dbMsg.createdAt,
      experimental_attachments: (dbMsg.attachments as any[]) ?? undefined,
    };

    if (['user', 'system', 'assistant'].includes(currentDbRole)) {
      sdkMessages.push({
        ...baseSdkMessageProps,
        role: currentDbRole as 'user' | 'system' | 'assistant',
        content: concatenatedTextContent, // Content is ALWAYS a string
      });
    } else if (currentDbRole === 'data') {
        // Ensure content is string for 'data' role as per previous error
        const contentForDataRole = typeof dbMsg.parts === 'string'
            ? dbMsg.parts
            : JSON.stringify(dbMsg.parts);
        sdkMessages.push({
            ...baseSdkMessageProps,
            role: 'data',
            content: contentForDataRole,
        });
    } else if (currentDbRole === 'tool') {
      // If 'tool' role from DB needs to be represented as a string in history
      // (and 'tool' is not in ExpectedSDKMessageRole for the `messages` prop)
      // We are currently filtering these out with a warning because their direct mapping has been problematic.
      // If they MUST be included, they should be stringified and potentially mapped to an 'assistant' or 'user' message
      // or a 'data' message if that's semantically appropriate and type-correct.
      console.warn(`Transforming DB message with role 'tool' (ID: ${dbMsg.id}) to string content for history.`);
       sdkMessages.push({ // Attempting to pass as system/user/assistant if 'tool' not allowed
         ...baseSdkMessageProps,
         role: 'assistant', // Or 'user', or 'system'. Choose what makes most sense for context.
                            // Or filter out if 'tool' role itself is the primary issue.
                            // Given previous errors, 'tool' role itself seems problematic for the messages array.
         content: `[Archived Tool Interaction: ${concatenatedTextContent}]`,
       });
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
        messages: messagesForSDK, // Ensure this array only contains SDKMessage where content is string for user/assistant/system
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
                 // The AI SDK's lastAssistantMessage.content might be string or array of parts
                 // Your DB `parts` field is JSON, so it can store this array.
                 if (typeof lastAssistantMessage.content === 'string') {
                    dbParts.push({ type: 'text', text: lastAssistantMessage.content });
                 } else if (Array.isArray(lastAssistantMessage.content)) {
                    // Map SDK parts to the structure your DB expects for 'parts'
                    dbParts = lastAssistantMessage.content.map(part => {
                        if (part.type === 'text') return { type: 'text', text: part.text };
                        if (part.type === 'tool-call') {
                            // Ensure your DB 'parts' can store this 'tool-invocation' structure
                            return { type: 'tool-invocation', toolInvocation: {
                                toolCallId: part.toolCallId,
                                toolName: part.toolName,
                                args: part.args
                            }};
                        }
                        // Handle other SDK part types if necessary, or filter them
                        console.warn("Unhandled SDK part type in onFinish:", part.type);
                        return null;
                    }).filter(p => p !== null) as any[];
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

// GET and DELETE handlers (no changes from previous version)
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
