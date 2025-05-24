import { openai } from '@ai-sdk/openai';

export const myProvider = {
  languageModel(modelId: string) {
    return openai(modelId, {
      apiKey: process.env.OPENAI_API_KEY!,
    });
  },
};
