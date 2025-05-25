import { openai } from '@ai-sdk/openai';

export const myProvider = {
  /**
   * GPT-4o Assistant — uses the OpenAI Assistant ID stored in env
   */
  assistantModel() {
    const assistantId = process.env.OPENAI_ASSISTANT_ID;

    if (!assistantId) {
      throw new Error('Missing OPENAI_ASSISTANT_ID in environment variables.');
    }

    // helper kept for runtime compat; cast to suppress missing type
    return (openai as any).assistant(assistantId);
  },

  /**
   * Optional: fallback to standard chat model (e.g., for non-Assistant flows)
   */
  languageModel(modelId: string = 'gpt-4o') {
    return openai(modelId);
  },
};
