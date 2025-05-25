/* ------------------------------------------------------------------
   app/(chat)/api/chat/route.ts          • Edge runtime • AI-SDK ≥ 4
   ------------------------------------------------------------------ */

import {
  createDataStream,
  smoothStream,
  type UIMessage,
  type Message as SDKMessage,
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
import { generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';

import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';

import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';

import {
  postRequestBodySchema,
  type PostRequestBody,
} from './schema';

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

/* ------------------------------------------------------------------
   constants / helpers
   ------------------------------------------------------------------ */

export const maxDuration = 60;
let globalStreamContext: ResumableStreamContext | null = null;

function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(' > Resumable streams disabled (missing REDIS_URL)');
      } else {
        console.error(error);
      }
    }
  }
  return globalStreamContext;
}

/* ---------- DB → SDK message transform --------------------------- */

type ExpectedSDKMessageRole = 'user' | 'data' | 'system' | 'assistant';

function transformDBMessagesToSDKMessages(
  dbMessages: DBMessage[],
  incomingUserMessage: UIMessage,
): SDKMessage[] {
  const sdkMessages: SDKMessage[] = [];

  dbMessages.forEach((dbMsg) => {
    const currentDbRole = dbMsg.role as string;
    let concatenatedTextContent = '';

    if (Array.isArray(dbMsg.parts)) {
      dbMsg.parts.forEach((part: any) => {
        if (part.type === 'text') {
          concatenatedTextContent +=
            (concatenatedTextContent ? '\n' : '') + part.text;
        } else if (part.type === 'tool-invocation') {
          concatenatedTextContent +=
            (concatenatedTextContent ? '\n' : '') +
            `[Tool call executed: ${part.toolInvocation.toolName}, Args: ${JSON.stringify(
              part.toolInvocation.args,
            )}]`;
        } else if (part.type === 'tool-result') {
          concatenatedTextContent +=
            (concatenatedTextContent ? '\n' : '') +
            `[Tool result for ${part.toolResult.toolName}: ${JSON.stringify(
              part.toolResult.result,
            )}]`;
        }
      });
    } else if (typeof dbMsg.parts === 'string') {
      concatenatedTextContent = dbMsg.parts;
    }

    const baseProps = {
      id: dbMsg.id,
      createdAt: dbMsg.createdAt,
    };

    if (['user', 'system', 'assistant'].includes(currentDbRole)) {
      sdkMessages.push({
        ...baseProps,
        role: currentDbRole as 'user' | 'system' | 'assistant',
        content: concatenatedTextContent,
      });
    } else if (currentDbRole === 'data') {
      sdkMessages.push({
        ...baseProps,
        role: 'data',
        content:
          typeof dbMsg.parts === 'string'
            ? dbMsg.parts
            : JSON.stringify(dbMsg.parts),
      });
    } else if (currentDbRole === 'tool') {
      console.warn(
        `Transforming 'tool' role message ${dbMsg.id} into 'assistant'`,
      );
      sdkMessages.push({
        ...baseProps,
        role: 'assistant',
        content: `[Archived Tool Interaction: ${concatenatedTextContent}]`,
      });
    } else {
      console.warn(`Unhandled role '${currentDbRole}' (ID: ${dbMsg.id})`);
    }
  });

  /* current user message */
  let currentUserContent = '';
  if (Array.isArray(incomingUserMessage.parts)) {
    currentUserContent = incomingUserMessage.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('\n');
  } else if (typeof incomingUserMessage.content === 'string') {
    currentUserContent = incomingUserMessage.content;
  }

  sdkMessages.push({
    id: incomingUserMessage.id,
    role: 'user',
    content: currentUserContent,
    createdAt: new Date(incomingUserMessage.createdAt),
    experimental_attachments: incomingUserMessage.experimental_attachments,
  });

  return sdkMessages;
}

/* ==================================================================
   POST  /api/chat
   ================================================================== */
