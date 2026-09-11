import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKairoMastra, type KairoMastra } from '../../src/mastra/index.js';
import { runAgent, type AgentRunDependencies } from '../../src/modules/agent-runtime/run-agent.js';
import type { AgentAnswer } from '../../src/modules/knowledge-qa/answer-schema.js';
import type { KnowledgeQuery } from '../../src/modules/knowledge-qa/knowledge-record-store.js';
import { AppError, getErrorType } from '../../src/modules/operability/errors.js';
import type { RetrievalAttempt } from '../../src/modules/tool-integration/knowledge-contract.js';
import { createAgentTask, type AgentTaskFixture } from '../helpers/agent-runtime.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

type ModelInput = Parameters<ModelRouterLanguageModel['doGenerate']>[0];
type ModelResult = Awaited<ReturnType<ModelRouterLanguageModel['doGenerate']>>;
type ModelChunk = ModelResult['stream'] extends ReadableStream<infer Chunk> ? Chunk : never;
type Fixture = AgentTaskFixture;
type Runtime = KairoMastra;
type ModelTurn = (input: ModelInput) => ModelResult | Promise<ModelResult>;
interface HttpRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: { question: string; dataset_ids: string[] };
  receivedAt: number;
}

const modelKey = 't28-controlled-model-key';
const retrievalKey = 't28-controlled-retrieval-key';
const page = { limit: 100, offset: 0 };
let database: TaskTestDatabase;
const runtimes: Runtime[] = [];
const servers: Server[] = [];
const modelInputs: string[] = [];
const advertisedTools = new Set<string>();
const executions = new Set<{ controller: AbortController; promise: Promise<AgentAnswer> }>();

function runTestAgent(
  agent: KairoMastra['agent'],
  input: Fixture['input'],
  dependencies: AgentRunDependencies
): Promise<AgentAnswer> {
  const controller = new AbortController();
  const promise = runAgent(
    agent,
    {
      ...input,
      signal: AbortSignal.any([input.signal, controller.signal]),
    },
    dependencies
  );
  const execution = { controller, promise };
  executions.add(execution);
  void promise.then(
    () => {
      executions.delete(execution);
    },
    () => {
      executions.delete(execution);
    }
  );
  return promise;
}

async function cancelAgentRuns(): Promise<void> {
  const pending = [...executions];
  for (const execution of pending) {
    execution.controller.abort(new DOMException('测试收尾取消', 'AbortError'));
  }
  const results = await Promise.allSettled(pending.map(execution => execution.promise));
  const failures: unknown[] = [];
  for (const result of results) {
    if (
      result.status === 'rejected' &&
      !['cancelled', 'timeout'].includes(getErrorType(result.reason))
    ) {
      failures.push(result.reason);
    }
  }
  if (failures.length) throw new AggregateError(failures, '测试执行回收失败');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function stream(chunks: ModelChunk[], toolCalls = false): ModelResult {
  return {
    stream: new ReadableStream<ModelChunk>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.enqueue({
          type: 'finish',
          finishReason: toolCalls ? 'tool-calls' : 'stop',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        });
        controller.close();
      },
    }),
  };
}

function tool(name: string, input: Record<string, unknown>): ModelResult {
  return stream(
    [{ type: 'tool-call', toolCallId: randomUUID(), toolName: name, input: JSON.stringify(input) }],
    true
  );
}

function json(value: unknown): ModelResult {
  return stream([
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: JSON.stringify(value) },
    { type: 'text-end', id: 'answer' },
  ]);
}

function answer(
  answerType: AgentAnswer['answerType'],
  text: string,
  evidenceIds: string[] = []
): AgentAnswer {
  return { answer: text, answerType, evidenceIds, subQuestions: [], diagnostics: [] };
}

