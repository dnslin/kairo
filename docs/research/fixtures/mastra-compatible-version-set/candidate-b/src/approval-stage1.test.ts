import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { test } from 'vitest';
import { z } from 'zod';

function result(
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  >,
  finishReason: 'stop' | 'tool-calls'
) {
  return {
    content,
    finishReason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  };
}

test('第一进程持久化 suspended Approval', async () => {
  const database = resolve(`approval-process-${process.version.replaceAll('.', '_')}.db`);
  await rm(database, { force: true });
  const storage = new LibSQLStore({ id: 'approval-process-stage-1', url: `file:${database}` });
  await storage.init();
  const tool = createTool({
    id: 'danger',
    description: '需要审批的跨进程实验工具',
    requireApproval: true,
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }) => ({ value }),
  });
  const model = new MastraLanguageModelV2Mock({
    doGenerate: [
      result([{ type: 'text', text: '数组索引零占位' }], 'stop'),
      result(
        [{ type: 'tool-call', toolCallId: 'approval-process-call', toolName: 'danger', input: '{"value":"执行"}' }],
        'tool-calls'
      ),
    ],
  });
  const agent = new Agent({
    id: 'approval-process-agent',
    name: 'approval-process-agent',
    instructions: '调用 danger 工具',
    model,
    tools: { danger: tool },
  });
  new Mastra({ storage, agents: { approvalProcessAgent: agent }, workers: false });
  const output = await agent.generate('执行危险操作', {
    runId: 'approval-process-run',
    requireToolApproval: true,
  });
  assert.equal(output.finishReason, 'suspended');
  await storage.close();
  console.log(JSON.stringify({ stage: 1, node: process.version, finishReason: output.finishReason }));
});