export async function POST(request: Request) {
  /* 1 ▸ parse body -------------------------------------------------- */
  let requestBody: PostRequestBody;
  try {
    requestBody = postRequestBodySchema.parse(await request.json());
  } catch (e) {
    return new ChatSDKError('bad_request:api', (e as Error).message).toResponse();
  }

  const {
    id,
    message: incomingMessage,
    selectedChatModel,
    selectedVisibilityType,
  } = requestBody;

  /* 2 ▸ auth / quota ------------------------------------------------ */
  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const userType: UserType = session.user.type;
  const count = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (count >= entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  /* 3 ▸ chat row ---------------------------------------------------- */
  const chat = await getChatById({ id });
  if (!chat) {
    const title = await generateTitleFromUserMessage({
      message: incomingMessage as UIMessage,
    });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  } else if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  /* 4 ▸ previous messages + save current --------------------------- */
  const previousDB = await getMessagesByChatId({ id });
  const messagesForSDK = transformDBMessagesToSDKMessages(
    previousDB,
    incomingMessage as UIMessage,
  );

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

  /* 5 ▸ build + run assistant stream ------------------------------- */
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });

  const requestHints = geolocation(request) as RequestHints;
  const openAIClient = myProvider.languageModel(selectedChatModel);

  const stream = createDataStream({
    execute: async (dataStream) => {
      /* ---------- THE ONLY SECTION YOU JUST CHANGED ---------- */
      const result = openAIClient.experimental_streamAssistant({
        assistantId: process.env.OPENAI_ASSISTANT_ID!,
        instructions: systemPrompt({ selectedChatModel, requestHints }),
        messages: messagesForSDK,

        /* renamed key */
        transform: smoothStream({ chunking: 'word' }),

        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream }),
          updateDocument: updateDocument({ session, dataStream }),
          requestSuggestions: requestSuggestions({ session, dataStream }),
        },

        /* everything “extra” now sits inside metadata */
        metadata: {
          activeTools:
            selectedChatModel === 'chat-model-reasoning'
              ? []
              : [
                  'getWeather',
                  'createDocument',
                  'updateDocument',
                  'requestSuggestions',
                ],
          maxSteps: 5,
          messageIdFn: generateUUID,
          telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-assistant',
          },
        },

        onFinish: async ({ response }) => {
          try {
            const lastAssistant = response.messages
              .filter((m) => m.role === 'assistant')
              .pop();

            if (!lastAssistant?.id) return;

            /* flatten parts for DB */
            let dbParts: any[] = [];
            if (typeof lastAssistant.content === 'string') {
              dbParts.push({ type: 'text', text: lastAssistant.content });
            } else if (Array.isArray(lastAssistant.content)) {
              dbParts = lastAssistant.content
                .map((p) => {
                  if (p.type === 'text')
                    return { type: 'text', text: p.text };
                  if (p.type === 'tool-call')
                    return {
                      type: 'tool-invocation',
                      toolInvocation: {
                        toolCallId: p.toolCallId,
                        toolName: p.toolName,
                        args: p.args,
                      },
                    };
                  console.warn('Unhandled part', p.type);
                  return null;
                })
                .filter(Boolean) as any[];
            }

            await saveMessages({
              messages: [
                {
                  id: lastAssistant.id,
                  chatId: id,
                  role: lastAssistant.role,
                  parts: dbParts,
                  attachments:
                    (lastAssistant.experimental_attachments as any[]) ?? [],
                  createdAt: lastAssistant.createdAt ?? new Date(),
                },
              ],
            });
          } catch (e) {
            console.error('Failed to save assistant message', e);
          }
        },
      });

      result.consumeStream();
      result.mergeIntoDataStream(dataStream as any, { sendReasoning: true });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : 'Unknown';
      return new ChatSDKError('bad_request:stream', msg).toResponse();
    },
  });

  /* 6 ▸ resumable stream / return --------------------------------- */
  const streamContext = getStreamContext();
  if (streamContext) {
    const resStream = await streamContext.resumableStream(streamId, () => stream);
    return new Response(resStream);
  }

  return new Response(stream);
}

/* ==================================================================
   GET  /api/chat         – unchanged
   DELETE /api/chat       – unchanged
   ================================================================== */

export async function GET(request: Request) {
  /* … unchanged … */
}

export async function DELETE(request: Request) {
  /* … unchanged … */
}
