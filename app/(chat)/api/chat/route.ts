/* ---------------------------------------------------------------------
   app/(chat)/api/chat/route.ts • Edge runtime • OpenAI SDK 5 beta
   --------------------------------------------------------------------- */

import {
  createDataStream,
  smoothStream,
  type UIMessage,
  type Message as SDKMessage,
  createDataStreamResponse,
} from 'ai';

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

import { auth } from '@/app/(auth)/auth';
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
import type { DBMessage } from '@/lib/db/schema';
import { ChatSDKError } from '@/lib/errors';
import { systemPrompt, type RequestHints } from '@/lib/ai/prompts';

/* ------------------------------------------------------------------ */
/* constants & helpers                                                */
/* ------------------------------------------------------------------ */

export const maxDuration = 60; // seconds
let globalStreamCtx: ResumableStreamContext | null = null;

function streamCtx() {
  if (!globalStreamCtx) {
    try {
      globalStreamCtx = createResumableStreamContext({ waitUntil: after });
    } catch (e: any) {
      if (e.message?.includes('REDIS_URL')) {
        console.log('Resumable streams disabled (missing REDIS_URL)');
      } else {
        console.error(e);
      }
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
      role: m.role as 'user' | 'assistant' | 'system' | 'data',
      content: m.parts as any,
      createdAt: m.createdAt,
      experimental_attachments: m.attachments as any,
    });
  }

  const uText =
    typeof incoming.parts === 'string'
      ? incoming.parts
      : (incoming.parts[0] as any)?.text ?? '';

  msgs.push({
    id: incoming.id,
    role: 'user',
    content: uText as any,
    createdAt: new Date(incoming.createdAt ?? Date.now()),
    experimental_attachments: incoming.experimental_attachments,
  });

  return msgs;
}

/* ==================================================================
   POST /api/chat
   ================================================================== */

export async function POST(request: Request) {
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

  /* ensure chat row exists */
  if ((await getChatById({ id: chatId })) == null) {
    await saveChat({
      id: chatId,
      userId: user.id,
      title: (
        typeof incoming.parts === 'string'
          ? incoming.parts
          : (incoming.parts[0] as any)?.text ?? ''
      ).slice(0, 250),
      visibility: selectedVisibilityType,
    });
  }

  /* previous messages + save current */
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

  /* assistant stream */
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId });

  const requestHints = geolocation(request) as RequestHints;

  const stream = createDataStream({
    execute: async (ds) => {
      const result = await openai.beta.chat.completions.streamAssistant({
        assistant_id: process.env.OPENAI_ASSISTANT_ID!,
        instructions: systemPrompt({ selectedChatModel, request_hints: requestHints }),
        messages: sdkMsgs,
        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream: ds }),
          updateDocument: updateDocument({ session, dataStream: ds }),
          requestSuggestions: requestSuggestions({ session, dataStream: ds }),
        },
        max_steps: 5,
      });

      for await (const chunk of result) ds.write(chunk.choices[0].delta?.content ?? '');
      ds.end();
    },
    onError: (e) => `stream failed: ${e instanceof Error ? e.message : 'unknown'}`,
  });

  const ctx = streamCtx();
  if (ctx) {
    const resumed = await (ctx as any).resumableStream(streamId, () => stream);
    return createDataStreamResponse({ execute: (ds: any) => ds.merge(resumed as any) });
  }

  return createDataStreamResponse({ execute: (ds: any) => ds.merge(stream) });
}

/* ==================================================================
   GET /api/chat
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
  if (!session?.user) return new ChatSDKError('unauthorized:stream').toResponse();

  const chat = await getChatById({ id: chatId });
  if (chat?.userId !== session.user.id) return new ChatSDKError('forbidden:stream').toResponse();

  const resumed = await (ctx as any).resumableStream(active, () => undefined);
  if (!resumed) return new Response(null, { status: 404 });

  return createDataStreamResponse({ execute: (ds: any) => ds.merge(resumed as any) });
}

/* ==================================================================
   DELETE /api/chat
   ================================================================== */

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return new ChatSDKError('bad_request:api', '"id" required').toResponse();

  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:api').toResponse();

  const chat = await getChatById({ id });
  if (!chat) return new ChatSDKError('not_found:chat').toResponse();
  if (chat.userId !== session.user.id) return new ChatSDKError('forbidden:chat').toResponse();

  await deleteChatById({ id });

  const ctx = streamCtx();
  if (ctx) {
    const ids = await getStreamIdsByChatId({ chatId: id });
    for (const sid of ids) {
      await (ctx as any).deleteResumableStream(sid);
    }
  }

  return Response.json({ deleted
