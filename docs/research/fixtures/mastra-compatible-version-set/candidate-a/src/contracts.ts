import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/di';
import { Mastra } from '@mastra/core/mastra';
import type { ObservabilityExporter } from '@mastra/core/observability';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createMockModel, MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { LibSQLStore } from '@mastra/libsql';
import { MCPClient } from '@mastra/mcp';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { z } from 'zod';

type ContractStatus = '通过' | '失败' | '受限';
type ContractResult = { name: string; status: ContractStatus; details: unknown };
const results: ContractResult[] = [];

async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const details = await fn();
    results.push({ name, status: '通过', details });
  } catch (error) {
    results.push({
      name,
      status: '失败',
      details: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
  }
}

function textModel(text: string, onGenerate?: () => void) {
  return createMockModel({
    version: 'v2',
    mockText: text,
    spyGenerate: onGenerate,
  });
}

function modelResult(
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

function approvalModel(toolCallId: string, resumeOnly = false) {
  const dummy = modelResult([{ type: 'text', text: '数组索引零占位' }], 'stop');
  const toolCall = modelResult(
    [{ type: 'tool-call', toolCallId, toolName: 'danger', input: JSON.stringify({ value: '执行' }) }],
    'tool-calls'
  );
  const completed = modelResult([{ type: 'text', text: '审批处理完成' }], 'stop');
  return new MastraLanguageModelV2Mock({
    doGenerate: resumeOnly ? [dummy, completed] : [dummy, toolCall, completed],
  });
}

function workflowDefinition() {
  const step = createStep({
    id: 'wait-step',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    suspendSchema: z.object({ value: z.string() }),
    resumeSchema: z.object({ approved: z.boolean() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) {
        return suspend({ value: inputData.value });
      }
      return { value: `${inputData.value}:${resumeData.approved ? 'approved' : 'declined'}` };
    },
  });
  return createWorkflow({
    id: 'snapshot-workflow',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
  })
    .then(step)
    .commit();
}

await check('动态 model fallback 与每模型 retries', async () => {
  let dynamicCalls = 0;
  let firstCalls = 0;
  let secondCalls = 0;
  const first = textModel('不应返回', () => {
    firstCalls += 1;
    throw new Error('首模型故意失败');
  });
  const second = textModel('fallback-ok', () => {
    secondCalls += 1;
  });
  const agent = new Agent({
    id: 'fallback-agent',
    name: 'fallback-agent',
    instructions: '只返回模型输出',
    model: ({ requestContext }) => {
      dynamicCalls += 1;
      assert.equal(requestContext.get('tier'), 'probe');
      return [
        { model: first, maxRetries: 1 },
        { model: second, maxRetries: 0 },
      ];
    },
  });
  const requestContext = new RequestContext<{ tier: string }>([['tier', 'probe']]);
  const output = await agent.generate('测试 fallback', { requestContext });
  assert.equal(output.text, 'fallback-ok');
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 1);
  assert.ok(dynamicCalls >= 1);
  return { dynamicCalls, firstCalls, secondCalls, text: output.text };
});

const suffix = process.version.replaceAll('.', '_');
const memoryDb = resolve(`memory-${suffix}.db`);
await rm(memoryDb, { force: true });

await check('Storage init/close 与 Memory 稳定 ID/readOnly', async () => {
  const storage = new LibSQLStore({ id: 'memory-storage', url: `file:${memoryDb}` });
  await storage.init();
  const memory = new Memory({ storage, options: { lastMessages: 20 } });
  const threadId = 'thread-stable';
  const resourceId = 'resource-stable';
  const now = new Date();
  await memory.saveThread({
    thread: { id: threadId, resourceId, title: '稳定 ID', metadata: {}, createdAt: now, updatedAt: now },
  });
  const stableMessage = {
    id: 'stable-user-1',
    threadId,
    resourceId,
    role: 'user' as const,
    content: { format: 2 as const, parts: [{ type: 'text' as const, text: '已提交用户消息' }] },
    createdAt: now,
  };
  const serial = await Promise.allSettled([
    memory.saveMessages({ messages: [stableMessage] }),
    memory.saveMessages({ messages: [stableMessage] }),
  ]);
  const concurrent = await Promise.allSettled(
    Array.from({ length: 4 }, () => memory.saveMessages({ messages: [stableMessage] }))
  );
  const before = await memory.recall({ threadId, resourceId, perPage: false });
  const beforeCount = before.messages.filter(message => message.id === stableMessage.id).length;
  assert.equal(beforeCount, 1);

  const readOnlyMemory = new Memory({ storage, options: { lastMessages: 20, readOnly: true } });
  const agent = new Agent({
    id: 'readonly-agent',
    name: 'readonly-agent',
    instructions: '只返回模型输出',
    model: textModel('不会写入'),
    memory: readOnlyMemory,
  });
  await agent.generate('本轮输入不得保存', {
    memory: { thread: threadId, resource: resourceId, options: { readOnly: true } },
  });
  await readOnlyMemory.settled();
  const after = await memory.recall({ threadId, resourceId, perPage: false });
  assert.deepEqual(
    after.messages.map(message => message.id),
    before.messages.map(message => message.id)
  );
  await memory.settled();
  await storage.close();
  return {
    beforeCount,
    afterCount: after.messages.length,
    serial: serial.map(item => item.status),
    concurrent: concurrent.map(item => item.status),
  };
});

const workflowDb = resolve(`workflow-${suffix}.db`);
await rm(workflowDb, { force: true });
await check('Workflow snapshot 跨重启 suspend/resume', async () => {
  const storage1 = new LibSQLStore({ id: 'workflow-storage-1', url: `file:${workflowDb}` });
  await storage1.init();
  const workflow1 = workflowDefinition();
  new Mastra({ storage: storage1, workflows: { snapshotWorkflow: workflow1 }, workers: false });
  const runId = 'workflow-run-stable';
  const run1 = await workflow1.createRun({ runId });
  const suspended = await run1.start({ inputData: { value: 'payload' } });
  assert.equal(suspended.status, 'suspended');
  const snapshot = await workflow1.getWorkflowRunById(runId);
  assert.equal(snapshot?.status, 'suspended');
  await storage1.close();

  const storage2 = new LibSQLStore({ id: 'workflow-storage-2', url: `file:${workflowDb}` });
  await storage2.init();
  const workflow2 = workflowDefinition();
  new Mastra({ storage: storage2, workflows: { snapshotWorkflow: workflow2 }, workers: false });
  const run2 = await workflow2.createRun({ runId });
  const resumed = await run2.resume({ step: 'wait-step', resumeData: { approved: true } });
  assert.equal(resumed.status, 'success');
  assert.deepEqual(resumed.result, { value: 'payload:approved' });
  await storage2.close();
  return { suspended: suspended.status, snapshot: snapshot?.status, resumed: resumed.status, result: resumed.result };
});

const scheduleDb = resolve(`schedule-${suffix}.db`);
await rm(scheduleDb, { force: true });
await check('Schedule 持久化与重启读取', async () => {
  const storage1 = new LibSQLStore({ id: 'schedule-storage-1', url: `file:${scheduleDb}` });
  await storage1.init();
  const workflow1 = workflowDefinition();
  const mastra1 = new Mastra({ storage: storage1, workflows: { snapshotWorkflow: workflow1 }, workers: false });
  const created = await mastra1.schedules.create({
    id: 'restart-schedule',
    workflowId: workflow1.id,
    cron: '0 3 * * *',
    inputData: { value: 'scheduled' },
  });
  await storage1.close();

  const storage2 = new LibSQLStore({ id: 'schedule-storage-2', url: `file:${scheduleDb}` });
  await storage2.init();
  const workflow2 = workflowDefinition();
  const mastra2 = new Mastra({ storage: storage2, workflows: { snapshotWorkflow: workflow2 }, workers: false });
  const restored = await mastra2.schedules.get(created.id);
  assert.equal(restored?.id, created.id);
  const competition = await Promise.allSettled([
    mastra2.schedules.run(created.id),
    mastra2.schedules.run(created.id),
  ]);
  await storage2.close();
  results.push({
    name: 'Schedule 同一触发竞争唯一性',
    status: '失败',
    details: {
      reason: '公开手动 run 可产生两个独立 claim，未证明同一 due fire 的跨实例唯一消费与崩溃恢复',
      settlements: competition.map(item => item.status),
    },
  });
  return { id: restored?.id, cron: restored?.cron, competition: competition.map(item => item.status) };
});

await check('Observability flush/shutdown', async () => {
  let flushCount = 0;
  let shutdownCount = 0;
  const exporter: ObservabilityExporter = {
    name: 'contract-exporter',
    async exportTracingEvent() {},
    async flush() {
      flushCount += 1;
    },
    async shutdown() {
      shutdownCount += 1;
    },
  };
  const observability = new Observability({
    configs: {
      probe: { serviceName: 'kkbot-131', exporters: [exporter] },
    },
    sensitiveDataFilter: false,
  });
  await observability.flush();
  await observability.shutdown();
  assert.ok(flushCount >= 1);
  assert.ok(shutdownCount >= 1);
  return { flushCount, shutdownCount };
});

await check('Input/Output Processors 执行', async () => {
  const events: string[] = [];
  const inputProcessor: InputProcessor = {
    id: 'input-probe',
    processInput: ({ messageList }) => {
      events.push('input');
      return messageList;
    },
  };
  const outputProcessor: OutputProcessor = {
    id: 'output-probe',
    processOutputResult: ({ messageList }) => {
      events.push('output');
      return messageList;
    },
  };
  const agent = new Agent({
    id: 'processor-agent',
    name: 'processor-agent',
    instructions: '只返回模型输出',
    model: textModel('processor-ok'),
    inputProcessors: [inputProcessor],
    outputProcessors: [outputProcessor],
  });
  const output = await agent.generate('执行处理器');
  assert.equal(output.text, 'processor-ok');
  assert.deepEqual(events, ['input', 'output']);
  return { events, text: output.text };
});

await check('MCP 本地 stdio discovery/disconnect', async () => {
  const serverPath = resolve('dist/mcp-server.js');
  const config = {
    servers: {
      local: { command: process.execPath, args: [serverPath] },
    },
    timeout: 10_000,
  };
  const client1 = new MCPClient(config);
  const tools1 = await client1.listTools();
  assert.ok(tools1.local_echo);
  await client1.disconnect();
  const client2 = new MCPClient(config);
  const tools2 = await client2.listTools();
  assert.ok(tools2.local_echo);
  await client2.disconnect();
  return { first: Object.keys(tools1), second: Object.keys(tools2) };
});

const approvalDb = resolve(`approval-${suffix}.db`);
await rm(approvalDb, { force: true });
await check('Tool Approval suspended discovery 跨重启', async () => {
  let toolExecutions = 0;
  const danger = createTool({
    id: 'danger',
    description: '需要审批的危险操作',
    requireApproval: true,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async ({ value }) => {
      toolExecutions += 1;
      return { value };
    },
  });
  const storage1 = new LibSQLStore({ id: 'approval-storage-1', url: `file:${approvalDb}` });
  await storage1.init();
  const agent1 = new Agent({
    id: 'approval-agent',
    name: 'approval-agent',
    instructions: '调用 danger 工具',
    model: approvalModel('approval-call-1'),
    tools: { danger },
  });
  new Mastra({ storage: storage1, agents: { approvalAgent: agent1 }, workers: false });
  const runId = 'approval-run-1';
  const generated = await agent1.generate('执行危险操作', {
    runId,
    maxSteps: 3,
    requireToolApproval: true,
  });
  assert.equal(generated.finishReason, 'suspended');
  const before = await agent1.listSuspendedRuns();
  assert.equal(before.runs[0]?.runId, runId);
  assert.equal(before.runs[0]?.toolCalls[0]?.toolCallId, 'approval-call-1');
  await storage1.close();

  const storage2 = new LibSQLStore({ id: 'approval-storage-2', url: `file:${approvalDb}` });
  await storage2.init();
  const agent2 = new Agent({
    id: 'approval-agent',
    name: 'approval-agent',
    instructions: '调用 danger 工具',
    model: approvalModel('approval-call-1', true),
    tools: { danger },
  });
  new Mastra({ storage: storage2, agents: { approvalAgent: agent2 }, workers: false });
  const after = await agent2.listSuspendedRuns();
  assert.equal(after.runs[0]?.runId, runId);

  const prototypeNames = Object.getOwnPropertyNames(Object.getPrototypeOf(agent2));
  const authorityMethods = prototypeNames.filter(name => /approval.*(state|status)|get.*approval/i.test(name));
  results.push({
    name: 'Tool Approval runId+toolCallId 权威终态读取',
    status: '失败',
    details: { reason: '公开 Agent API 只有 suspended 列表与决议调用，没有权威 Approval 终态查询', authorityMethods },
  });
  results.push({
    name: 'Tool Approval 带前置条件的批准/拒绝',
    status: '失败',
    details: { reason: 'approveToolCall/declineToolCall 公开签名没有 expected state、version 或幂等键' },
  });

  const race = await Promise.allSettled([
    agent2.approveToolCallGenerate({ runId, toolCallId: 'approval-call-1' }),
    agent2.declineToolCallGenerate({ runId, toolCallId: 'approval-call-1', reason: '竞态拒绝' }),
  ]);
  results.push({
    name: 'Tool Approval 重复/相反决议与 deadline 竞态',
    status: '失败',
    details: {
      reason: '即使本次工具执行次数不超过一次，也没有公开权威终态查询、条件决议或 deadline 原语，无法证明合同',
      settlements: race.map(item => item.status),
      toolExecutions,
    },
  });
  await storage2.close();
  return {
    beforeRuns: before.runs.length,
    afterRuns: after.runs.length,
    toolCallId: after.runs[0]?.toolCalls[0]?.toolCallId,
  };
});

console.log(JSON.stringify({ node: process.version, results }, null, 2));
