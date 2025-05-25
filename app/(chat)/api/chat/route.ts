// app/(chat)/api/chat/route.ts
import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  smoothStream,
  // streamText, // Not used for the main assistant flow
  type UIMessage,
  type Message as SDKMessage,
  type ToolInvocation,
  // type ToolResultPart, // Not directly used in the transform, parts cover it
} from 'ai';
// Instead of importing 'openai' here and creating a new instance,
// let's leverage your existing myProvider, assuming it's correctly configured.
import { myProvider } from '@/lib/ai/providers'; // Ensure this provides the main OpenAI client
import { auth, type UserType } from '@/app/(auth)/auth';
// ... (other imports remain the same)
import { systemPrompt, type RequestHints } from '@/lib/ai/prompts';
import { geolocation, type Geo } from '@vercel/functions';
import { ChatSDKError } from '@/lib/errors';
// ... other imports

// The transformDBMessagesToSDKMessages function from the previous response
// might need adjustments based on the exact structure of SDKMessage
// if toolInvocations and toolResults are handled differently by the assistant stream.
// For now, let's assume it's mostly for content and role.

function transformDBMessagesToSDKMessages(dbMessages: DBMessage[], incomingUserMessage: UIMessage): SDKMessage[] {
  const sdkMessages: SDKMessage[] = dbMessages.map(dbMsg => {
    // Simplified transformation: focus on role and content.
    // Tool calls and results are typically handled by the assistant run steps internally.
    let content = '';
    if (Array.isArray(dbMsg.parts)) {
      content = dbMsg.parts
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n');
    } else if (typeof dbMsg.parts === 'string') {
      content = dbMsg.parts;
    }

    return {
      id: dbMsg.id,
      role: dbMsg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: content,
      createdAt: dbMsg.createdAt,
      // The experimental_streamAssistant expects a simpler Message structure for history
    };
  });

  // Add the current user message
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


// ... (rest of the imports and helper functions like getStreamContext)

export async function POST(request: Request) {
  // ... (request body parsing, auth, rate limiting, chat retrieval/creation as before)
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
        parts: incomingMessage.parts as any[],
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
      // Use the specific OpenAI client from your provider for experimental_streamAssistant
      // myProvider.assistantModel() returns the Assistant instance, not the main OpenAI client.
      // myProvider.languageModel() returns a LanguageModel, which is the OpenAI client.
      const openAIClient = myProvider.languageModel(selectedChatModel); // This should give the OpenAI client

      const result = openAIClient.experimental_streamAssistant({
        assistantId: process.env.OPENAI_ASSISTANT_ID!,
        system: systemPrompt({ selectedChatModel, requestHints }),
        messages: messagesForSDK, // Ensure this matches the expected Message[] structure
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

// GET and DELETE handlers (assuming they are correct from previous versions)
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
