/* ---------------------------------------------------------------------
   app/(chat)/api/chat/route.ts        •  Edge runtime  •  Assistants API
   --------------------------------------------------------------------- */

import {
  createDataStream,
  smoothStream,
  type UIMessage,
  type Message as SDKMessage,
  StreamingTextResponse,
  experimental_streamAssistant,   // 👈  NEW
} from 'ai';
import { openai } from '@ai-sdk/openai';         // pre-configured OpenAI client
import { auth, type UserType } from '@/app/(auth)/auth';

import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessagesByChatId,
  getStreamIdsByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID } from '@/lib/utils';

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

  for (const m of dbMsgs) {
    msgs.push({
      id: m.id,
      role: m.role,
      content: m.parts as any,
      createdAt: m.createdAt,
      experimental_attachments: m.attachments as any,
    });
  }

  // user message we just received
  const uText =
    typeof incoming.parts === 'string' ? incoming.parts : incoming.parts[0];

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
  const user = session?.user;

  if (!user) return new ChatSDKError('unauthorized:api').toResponse();

  /* 2 ▸ chat record (create if first msg) -------------------------- */
  if ((await getChatById({ id: chatId })) == null) {
    await saveChat({
      id: chatId,
      userId: user.id,
      userType: (user as UserType).userType ?? 'free',
      title: incoming.parts.slice(0, 250) as string,
      visibilityType: selectedVisibilityType,
      createdAt: new Date(incoming.createdAt ?? Date.now()),
    });
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
      /* ------------------------------------------------------------- */
      /*  Assistants API call — FIXED to use experimental_streamAssistant */
      /* ------------------------------------------------------------- */
      const result = await experimental_streamAssistant({
        openai,                                // 👈 pass the client instance
        assistant: process.env.OPENAI_ASSISTANT_ID!, // required
        instructions: systemPrompt({ selectedChatModel, requestHints }),
        messages: sdkMsgs,
        transform: smoothStream({ chunking: 'word' }),

        /* Tool definitions */
        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream }),
          updateDocument: updateDocument({ session, dataStream }),
          requestSuggestions: requestSuggestions({ session, dataStream }),
        },

        maxSteps: 5,
        activeTools:
          selectedChatModel === 'chat-model-reasoning'
            ? []
            : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
      });

      /* pipe the assistant stream into the client SSE */
      for await (const part of result.value) dataStream.write(part);
      dataStream.end();
    },
  });

  /* 5 ▸ resumable handling ---------------------------------------- */
  const ctx = streamCtx();
  if (ctx) {
    return new StreamingTextResponse(await ctx.resumableStream(streamId, () => stream));
  }
  return new StreamingTextResponse(stream);
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

  const userOwnsChat = await getChatById({ id: chatId });
  if (userOwnsChat?.userId !== session.user.id)
    return new ChatSDKError('forbidden:stream').toResponse();

  return new StreamingTextResponse(await ctx.getResumableStream(active));
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id)
    return new ChatSDKError('bad_request:api', '"id" required').toResponse();

  const session = await auth();
  if (!session?.user)
    return new ChatSDKError('unauthorized:api').toResponse();

  const chat = await getChatById({ id });
  if (!chat) return new ChatSDKError('not_found:chat').toResponse();
  if (chat.userId !== session.user.id)
    return new ChatSDKError('forbidden:chat').toResponse();

  await deleteChatById({ id });

  const ctx = streamCtx();
  if (ctx) {
    const ids = await getStreamIdsByChatId({ chatId: id });
    for (const sid of ids) await (ctx as any).deleteResumableStream(sid);
  }

  return Response.json({ deleted: true });
}
