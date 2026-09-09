import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { ModelRouterLanguageModel, type MastraModelConfig } from '@mastra/core/llm';
import { loadBotConfig } from '../../src/config/load.js';
import { loadBotCustomization } from '../../src/modules/bot-customization/instructions.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import { PostgresRuntimeBootStore } from '../../src/modules/operability/runtime-boot-store.js';
import {
  PostgresKnowledgeRecordStore,
  type KnowledgeQuery,
  type KnowledgeEvidence,
} from '../../src/modules/knowledge-qa/knowledge-record-store.js';
import { createLogger, MastraOperabilityLogger } from '../../src/modules/operability/logger.js';
import {
  createKnowledgeTool,
  knowledgeTools,
} from '../../src/modules/tool-integration/knowledge-tool.js';
import type { RetrievalSettings } from '../../src/modules/tool-integration/knowledge-contract.js';
import type { TaskTestDatabase } from './task-database.js';

export interface KnowledgeProbeResult {
  queries: KnowledgeQuery[];
  evidence: KnowledgeEvidence[];
  logs: string;
  modelInputs: string[];
  toolNames: string[];
  text: string;
}

/** 默认固定模型路由验证链路；realModel 显式使用已批准模型，不作为正式 Agent 装配。 */
export async function runKnowledgeProbe(
  database: TaskTestDatabase,
  settings: RetrievalSettings,
  queries: string[],
  options: {
    signal?: AbortSignal;
    executionMs?: number;
    toolInputs?: Record<string, unknown>[];
    realModel?: boolean;
  } = {}
): Promise<KnowledgeProbeResult> {
  const { config, configDigest } = await loadBotConfig(undefined, Object.keys(knowledgeTools));
  const customization = await loadBotCustomization(config);
  const now = Date.now();
  const chat = new PostgresPrivateChatStore(database.poolA);
  const tasks = new PostgresTaskStore(database.poolA);
  const boots = new PostgresRuntimeBootStore(database.poolA);
  const store = new PostgresKnowledgeRecordStore(database.poolA);
  const employeeId = randomUUID();
  const scope = { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
  const message = { sessionId: scope.sessionId, messageId: randomUUID() };
  await chat.insertRawMessage({
    ...message,
    direction: 'inbound',
    observedAt: now,
    text: '验证上下文历史，不得发送给RAGFlow',
    messageType: 'text',
    attachments: {},
  });
  await chat.associateEmployee(message, employeeId);
  const context = await chat.createContext(scope, now);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage: message,
    quietDeadline: now,
    maxDeadline: now + 1000,
  });
  await chat.setBatchStatus(batch.batchId, 'ready');
  const taskId = randomUUID();
  await tasks.createTask({
    taskId,
    batchId: batch.batchId,
    configDigest,
    now,
    queueDeadline: now + 600000,
  });
  assert.equal(
    await tasks.claimTask({
      taskId,
      inputVersion: 1,
      now,
      executionMs: options.executionMs ?? config.timeouts.executionMs,
    }),
    true
  );
  const attemptId = randomUUID();
  await tasks.startAttempt({
    taskId,
    attemptId,
    runId: randomUUID(),
    inputVersion: 1,
    now,
    expectedAttemptId: null,
    configDigest,
  });
  const task = await tasks.getTask(taskId);
  assert.ok(task?.executionDeadline);
  const bootId = randomUUID();
  // 独立测试 boot 使用可辨识的合成版本，不冒充正式部署 commit。
  await boots.startBoot({ bootId, gitCommit: '0'.repeat(40), configDigest, startedAt: now });
  let logs = '';
  const logger = createLogger({
    write(text: string): void {
      logs += text;
    },
  });
  let callIndex = 0;
  const binding = createKnowledgeTool(
    settings,
    {
      taskId,
      attemptId,
      bootId,
      executionDeadline: task.executionDeadline,
      nextCallIndex: () => ++callIndex,
    },
    store,
    logger
  );
  let step = 0;
  const modelInputs: string[] = [];
  const toolNames = new Set<string>();
  const model: MastraModelConfig = {
    specificationVersion: 'v2',
    provider: 'kairo-verification',
    modelId: 't27-fixed-routing',
    supportedUrls: {},
    doGenerate(options) {
      const input = JSON.stringify(options.prompt);
      assert.ok(!input.includes(settings.apiKey), '凭证不得进入模型上下文');
      modelInputs.push(input);
      for (const tool of options.tools ?? []) toolNames.add(tool.name);
      if (step > 0)
        assert.ok(input.includes('ERP 知识检索'), '必须实际读取定制 Skill 后才调用检索');
      const turn = step++;
      const hasCall = turn <= queries.length;
      const toolName = turn === 0 ? 'skill' : 'knowledge-search';
      const toolInput = turn === 0 ? { name: 'erp-search' } : optionsForTurn(turn);
      return Promise.resolve({
        content: hasCall
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: `验证-${turn}`,
                toolName,
                input: JSON.stringify(toolInput),
              },
            ]
          : [{ type: 'text' as const, text: '独立知识链路验证完成。' }],
        finishReason: hasCall ? ('tool-calls' as const) : ('stop' as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      });
    },
    doStream() {
      throw new Error('独立验证只使用非流式模型选工具');
    },
  };
  function optionsForTurn(turn: number): Record<string, unknown> {
    return options.toolInputs?.[turn - 1] ?? { query: queries[turn - 1] };
  }
  let selectedModel: MastraModelConfig = model;
  if (options.realModel) {
    const apiKey = process.env.KAIRO_T12_MODEL_API_KEY;
    assert.ok(apiKey, '真实模型验收缺少 KAIRO_T12_MODEL_API_KEY');
    const approved = new ModelRouterLanguageModel({
      id: config.model.id as `${string}/${string}`,
      url: config.model.url,
      apiKey,
    });
    const generate = approved.doGenerate.bind(approved);
    approved.doGenerate = async input => {
      const serialized = JSON.stringify(input.prompt);
      assert.ok(
        !serialized.includes(settings.apiKey) && !serialized.includes(apiKey),
        '凭证不得进入模型上下文'
      );
      modelInputs.push(serialized);
      for (const tool of input.tools ?? []) toolNames.add(tool.name);
      return generate(input);
    };
    selectedModel = approved;
  }
  const agent = new Agent({
    id: randomUUID(),
    name: 'T27 独立链路验证',
    model: selectedModel,
    ...customization,
    tools: { 'knowledge-search': binding.tool },
  });
  const mastra = new Mastra({ agents: { probe: agent } });
  mastra.setLogger({ logger: new MastraOperabilityLogger(logger) });
  let text = '';
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => {
      deadlineController.abort(new DOMException('任务执行截止', 'TimeoutError'));
    },
    Math.max(0, task.executionDeadline - Date.now())
  );
  const taskSignal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  try {
    try {
      const response = await agent.generate(
        options.realModel
          ? queries.join('\n')
          : '先读取 ERP 检索 Skill，再执行本轮验证问题。历史身份只留在 Kairo。',
        {
          maxSteps: options.realModel ? config.agent.maxSteps : queries.length + 2,
          abortSignal: taskSignal,
        }
      );
      text = response.text;
    } catch (error) {
      if (!taskSignal.aborted) throw error;
    }
    await binding.settled();
    const recorded = await store.listQueries(taskId, { limit: 100, offset: 0 });
    const evidence = await store.listEvidence(taskId, { limit: 100, offset: 0 });
    assert.ok(!logs.includes(settings.apiKey), '普通日志不得含凭证');
    for (const query of queries) assert.ok(!logs.includes(query), '普通日志不得含query正文');
    for (const item of evidence) {
      assert.ok(!logs.includes(item.content), '普通日志不得含片段正文');
      assert.equal(item.pageNumbers, null, '未知文档物理页码不能猜测');
    }
    for (const [index, query] of recorded.entries()) assert.equal(query.callIndex, index + 1);
    assert.deepEqual([...toolNames].sort(), [
      'knowledge-search',
      'skill',
      'skill_read',
      'skill_search',
    ]);
    return { queries: recorded, evidence, logs, modelInputs, toolNames: [...toolNames], text };
  } finally {
    clearTimeout(deadlineTimer);
    try {
      await binding.settled();
    } finally {
      try {
        await mastra.shutdown();
      } finally {
        await boots.closeBoot(bootId, { status: 'closed', closedAt: Date.now() });
      }
    }
  }
}
