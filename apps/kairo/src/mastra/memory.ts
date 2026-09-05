import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';

export function createConversationMemory(
  storage: MastraCompositeStore,
  model: MastraModelConfig
): Memory {
  return new Memory({
    storage,
    options: {
      readOnly: true,
      generateTitle: false,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: {
        scope: 'thread',
        observation: { model, bufferTokens: false },
        reflection: { model },
      },
    },
  });
}
