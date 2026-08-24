import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

const step = createStep({
  id: 'wait-step',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  suspendSchema: z.object({ value: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return suspend({ value: inputData.value });
    return { value: `${inputData.value}:${resumeData.approved ? 'approved' : 'declined'}` };
  },
});
const workflow = createWorkflow({
  id: 'process-workflow',
  inputSchema: z.object({ value: z.string() }),
  outputSchema: z.object({ value: z.string() }),
})
  .then(step)
  .commit();
const database = resolve(`workflow-process-${process.version.replaceAll('.', '_')}.db`);
const storage = new LibSQLStore({ id: 'workflow-process-stage-2', url: `file:${database}` });
await storage.init();
new Mastra({ storage, workflows: { processWorkflow: workflow }, workers: false });
const snapshot = await workflow.getWorkflowRunById('workflow-process-run');
assert.equal(snapshot?.status, 'suspended');
const run = await workflow.createRun({ runId: 'workflow-process-run' });
const output = await run.resume({ step: 'wait-step', resumeData: { approved: true } });
assert.equal(output.status, 'success');
assert.deepEqual(output.result, { value: 'payload:approved' });
await storage.close();
console.log(JSON.stringify({ stage: 2, node: process.version, snapshot: snapshot?.status, status: output.status, result: output.result }));
