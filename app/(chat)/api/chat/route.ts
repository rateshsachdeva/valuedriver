/* ---------------------------------------------------------------------
   app/(chat)/api/chat/route.ts        •  Edge runtime  •  Assistants API
   --------------------------------------------------------------------- */

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
import { experimental_streamAssistant } from 'ai';

import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';

import { isProductionEnvironment } from '@/lib/constants';
import { entitlementsByUserType } from '@/lib/ai/entitlements';

import {
  postRequestBodySchema,
  type PostRequestBody,
} from './schema';

import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat, DBMessage } from '@/lib/db/schema';
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import { systemPrompt, type RequestHints } from '@/lib/ai/prompts';

/* ------------------------------------------------------------------ */
/*  constants & helpers                                               */
/* ------------------------------------------------------------------ */

export const maxDuration = 60;
let globalStreamCtx: ResumableStreamContext | null = null;

function streamCtx() {
  if (!globalStreamCtx) {
    try {
      globalStreamCtx = createResumableStreamContext({ waitUntil: after });
    } catch (e: any) {
      if (e.message?.includes('REDIS_URL')) {
        console.log('Resumable streams disabled (missing REDIS_URL)');
      } else console.error(e);
    }
  }
  return globalStreamCtx;
}

/* ---------- DB → SDK message transform --------------------------- */

function toSDKMessages(
  dbMsgs: DBMessage[],
  incoming: UIMessage,
): SDKMessage[] {
  const msgs: SDKMessage[] = [];

  dbMsgs.forEach((db) => {
    const text = Array.isArray(db.parts)
      ? db.parts
          .map((p: any) =>
            p.type === 'text'
              ? p.text
              : p.type === 'tool-invocation'
              ? `Tool call: ${p.toolInvocation.toolName}`
              : p.type === 'tool-result'
              ? `Tool result: ${p.toolResult.toolName}`
              : '',
          )
          .filter(Boolean)
          .join('\n')
      : String(db.parts);

    const base = { id: db.id, createdAt: db.createdAt };

    switch (db.role) {
      case 'user':
      case 'assistant':
      case 'system':
        msgs.push({ ...base, role: db.role, content: text });
        break;
      case 'data':
        msgs.push({ ...base, role: 'data', content: text });
        break;
      case 'tool':
        msgs.push({
          ...base,
          role: 'assistant',
          content: `Archived tool interaction\n${text}`,
        });
        break;
      default:
        console.warn(Skipping unknown role “${db.role}” (id ${db.id}));
    }
  });

  // add current user message
  const uText = Array.isArray(incoming.parts)
    ? incoming.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as any).text)
        .join('\n')
    : (incoming.content as string);

  msgs.push({
    id: incoming.id,
    role: 'user',
    content: uText,
    createdAt: new Date(incoming.createdAt ?? Date.now()),
    experimental_attachments: incoming.experimental_attachments,
  });

  return msgs;
}

/* ==================================================================
   POST  /api/chat
   ================================================================== */
