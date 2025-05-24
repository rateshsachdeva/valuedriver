import { openai } from '@ai-sdk/openai';

export const myProvider = {
  assistantModel() {
    return openai.assistant({
      assistantId: process.env.OPENAI_ASSISTANT_ID!,
    });
  },
};
