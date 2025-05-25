import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  smoothStream,
  // streamText, // streamText is not used when experimental_streamAssistant is the primary method
} from 'ai';
import { openai } from '@ai-sdk/openai'; // Import the openai client
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
// myProvider is not strictly needed here if we import openai directly for experimental_streamAssistant
// import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat } from '@/lib/db/schema';
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import { systemPrompt } from '@/lib/ai/prompts'; // Ensure systemPrompt is imported

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

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const { id, message, selectedChatModel, selectedVisibilityType } = requestBody;

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
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  } else if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const previousMessages = await getMessagesByChatId({ id });

  const messages = appendClientMessage({
    messages: previousMessages.map((m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant' | 'system' | 'data' | 'tool', // Added 'tool'
      content: Array.isArray(m.parts) ? m.parts.map(p => (p as any).text || '').join(' ') : String(m.parts), // Simplified content
      name: (m as any).name ?? undefined,
      // toolName: (m as any).toolName ?? undefined, // These might not be needed directly for OpenAI aPI
      // toolInput: (m as any).toolInput ?? undefined,
      createdAt: m.createdAt,
      experimental_attachments: m.attachments as any[] ?? [], // Ensure it's an array
      toolInvocations: (m.parts as any[])?.filter(p => p.type === 'tool-invocation').map(p => p.toolInvocation) ?? undefined, // Map parts to toolInvocations
      toolResults: (m.parts as any[])?.filter(p => p.type === 'tool-result').map(p => p.toolResult) ?? undefined, // Map parts to toolResults
    })),
    message,
  });

  await saveMessages({
    messages: [
      {
        chatId: id,
        id: message.id,
        role: 'user',
        parts: message.parts,
        attachments: message.experimental_attachments ?? [],
        createdAt: new Date(),
      },
    ],
  });

  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });

  const requestHints = geolocation(request); // Define requestHints

  const stream = createDataStream({
     execute: async (dataStream) => {
      const result = openai.experimental_streamAssistant({ // Use the imported openai client
        assistantId: process.env.OPENAI_ASSISTANT_ID!,
        system: systemPrompt({ selectedChatModel, requestHints }),
        messages: messages as any, // Cast if necessary after ensuring compatibility
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
              const assistantId = getTrailingMessageId({
                messages: response.messages.filter(m => m.role === 'assistant'),
              });

              if (!assistantId) throw new Error('No assistant message found!');

              // appendResponseMessages is for UI messages, here we need to adapt for DB
              const lastAssistantMessage = response.messages.filter(m => m.role === 'assistant').pop();

              if (lastAssistantMessage) {
                 await saveMessages({
                    messages: [
                      {
                        id: assistantId, // Ensure this ID matches what was generated/used by the SDK
                        chatId: id,
                        role: lastAssistantMessage.role,
                        parts: lastAssistantMessage.parts as any[], // Ensure correct type
                        attachments: (lastAssistantMessage.experimental_attachments as any[]) ?? [],
                        createdAt: new Date(),
                      },
                    ],
                  });
              }
            } catch (e) {
              console.error('Failed to save chat or assistant message:', e);
            }
          }
        },
        experimental_telemetry: {
          isEnabled: isProductionEnvironment,
          functionId: 'stream-assistant', // Updated for clarity
        },
      });

      result.consumeStream(); // Ensure the stream is consumed
      result.mergeIntoDataStream(dataStream as any, { sendReasoning: true }); // Cast dataStream if types mismatch
    },
    onError: (e) => {
      console.error("Error in stream execution:", e);
      return 'Oops, an error occurred!';
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
    return new Response(null, { status: 404 }); // Or some other appropriate response
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

  if (resumableStream === 'found') {
    const isStreamExpired = differenceInSeconds(
      new Date(),
      new Date(resumableStream.lastUpdatedAt),
    );

    if (isStreamExpired > 30) {
      await streamContext.deleteResumableStream(activeStreamId);
      return new Response(null, { status: 200 });
    }

    return new Response(resumableStream.data);
  }

  if (resumableStream === 'not-found') {
    return new Response(null, { status: 404 });
  }

  return new Response(null, { status: 200 });
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

  return Response.json(deletedChat, { status: 200 });
}