export async function POST(request: Request) {
  /* 1 ▸ body & auth ------------------------------------------------ */
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch (e) {
    return new ChatSDKError('bad_request:api', (e as Error).message).toResponse();
  }

  const {
    id: chatId,
    message: incoming,
    selectedChatModel,
    selectedVisibilityType,
  } = body;

  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();

  const count24h = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (count24h >= entitlementsByUserType[session.user.type as UserType].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  /* 2 ▸ chat row --------------------------------------------------- */
  const chat = await getChatById({ id: chatId });
  if (!chat) {
// Title = first 80-char slice of the user’s opening message
const firstUserText = Array.isArray(incoming.parts)
  ? incoming.parts
      .filter(p => p.type === 'text')
      .map(p => (p as any).text)
      .join(' ')
  : (incoming.content as string);

await saveChat({
  id: chatId,
  userId: session.user.id,
  title: firstUserText.slice(0, 80) || 'Untitled chat',
  visibility: selectedVisibilityType,
});
  } else if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  /* 3 ▸ previous msgs + save current ------------------------------ */
  const prev = await getMessagesByChatId({ id: chatId });
  const sdkMsgs = toSDKMessages(prev, incoming);

  await saveMessages({
    messages: [
      {
        chatId,
        id: incoming.id,
        role: 'user',
        parts: incoming.parts as any[],
        attachments: (incoming.experimental_attachments as any[]) ?? [],
        createdAt: new Date(incoming.createdAt ?? Date.now()),
      },
    ],
  });

  /* 4 ▸ assistant stream ------------------------------------------ */
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId });

  const requestHints = geolocation(request) as RequestHints;

  const stream = createDataStream({
    execute: async (dataStream) => {
      /* ---- inside the execute: async (dataStream) => { … } block ---- */
      
      const result = await experimental_streamAssistant({
        {
          assistantId: process.env.OPENAI_ASSISTANT_ID!,
          instructions: systemPrompt({ selectedChatModel, requestHints }),
          messages: sdkMsgs,
          transform: smoothStream({ chunking: 'word' }),
      
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({ session, dataStream }),
          },
      
          /* extra knobs the current typings don’t declare */
          maxSteps: 5,
          activeTools:
            selectedChatModel === 'chat-model-reasoning'
              ? []
              : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
          messageIdFn: generateUUID,
          telemetry: isProductionEnvironment && { functionId: 'stream-assistant' },
      
          onFinish: async ({ response }: { response: any }) => {
            /* … your existing save-to-DB logic … */
          },
        } as any,        //  ← cast the options object
      );


      result.consumeStream();
      result.mergeIntoDataStream(dataStream as any, { sendReasoning: true });
    },
    onError: (e) =>
      stream failed: ${e instanceof Error ? e.message : 'unknown'},
  });

  /* 5 ▸ resumable handling ---------------------------------------- */
  const ctx = streamCtx();
  if (ctx) {
    return new Response(await ctx.resumableStream(streamId, () => stream));
  }
  return new Response(stream);
}

/* ==================================================================
   GET /api/chat           – unchanged
   DELETE /api/chat        – unchanged
   ================================================================== */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');
  if (!chatId)
    return new ChatSDKError('bad_request:api', '"chatId" required').toResponse();

  const ctx = streamCtx();
  if (!ctx) return new Response(null, { status: 404 });

  const ids = await getStreamIdsByChatId({ chatId });
  const active = ids.at(-1);
  if (!active) return new Response(null, { status: 404 });

  const session = await auth();
  if (!session?.user)
    return new ChatSDKError('unauthorized:stream').toResponse();

  const chat = (await getChatById({ id: chatId })) as Chat;
  if (!chat)
    return new ChatSDKError('not_found:chat').toResponse();

  if (chat.visibility === 'private' && chat.userId !== session.user.id)
    return new ChatSDKError('forbidden:stream').toResponse();

  const resumable = await (ctx as any).getResumableStream(active);
  if (!resumable || resumable.status !== 'found') return new Response(null, { status: 404 });

  if (
    differenceInSeconds(new Date(), new Date(resumable.lastUpdatedAt)) > 60
  ) {
    await (ctx as any).deleteResumableStream(active);
    return new Response(null, { status: 200 });
  }
  return new Response(resumable.data);
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return new ChatSDKError('bad_request:api', '"id" required').toResponse();

  const session = await auth();
  if (!session?.user)
    return new ChatSDKError('unauthorized:chat').toResponse();

  const chat = await getChatById({ id });
  if (!chat) return new ChatSDKError('not_found:chat').toResponse();
  if (chat.userId !== session.user.id)
    return new ChatSDKError('forbidden:chat').toResponse();

  const deleted = await deleteChatById({ id });

  const ctx = streamCtx();
  if (ctx) {
    const ids = await getStreamIdsByChatId({ chatId: id });
    for (const sid of ids) await (ctx as any).deleteResumableStream(sid);
  }

  return Response.json(deleted, { status: 200 });
}