/** 仅替换已批准模型的网络边界，不替换正式 Agent、Skill、Tool、Python 或 PostgreSQL。 */
function controlledModel(routes: Array<{ question: string; turns: ModelTurn[] }>) {
  const positions = new Map<string, number>();
  return vi
    .spyOn(ModelRouterLanguageModel.prototype, 'doGenerate')
    .mockImplementation(async input => {
      const prompt = JSON.stringify(input.prompt);
      modelInputs.push(prompt);
      expect(prompt).not.toContain(modelKey);
      expect(prompt).not.toContain(retrievalKey);
      for (const registered of input.tools ?? []) advertisedTools.add(registered.name);
      const matches = routes.filter(route => prompt.includes(route.question));
      assert.equal(matches.length, 1, '受控模型必须按当前员工正文唯一匹配，不得串入其他任务');
      const route = matches[0]!;
      const position = positions.get(route.question) ?? 0;
      const next = route.turns[position];
      assert.ok(next, '正式 Agent 发起了受控脚本之外的模型调用');
      positions.set(route.question, position + 1);
      return next(input);
    });
}

async function localRetrieval(
  handler: (request: HttpRequest, response: ServerResponse) => void | Promise<void>
) {
  const requests: HttpRequest[] = [];
  const failures: unknown[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => {
      body += part;
    });
    request.on('end', () => {
      try {
        const received: HttpRequest = {
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(body) as HttpRequest['body'],
          receivedAt: Date.now(),
        };
        requests.push(received);
        void Promise.resolve(handler(received, response)).catch(error => {
          failures.push(error);
          response.destroy();
        });
      } catch (error) {
        failures.push(error);
        response.destroy();
      }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  vi.stubEnv('RAGFLOW_API_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return { requests, failures };
}

function found(response: ServerResponse, datasetId: string, content: string) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      code: 0,
      data: {
        total: 1,
        chunks: [
          {
            id: randomUUID(),
            content,
            document_id: 't28-document',
            document_keyword: '受控采购手册',
            dataset_id: datasetId,
            positions: [[2, 10, 20, 30, 40]],
            similarity: 0.9,
          },
        ],
      },
    })
  );
}

function assemble(fixture: Fixture): KairoMastra {
  const runtime = createKairoMastra({
    config: fixture.dependencies.config,
    customization: fixture.customization,
    databaseUrl: database.databaseUrl,
    logger: fixture.dependencies.logger,
  });
  runtimes.push(runtime);
  return runtime;
}

async function queries(fixture: Fixture) {
  return fixture.dependencies.knowledge.listQueries(fixture.input.task.taskId, page);
}

async function evidenceAnswer(fixture: Fixture, content: string): Promise<ModelResult> {
  const evidence = await fixture.dependencies.knowledge.listEvidence(
    fixture.input.task.taskId,
    page
  );
  assert.ok(
    evidence.some(item => item.content === content),
    '返回答案前必须真实落证据账本'
  );
  return json(
    answer(
      'enterprise',
      content,
      evidence.map(item => item.evidenceId)
    )
  );
}

function attempts(query: KnowledgeQuery): RetrievalAttempt[] {
  assert.ok(
    query.rawResult && typeof query.rawResult === 'object' && !Array.isArray(query.rawResult)
  );
  assert.ok(Array.isArray(query.rawResult.attempts));
  return query.rawResult.attempts as unknown as RetrievalAttempt[];
}

function exited(attempt: RetrievalAttempt) {
  assert.ok(attempt.pid && attempt.pid > 0, '真实 Python 必须记录有效 PID');
  expect(() => process.kill(attempt.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

async function expectSystemFailure(promise: Promise<unknown>, types: string[]) {
  const result = await promise.then(
    value => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  );
  expect(result.value).toBeUndefined();
  expect(result.error).toBeInstanceOf(Error);
  if (!types.includes('cancelled') && !types.includes('timeout')) {
    expect(result.error).toBeInstanceOf(AppError);
  }
  expect(types).toContain(getErrorType(result.error));
  return result.error;
}

beforeAll(async () => {
  database = await createTaskTestDatabase();
}, 30_000);

beforeEach(() => {
  modelInputs.length = 0;
  advertisedTools.clear();
  vi.stubEnv('KAIRO_T12_MODEL_API_KEY', modelKey);
  vi.stubEnv('RAGFLOW_API_KEY', retrievalKey);
  // 缺少显式本地服务的用例也不能意外访问正式知识库。
  vi.stubEnv('RAGFLOW_API_URL', 'http://127.0.0.1:1');
  vi.spyOn(ModelRouterLanguageModel.prototype, 'doStream').mockImplementation(() => {
    throw new Error('只读 Agent 不得另启 OM 或额外结构化模型流');
  });
});

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    await cancelAgentRuns();
  } catch (error) {
    failures.push(error);
  }
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const server of servers.splice(0)) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      failures.push(error);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (failures.length) throw new AggregateError(failures, '测试资源回收失败');
});

