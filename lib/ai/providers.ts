import { openai } from '@ai-sdk/openai';

export const myProvider = {
  assistantModel() {
    return openai.assistant(process.env.OPENAI_ASSISTANT_ID!);
  },
};
