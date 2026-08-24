import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';

const database = resolve(`approval-process-${process.version.replaceAll('.', '_')}.db`);
const storage = new LibSQLStore({ id: 'approval-process-stage-2', url: `file:${database}` });
await storage.init();
const agent = new Agent({
  id: 'approval-process-agent',
  name: 'approval-process-agent',
  instructions: '只读取 suspended run',
  model: 'openai/gpt-4o-mini',
});
new Mastra({ storage, agents: { approvalProcessAgent: agent }, workers: false });
const suspended = await agent.listSuspendedRuns();
assert.equal(suspended.runs[0]?.runId, 'approval-process-run');
assert.equal(suspended.runs[0]?.toolCalls[0]?.toolCallId, 'approval-process-call');
await storage.close();
console.log(
  JSON.stringify({
    stage: 2,
    node: process.version,
    runs: suspended.runs.length,
    runId: suspended.runs[0]?.runId,
    toolCallId: suspended.runs[0]?.toolCalls[0]?.toolCallId,
  })
);