afterAll(async () => {
  await database?.close();
});

describe('T28 唯一 Agent 受控集成（模型决策为脚本，不是真实检索决策放行）', () => {
  it('企业问题经原生 ERP Skill、正式 Tool 和真实 Python 检索，返回可追溯证据', async () => {
    const question = '受控企业问题：采购订单应如何提交审核？';
    const material = '在采购订单页面确认供应商后，点击提交审核。';
    const fixture = await createAgentTask(database, question);
    const http = await localRetrieval((_request, response) => {
      found(response, fixture.dependencies.config.datasetId, material);
    });
    const runtime = assemble(fixture);
    const model = controlledModel([
      {
        question,
        turns: [
          () => tool('skill', { name: 'erp-search' }),
          input => {
            expect(JSON.stringify(input.prompt)).toContain('ERP 知识检索');
            return tool('knowledge-search', { query: '采购订单提交审核' });
          },
          input => {
            expect(JSON.stringify(input.prompt)).toContain(material);
            return evidenceAnswer(fixture, material);
          },
        ],
      },
    ]);
    const result = await runTestAgent(runtime.agent, fixture.input, fixture.dependencies);
    const recorded = await queries(fixture);
    const evidence = await fixture.dependencies.knowledge.listEvidence(
      fixture.input.task.taskId,
      page
    );
    expect(result).toEqual(
      answer(
        'enterprise',
        material,
        evidence.map(item => item.evidenceId)
      )
    );
    expect(http.requests.map(({ receivedAt: _receivedAt, ...request }) => request)).toEqual([
      {
        method: 'POST',
        url: '/api/v1/retrieval',
        authorization: `Bearer ${retrievalKey}`,
        body: {
          question: '采购订单提交审核',
          dataset_ids: [fixture.dependencies.config.datasetId],
        },
      },
    ]);
    expect(http.failures).toEqual([]);
    expect(recorded.map(item => [item.callIndex, item.resultCategory, item.attemptId])).toEqual([
      [1, 'found', fixture.input.attempt.attemptId],
    ]);
    expect(evidence.map(item => [item.content, item.pageNumbers])).toEqual([[material, null]]);
    exited(attempts(recorded[0]!)[0]!);
    expect([...advertisedTools].sort()).toEqual([
      'knowledge-search',
      'skill',
      'skill_read',
      'skill_search',
    ]);
    expect(model).toHaveBeenCalledTimes(3);
    expect(ModelRouterLanguageModel.prototype.doStream).not.toHaveBeenCalled();
    for (const secret of [question, material, retrievalKey, modelKey])
      expect(fixture.logs()).not.toContain(secret);
  }, 30_000);

  it('显式通用知识回答保持零 HTTP、零检索账本', async () => {
    const question = '请明确使用通用知识回答：二加二等于几，不需要企业资料。';
    const fixture = await createAgentTask(database, question);
    const http = await localRetrieval((_request, response) => {
      response.end('{}');
    });
    const runtime = assemble(fixture);
    controlledModel([{ question, turns: [() => json(answer('general', '二加二等于四。'))] }]);
    expect(await runTestAgent(runtime.agent, fixture.input, fixture.dependencies)).toEqual(
      answer('general', '二加二等于四。')
    );
    expect(http.requests).toEqual([]);
    expect(await queries(fixture)).toEqual([]);
    expect(
      await fixture.dependencies.knowledge.listEvidence(fixture.input.task.taskId, page)
    ).toEqual([]);
  }, 30_000);

  it.each([
    {
      name: '未注册的Dataset修改工具',
      toolName: 'update_dataset',
      input: { datasetId: 't28-unapproved-dataset', name: '禁止的资料修改' },
    },
    {
      name: '知识工具额外非批准Dataset范围',
      toolName: 'knowledge-search',
      input: { query: '采购订单', datasetId: 't28-unapproved-dataset' },
    },
  ])(
    '$name 被真实工具边界拒绝，不发出检索请求',
    async scenario => {
      const question = `受控工具输入边界：${scenario.name}`;
      const fixture = await createAgentTask(database, question);
      const http = await localRetrieval((_request, response) => {
        response.end('{}');
      });
      const runtime = assemble(fixture);
      controlledModel([
        {
          question,
          turns: [
            () => tool(scenario.toolName, scenario.input),
            input => {
              expect(JSON.stringify(input.prompt)).toMatch(
                /error|invalid|not found|not available|validation/i
              );
              return json(answer('service_error', '工具调用被拒绝，不能声称已经检索。'));
            },
          ],
        },
      ]);
      // Mastra 可以将工具校验失败交还主模型，也可以按严格策略直接失败；都不得执行工具。
      const outcome = await runTestAgent(runtime.agent, fixture.input, fixture.dependencies).then(
        value => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      );
      if (outcome.error !== undefined) {
        expect(outcome.error).toBeInstanceOf(AppError);
        assert.ok(outcome.error instanceof AppError);
        expect(['model', 'internal']).toContain(outcome.error.type);
      } else {
        expect(outcome.value).toEqual(
          answer('service_error', '工具调用被拒绝，不能声称已经检索。')
        );
      }
      expect(http.requests).toEqual([]);
      expect(await queries(fixture)).toEqual([]);
    },
    30_000
  );

  it('reader-sim 通过原生 skill 真正读取正文，而非只看技能名称', async () => {
    const question =
      '请使用通用读者体验而非企业事实，模拟初次读者阅读草稿：雨停后，我把未寄出的信放回抽屉。';
    const fixture = await createAgentTask(database, question);
    const http = await localRetrieval((_request, response) => {
      response.end('{}');
    });
    const runtime = assemble(fixture);
    controlledModel([
      {
        question,
        turns: [
          () => tool('skill', { name: 'reader-sim' }),
          input => {
            const prompt = JSON.stringify(input.prompt);
            expect(prompt).toContain('Transportation');
            expect(prompt).toContain('Anchor claims to the text');
            expect(prompt).toContain('未寄出的信');
            return json(
              answer(
                'general',
                '假设我是初次读者：“未寄出的信”让我好奇收信人的身份，放回抽屉使我感到迟疑。'
              )
            );
          },
        ],
      },
    ]);
    const result = await runTestAgent(runtime.agent, fixture.input, fixture.dependencies);
    expect(result.answer).toContain('假设我是初次读者');
    expect(result.answerType).toBe('general');
    expect(http.requests).toEqual([]);
    expect(await queries(fixture)).toEqual([]);
  }, 30_000);

  it('非法结构化答案明确抛出 model/internal 系统错误，不伪装成普通回答', async () => {
    const question = '请用通用知识解释测试结构化边界。';
    const fixture = await createAgentTask(database, question);
    const runtime = assemble(fixture);
    const model = controlledModel([
      {
        question,
        turns: [
          () =>
            json({
              answer: '这个草稿不能被放行',
              answerType: 'enterprise',
              evidenceIds: '不是数组',
              subQuestions: [],
              diagnostics: [],
            }),
        ],
      },
    ]);
    await expectSystemFailure(runTestAgent(runtime.agent, fixture.input, fixture.dependencies), [
      'model',
      'internal',
    ]);
    expect(model).toHaveBeenCalledTimes(1);
    expect(await queries(fixture)).toEqual([]);
    expect(fixture.logs()).not.toContain('这个草稿不能被放行');
  }, 30_000);

  it('循环边界在工具回合耗尽时明确失败，不把工具结果当成最终答案', async () => {
    const question = '受控循环边界：查询采购审批流程。';
    const fixture = await createAgentTask(database, question);
    fixture.dependencies.config.agent.maxSteps = 1;
    await localRetrieval((_request, response) => {
      found(response, fixture.dependencies.config.datasetId, '审批资料已经返回，但尚未生成答案。');
    });
    const runtime = assemble(fixture);
    const model = controlledModel([
      {
        question,
        turns: [
          () =>
            stream(
              [
                {
                  type: 'tool-call',
                  toolCallId: randomUUID(),
                  toolName: 'knowledge-search',
                  input: JSON.stringify({ query: '采购审批流程' }),
                },
                { type: 'text-start', id: 'draft' },
                {
                  type: 'text-delta',
                  id: 'draft',
                  delta: JSON.stringify(answer('enterprise', '尚未完成工具回合的合法JSON草稿')),
                },
                { type: 'text-end', id: 'draft' },
              ],
              true
            ),
          () => evidenceAnswer(fixture, '审批资料已经返回，但尚未生成答案。'),
        ],
      },
    ]);
    await expectSystemFailure(runTestAgent(runtime.agent, fixture.input, fixture.dependencies), [
      'model',
    ]);
    expect(model).toHaveBeenCalledTimes(1);
    const recorded = await queries(fixture);
    expect(recorded.map(item => item.resultCategory)).toEqual(['found']);
    exited(attempts(recorded[0]!)[0]!);
  }, 30_000);

  it('知识证据落账失败不能被模型后续合法输出掩盖', async () => {
    const question = '受控落账故障：采购订单如何保存？';
    const fixture = await createAgentTask(database, question);
    await localRetrieval((_request, response) => {
      found(response, fixture.dependencies.config.datasetId, '采购订单点击保存。');
    });
    const runtime = assemble(fixture);
    const failure = new Error('受控知识账本写入失败');
    vi.spyOn(fixture.dependencies.knowledge, 'recordQuery').mockRejectedValue(failure);
    controlledModel([
      {
        question,
        turns: [
          () => tool('knowledge-search', { query: '采购订单保存' }),
          () => json(answer('service_error', '知识调用出现错误。')),
        ],
      },
    ]);
    const error: unknown = await runTestAgent(
      runtime.agent,
      fixture.input,
      fixture.dependencies
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    assert.ok(error instanceof AggregateError);
    expect(error.errors).toContainEqual(
      expect.objectContaining({ type: 'storage', cause: failure })
    );
    expect(await queries(fixture)).toEqual([]);
  }, 30_000);

  it('只读 Memory 能召回旧正文，但输入及草稿不保存，runId/resource/thread 与当前任务一致', async () => {
    const question = '请按通用知识说明当前上下文的项目代号，当前输入标记是红狐。';
    const fixture = await createAgentTask(database, question);
    const runtime = assemble(fixture);
    const memory = await runtime.agent.getMemory();
    assert.ok(memory instanceof Memory);
    const { threadId } = fixture.input.context;
    const resourceId = fixture.input.task.employeeId;
    await memory.createThread({ threadId, resourceId, title: '只读合同' });
    await memory.saveMessages({
      messages: [
        {
          id: randomUUID(),
          threadId,
          resourceId,
          role: 'user',
          createdAt: new Date(),
          content: { format: 2, parts: [{ type: 'text', text: '已送达的旧项目代号是蓝鲸。' }] },
        },
      ],
    });
    const engine = await memory.omEngine;
    assert.ok(engine);
    await engine.observe({ threadId, resourceId });
    await engine.updateRecordConfig(threadId, resourceId, { observation: { messageTokens: 1 } });
    const before = await memory.recall({ threadId, resourceId });
    const generate = vi.spyOn(runtime.agent, 'generate');
    controlledModel([
      {
        question,
        turns: [
          input => {
            expect(JSON.stringify(input.prompt)).toContain('蓝鲸');
            expect(JSON.stringify(input.prompt)).toContain('红狐');
            return json(answer('general', '未送达草稿：项目代号是蓝鲸。'));
          },
        ],
      },
    ]);
    expect(
      (await runTestAgent(runtime.agent, fixture.input, fixture.dependencies)).answer
    ).toContain('蓝鲸');
    expect((await memory.recall({ threadId, resourceId })).messages).toEqual(before.messages);
    expect((await engine.getRecord(threadId, resourceId))?.activeObservations ?? '').toBe('');
    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        runId: fixture.input.attempt.attemptId,
        memory: { resource: resourceId, thread: threadId, options: { readOnly: true } },
      })
    );
    expect(ModelRouterLanguageModel.prototype.doStream).not.toHaveBeenCalled();
    expect(await queries(fixture)).toEqual([]);
  }, 30_000);

  it('模型等待中取消传播到实际模型请求，返回前不产生答案和检索', async () => {
    const question = '请用通用知识等待取消测试。';
    const fixture = await createAgentTask(database, question);
    const runtime = assemble(fixture);
    const controller = new AbortController();
    fixture.input.signal = controller.signal;
    const entered = deferred<AbortSignal>();
    controlledModel([
      {
        question,
        turns: [
          input => {
            assert.ok(input.abortSignal);
            const signal = input.abortSignal;
            entered.resolve(signal);
            return new Promise<ModelResult>((_resolve, reject) => {
              const cancel = (): void =>
                reject(new DOMException('受控模型调用已取消', 'AbortError'));
              if (signal.aborted) cancel();
              else signal.addEventListener('abort', cancel, { once: true });
            });
          },
        ],
      },
    ]);
    const running = runTestAgent(runtime.agent, fixture.input, fixture.dependencies);
    const failed = expectSystemFailure(running, ['cancelled']);
    const modelSignal = await entered.promise;
    controller.abort(new DOMException('员工已取消', 'AbortError'));
    await failed;
    expect(modelSignal.aborted).toBe(true);
    expect(await queries(fixture)).toEqual([]);
    const memory = await runtime.agent.getMemory();
    expect(
      (
        await memory!.recall({
          threadId: fixture.input.context.threadId,
          resourceId: fixture.input.task.employeeId,
        })
      ).messages
    ).toEqual([]);
  }, 30_000);

  it('真实 Python 在本地 HTTP 挂起时取消，runAgent 返回前 PID 已退出且取消账本完整', async () => {
    const question = '受控挂起企业问题：如何撤回采购订单？';
    const fixture = await createAgentTask(database, question);
    const reached = deferred<void>();
    const http = await localRetrieval(() => reached.resolve());
    const runtime = assemble(fixture);
    const controller = new AbortController();
    fixture.input.signal = controller.signal;
    controlledModel([
      { question, turns: [() => tool('knowledge-search', { query: '撤回采购订单' })] },
    ]);
    const failed = expectSystemFailure(
      runTestAgent(runtime.agent, fixture.input, fixture.dependencies),
      ['cancelled']
    );
    await reached.promise;
    controller.abort(new DOMException('员工取消真实 Python 检索', 'AbortError'));
    await failed;
    expect(http.requests).toHaveLength(1);
    const recorded = await queries(fixture);
    expect(recorded.map(item => item.resultCategory)).toEqual(['cancelled']);
    const children = attempts(recorded[0]!);
    expect(children).toHaveLength(1);
    expect(children[0]!.result.kind).toBe('cancelled');
    exited(children[0]!);
    expect(
      await fixture.dependencies.knowledge.listEvidence(fixture.input.task.taskId, page)
    ).toEqual([]);
  }, 30_000);

  it('多查询及临时失败重试共享原绝对 deadline，不为第二次查询或 Python 重试续期', async () => {
    const question = '受控预算企业问题：先查订单，再查审核。';
    const fixture = await createAgentTask(database, question, { executionMs: 8_000 });
    const deadline = fixture.input.task.executionDeadline!;
    let secondRequests = 0;
    const retryReached = deferred<void>();
    const http = await localRetrieval(async (request, response) => {
      if (request.body.question === '先查订单') {
        found(response, fixture.dependencies.config.datasetId, '第一查询资料。');
      } else if (++secondRequests === 1) {
        // 按原绝对 deadline 释放 503，避免固定 sleep 假设机器启动耗时。
        await delay(Math.max(0, deadline - Date.now() - 1_500));
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 500, message: '受控临时故障' }));
      } else {
        retryReached.resolve();
        // 真实 Python 等待 HTTP；只允许原任务 deadline 终止它。
      }
    });
    const runtime = assemble(fixture);
    controlledModel([
      {
        question,
        turns: [
          () => tool('knowledge-search', { query: '先查订单' }),
          () => tool('knowledge-search', { query: '再查审核' }),
        ],
      },
    ]);
    const failed = expectSystemFailure(
      runTestAgent(runtime.agent, fixture.input, fixture.dependencies),
      ['timeout']
    );
    await failed;
    const finishedAt = Date.now();
    expect(secondRequests).toBe(2);
    await retryReached.promise;
    expect(finishedAt).toBeGreaterThanOrEqual(deadline);
    expect(finishedAt).toBeLessThan(deadline + 2_000);
    expect(
      (await fixture.dependencies.tasks.getTask(fixture.input.task.taskId))?.executionDeadline
    ).toBe(deadline);
    const recorded = await queries(fixture);
    expect(recorded.map(item => [item.query, item.callIndex, item.resultCategory])).toEqual([
      ['先查订单', 1, 'found'],
      ['再查审核', 2, 'timeout'],
    ]);
    expect(attempts(recorded[0]!)).toHaveLength(1);
    const retried = attempts(recorded[1]!);
    expect(retried.map(item => item.result.kind)).toEqual(['service_error', 'timeout']);
    expect(retried[1]!.startedAt).toBeLessThan(deadline);
    for (const query of recorded) for (const child of attempts(query)) exited(child);
    expect(http.requests.map(item => item.body.question)).toEqual([
      '先查订单',
      '再查审核',
      '再查审核',
    ]);
    expect(http.failures).toEqual([]);
  }, 30_000);

  it('同一任务的新 attempt 继续调用序号，原查询和原 deadline 保留', async () => {
    const question = '受控重入企业问题：查询采购限额。';
    const fixture = await createAgentTask(database, question);
    const material = '采购限额以审批单记录为准。';
    await localRetrieval((_request, response) =>
      found(response, fixture.dependencies.config.datasetId, material)
    );
    const runtime = assemble(fixture);
    controlledModel([
      {
        question,
        turns: [
          () => tool('knowledge-search', { query: '第一次采购限额' }),
          () => evidenceAnswer(fixture, material),
          () => tool('knowledge-search', { query: '新尝试采购限额' }),
          () => evidenceAnswer(fixture, material),
        ],
      },
    ]);
    await runTestAgent(runtime.agent, fixture.input, fixture.dependencies);
    const originalAttempt = fixture.input.attempt;
    expect(
      await fixture.dependencies.tasks.finishAttempt({
        attemptId: originalAttempt.attemptId,
        finishedAt: Date.now(),
        errorType: null,
      })
    ).toBe(true);
    const attemptId = randomUUID();
    const next = await fixture.dependencies.tasks.startAttempt({
      taskId: fixture.input.task.taskId,
      attemptId,
      runId: attemptId,
      inputVersion: fixture.input.task.inputVersion,
      expectedAttemptId: originalAttempt.attemptId,
      configDigest: originalAttempt.configDigest,
      now: Date.now(),
    });
    assert.ok(next);
    const current = await fixture.dependencies.tasks.getTask(fixture.input.task.taskId);
    assert.ok(current);
    await runTestAgent(
      runtime.agent,
      { ...fixture.input, task: current, attempt: next },
      fixture.dependencies
    );
    const recorded = await queries(fixture);
    expect(recorded.map(item => [item.callIndex, item.attemptId, item.query])).toEqual([
      [1, originalAttempt.attemptId, '第一次采购限额'],
      [2, next.attemptId, '新尝试采购限额'],
    ]);
    expect(current.executionDeadline).toBe(fixture.input.task.executionDeadline);
    expect(await fixture.dependencies.knowledge.getLastCallIndex(current.taskId)).toBe(2);
  }, 30_000);

  it('同一个 Agent 并发执行不同员工 task，交错 HTTP 返回不串工具绑定或 Memory', async () => {
    const firstQuestion = '并发甲员工独有问题：采购审核甲。';
    const secondQuestion = '并发乙员工独有问题：采购审核乙。';
    const first = await createAgentTask(database, firstQuestion);
    const second = await createAgentTask(database, secondQuestion);
    const firstReached = deferred<void>();
    const releaseFirst = deferred<void>();
    const http = await localRetrieval(async (request, response) => {
      if (request.body.question === '甲审核') {
        firstReached.resolve();
        await releaseFirst.promise;
        found(response, first.dependencies.config.datasetId, '甲专属资料：先检查采购甲。');
      } else {
        found(response, second.dependencies.config.datasetId, '乙专属资料：先检查采购乙。');
        releaseFirst.resolve();
      }
    });
    const runtime = assemble(first);
    controlledModel([
      {
        question: firstQuestion,
        turns: [
          () => tool('knowledge-search', { query: '甲审核' }),
          input => {
            expect(JSON.stringify(input.prompt)).not.toContain('乙专属资料');
            return evidenceAnswer(first, '甲专属资料：先检查采购甲。');
          },
        ],
      },
      {
        question: secondQuestion,
        turns: [
          () => tool('knowledge-search', { query: '乙审核' }),
          input => {
            expect(JSON.stringify(input.prompt)).not.toContain('甲专属资料');
            return evidenceAnswer(second, '乙专属资料：先检查采购乙。');
          },
        ],
      },
    ]);
    const firstRun = runTestAgent(runtime.agent, first.input, first.dependencies);
    // 首个真实 Python 已在执行时才启动第二个 task，强制覆盖绑定交错窗口。
    const firstOutcome = firstRun.then(
      value => ({ value }),
      (error: unknown) => ({ error })
    );
    await firstReached.promise;
    const secondRun = runTestAgent(runtime.agent, second.input, second.dependencies);
    const [one, two] = await Promise.all([firstOutcome, secondRun]);
    assert.ok('value' in one);
    expect(one.value.answer).toBe('甲专属资料：先检查采购甲。');
    expect(two.answer).toBe('乙专属资料：先检查采购乙。');
    for (const [fixture, query, content, result] of [
      [first, '甲审核', '甲专属资料：先检查采购甲。', one.value],
      [second, '乙审核', '乙专属资料：先检查采购乙。', two],
    ] as const) {
      const recorded = await queries(fixture);
      expect(
        recorded.map(item => [item.query, item.callIndex, item.attemptId, item.bootId])
      ).toEqual([[query, 1, fixture.input.attempt.attemptId, fixture.dependencies.bootId]]);
      const evidence = await fixture.dependencies.knowledge.listEvidence(
        fixture.input.task.taskId,
        page
      );
      expect(evidence.map(item => item.content)).toEqual([content]);
      expect(result.evidenceIds).toEqual(evidence.map(item => item.evidenceId));
      const memory = await runtime.agent.getMemory();
      expect(
        (
          await memory!.recall({
            threadId: fixture.input.context.threadId,
            resourceId: fixture.input.task.employeeId,
          })
        ).messages
      ).toEqual([]);
    }
    expect(http.requests.map(item => item.body.question)).toEqual(['甲审核', '乙审核']);
    expect(http.failures).toEqual([]);
  }, 30_000);

  it('并发第二任务失败时，测试清理先取消并等待首个真实Python而非关闭存储', async () => {
    const first = await createAgentTask(database, '清理甲：查询采购订单。');
    const second = await createAgentTask(database, '清理乙：触发模型故障。');
    const reached = deferred<void>();
    const http = await localRetrieval(() => {
      reached.resolve();
    });
    const runtime = assemble(first);
    controlledModel([
      {
        question: '清理甲：查询采购订单。',
        turns: [() => tool('knowledge-search', { query: '采购订单' })],
      },
      {
        question: '清理乙：触发模型故障。',
        turns: [
          () => {
            throw new Error('第二任务受控模型失败');
          },
        ],
      },
    ]);
    const firstEnded = expectSystemFailure(
      runTestAgent(runtime.agent, first.input, first.dependencies),
      ['cancelled']
    );
    await reached.promise;
    await expectSystemFailure(runTestAgent(runtime.agent, second.input, second.dependencies), [
      'model',
    ]);
    await cancelAgentRuns();
    await firstEnded;
    const recorded = await queries(first);
    expect(recorded.map(item => item.resultCategory)).toEqual(['cancelled']);
    exited(attempts(recorded[0]!)[0]!);
    expect(http.requests).toHaveLength(1);
    expect(await queries(second)).toEqual([]);
  }, 30_000);
});
