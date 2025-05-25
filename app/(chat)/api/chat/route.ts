import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  smoothStream,
  streamText, // streamText can remain if used elsewhere, but not for the assistant call
  type UIMessage, // Import UIMessage
  type Message as SDKMessage, // Import the SDK's Message type
  type ToolInvocation, // Import ToolInvocation
  type ToolResultPart, // Import ToolResultPart
} from 'ai';
import { openai } from '@ai-sdk/openai'; // Import the openai client directly
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
// myProvider might not be needed for this specific call if using openai directly
// import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation, type Geo } from '@vercel/functions'; // Ensure Geo is imported if requestHints is typed
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat, DBMessage } from '@/lib/db/schema'; // Ensure DBMessage is imported
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import { systemPrompt, type RequestHints } from '@/lib/ai/prompts'; // Ensure systemPrompt and RequestHints are imported

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

// Helper to transform DBMessage parts to SDKMessage content/toolInvocations
function transformDBMessagesToSDKMessages(dbMessages: DBMessage[], incomingUserMessage: UIMessage): SDKMessage[] {
  const allMessages: SDKMessage[] = dbMessages.map((m) => {
    let content: string = '';
    const toolInvocations: ToolInvocation[] = [];

    if (Array.isArray(m.parts)) {
      m.parts.forEach((part: any) => {
        if (part.type === 'text') {
          content += part.text;
        } else if (part.type === 'tool-invocation') {
          toolInvocations.push(part.toolInvocation);
        }
        // Add other part type handling if necessary
      });
    } else if (typeof m.parts === 'string') { // Fallback for old schema or simple content
        content = m.parts;
    }


    const sdkMessage: SDKMessage = {
      id: m.id,
      role: m.role as SDKMessage['role'],
      content: content,
      createdAt: m.createdAt,
    };

    if (toolInvocations.length > 0) {
      sdkMessage.toolInvocations = toolInvocations;
    }
    // Add toolResults if applicable from your schema
    // if (m.toolResults) sdkMessage.toolResults = m.toolResults;


    return sdkMessage;
  });

    // Append the new user message, converting its parts to content string
    let userMessageContent = '';
    if (Array.isArray(incomingUserMessage.parts)) {
        userMessageContent = incomingUserMessage.parts
            .filter(part => part.type === 'text')
            .map(part => (part as { type: 'text'; text: string }).text)
            .join('\n');
    } else if (typeof incomingUserMessage.content === 'string') {
        userMessageContent = incomingUserMessage.content;
    }


  allMessages.push({
    id: incomingUserMessage.id,
    role: 'user',
    content: userMessageContent,
    createdAt: incomingUserMessage.createdAt,
    experimental_attachments: incomingUserMessage.experimental_attachments
  });

  return allMessages;
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
  const messagesForSDK = transformDBMessagesToSDKMessages(previousDBMessages, incomingMessage as UIMessage);


  await saveMessages({
    messages: [
      {
        chatId: id,
        id: incomingMessage.id,
        role: 'user',
        parts: incomingMessage.parts as any[], // Ensure parts schema matches DB
        attachments: (incomingMessage.experimental_attachments as any[]) ?? [],
        createdAt: new Date(incomingMessage.createdAt),
      },
    ],
  });

  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });

  const requestHints = geolocation(request) as RequestHints;

  const stream = createDataStream({
     execute: async (dataStream) => {
      const result = openai.experimental_streamAssistant({
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
                 await saveMessages({
                    messages: [
                      {
                        id: lastAssistantMessage.id,
                        chatId: id,
                        role: lastAssistantMessage.role,
                        parts: lastAssistantMessage.parts as any[],
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
    // If Redis is not configured, resumable streams are not available.
    // Depending on desired behavior, could return 404 or indicate service unavailability.
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

  if (resumableStream && resumableStream.status === 'found') { // Check status explicitly
    const isStreamExpired = differenceInSeconds(
      new Date(),
      new Date(resumableStream.lastUpdatedAt),
    );

    // Consider a configurable timeout for stream expiration
    if (isStreamExpired > 60) { // Increased timeout to 60 seconds
      await streamContext.deleteResumableStream(activeStreamId);
      return new Response(null, { status: 200 }); // Indicate stream ended/expired
    }

    return new Response(resumableStream.data);
  }

  // 'not-found' or other statuses from getResumableStream
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

  // Also delete any resumable streams associated with this chat
  const streamContext = getStreamContext();
  if (streamContext) {
    const streamIds = await getStreamIdsByChatId({ chatId: id });
    for (const streamId of streamIds) {
      await streamContext.deleteResumableStream(streamId);
    }
  }

  return Response.json(deletedChat, { status: 200 });
}
