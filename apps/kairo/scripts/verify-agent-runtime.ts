import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { loadBotConfig } from '../src/config/load.js';
import { createKairoMastra, type KairoMastra } from '../src/mastra/index.js';
import { runAgent } from '../src/modules/agent-runtime/run-agent.js';
import { answerSchema, type AgentAnswer } from '../src/modules/knowledge-qa/answer-schema.js';
import type { KnowledgeQuery } from '../src/modules/knowledge-qa/knowledge-record-store.js';
import { retrievalResultSchema } from '../src/modules/tool-integration/knowledge-contract.js';
import { knowledgeTools } from '../src/modules/tool-integration/knowledge-tool.js';
import { loadRetrievalSettings } from '../src/modules/tool-integration/python-retrieval.js';
import { createAgentTask } from '../tests/helpers/agent-runtime.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../tests/helpers/task-database.js';

// 独立真实模型、ERP、Python 和临时 PostgreSQL 验收；不启动应用、IM 或答案放行流程。
// 仓库根目录执行：pnpm --filter @kairo/driver exec tsx --env-file=<配置文件绝对路径> ../../apps/kairo/scripts/verify-agent-runtime.ts
const scenarios = [
  {
    name: '企业采购问题',
    kind: 'enterprise',
    question: 'ERP 采购订单如何创建？请依据企业资料说明操作步骤。',
  },
  {
    name: '显式通用知识',
    kind: 'general',
    question: '请只用通用知识解释为什么会有四季，不涉及任何企业制度或 ERP，无需检索企业知识。',
  },
  {
    name: '多子问题分别检索',
    kind: 'multiple',
    question:
      '请分别回答两个企业 ERP 子问题，并对每个子问题单独检索，不要合并成一次查询：' +
      '第一，采购订单如何创建？第二，采购入库如何操作？请分别组织各自的操作步骤和资料依据。',
  },
  {
    name: '通用知识与自然语言读者体验',
    kind: 'skill',
    question:
      '这是虚构草稿的阅读体验请求，请只使用通用知识，不涉及企业事实，无需检索企业知识。' +
      '请扮演第一次读这段文字的读者：二十五岁，常读悬疑小说，偏爱克制的语言，可以接受暂时的疑问，' +
      '不知道人物背景和结局。按阅读顺序说说你当时的感受、猜测和注意力变化，不要改写或做写作技巧点评。' +
      '草稿：电梯停在了不存在的十三楼。门外没有灯，只有一双湿鞋。' +
      '林然认出那是自己昨天扔掉的鞋。手机亮了，妈妈发来消息：别让门外的你进来。',
  },
] as const;
const allowedTools: Record<string, true> = {
  'knowledge-search': true,
  skill: true,
  skill_read: true,
  skill_search: true,
};
type Scenario = (typeof scenarios)[number];
type SafeFailure = { 场景: string; 类别: string; status?: number };
interface ModelObservation {
  reset(): void;
  snapshot(): { toolNames: string[]; readerSkillLoaded: boolean; callsObserved: number };
  restore(): void;
}

class AcceptanceFailure extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
function requireProof(condition: unknown, category: string): asserts condition {
  if (!condition) throw new AcceptanceFailure(category);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
function toolInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

// 仅查看发送给批准模型的原生消息；不保存正文、不修改请求、响应、请求头或参数。
function observeModel(model: ModelRouterLanguageModel, secrets: string[]): ModelObservation {
  let toolNames = new Set<string>();
  let readerSkillLoaded = false;
  let callsObserved = 0;
  function observe(prompt: unknown): void {
    callsObserved++;
    const serialized = JSON.stringify(prompt);
    requireProof(
      secrets.every(secret => !serialized.includes(secret)),
      '模型上下文凭证边界失败'
    );
    const readerCalls = new Set<string>();
    for (const message of Array.isArray(prompt) ? prompt : []) {
      const envelope = record(message);
      if (!Array.isArray(envelope?.content)) continue;
      for (const content of envelope.content) {
        const part = record(content);
        if (!part) continue;
        if (envelope.role === 'assistant' && part.type === 'tool-call') {
          requireProof(
            typeof part.toolName === 'string' && Object.hasOwn(allowedTools, part.toolName),
            '出现非批准工具调用'
          );
          if (
            part.toolName === 'skill' &&
            toolInput(part.input)?.name === 'reader-sim' &&
            typeof part.toolCallId === 'string'
          ) {
            readerCalls.add(part.toolCallId);
          }
        }
        if (envelope.role === 'tool' && part.type === 'tool-result') {
          requireProof(
            typeof part.toolName === 'string' && Object.hasOwn(allowedTools, part.toolName),
            '出现非批准工具结果'
          );
          toolNames.add(part.toolName);
          // 匹配真实 skill 调用及它在后续模型请求中的完整正文标记，不能以工具可见性冒充加载。
          if (
            part.toolName === 'skill' &&
            typeof part.toolCallId === 'string' &&
            readerCalls.has(part.toolCallId)
          ) {
            const output = JSON.stringify(part.output);
            if (
              output?.includes('# Reader Simulation') &&
              output.includes('Transportation') &&
              output.includes('Anchor claims to the text')
            ) {
              readerSkillLoaded = true;
            }
          }
        }
      }
    }
  }
  const generate = model.doGenerate;
  const stream = model.doStream;
  model.doGenerate = input => {
    observe(input.prompt);
    return generate.call(model, input);
  };
  model.doStream = input => {
    observe(input.prompt);
    return stream.call(model, input);
  };
  return {
    reset(): void {
      toolNames = new Set();
      readerSkillLoaded = false;
      callsObserved = 0;
    },
    snapshot: () => ({ toolNames: [...toolNames].sort(), readerSkillLoaded, callsObserved }),
    restore(): void {
      model.doGenerate = generate;
      model.doStream = stream;
    },
  };
}

async function readAll<T>(readPage: (offset: number, limit: number) => Promise<T[]>): Promise<T[]> {
  const records: T[] = [];
  // 这是账本分页大小，不是知识查询上限；读取到空页为止。
  for (;;) {
    const page = await readPage(records.length, 100);
    if (page.length === 0) return records;
    records.push(...page);
  }
}
function pythonRecords(queries: KnowledgeQuery[]): { PID: number; 退出码: number | null }[] {
  return queries.flatMap(query => {
    const attempts = record(query.rawResult)?.attempts;
    requireProof(Array.isArray(attempts) && attempts.length > 0, '缺少真实Python调用记录');
    return attempts.map(value => {
      const attempt = record(value);
      requireProof(
        typeof attempt?.pid === 'number' && Number.isInteger(attempt.pid) && attempt.pid > 0,
        'Python进程标识无效'
      );
      requireProof(
        attempt.exitCode === null ||
          (typeof attempt.exitCode === 'number' && Number.isInteger(attempt.exitCode)),
        'Python退出记录无效'
      );
      const parsed = retrievalResultSchema.safeParse(attempt.result);
      requireProof(parsed.success, 'Python结果Schema失败');
      if (parsed.data.kind === 'found') {
        requireProof(attempt.exitCode === 0, 'Python成功结果退出码异常');
      }
      return { PID: attempt.pid, 退出码: attempt.exitCode };
    });
  });
}

async function main(): Promise<void> {
  const errors: SafeFailure[] = [];
  const seenErrors = new Map<string, Set<unknown>>();
  function failure(error: unknown, scene: string, category: string): void {
    const seen = seenErrors.get(scene) ?? new Set<unknown>();
    if (seen.has(error)) return;
    seen.add(error);
    seenErrors.set(scene, seen);
    const value = record(error);
    const status = value?.statusCode ?? value?.status;
    errors.push({
      场景: scene,
      类别: error instanceof AcceptanceFailure ? error.category : category,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? { status }
        : {}),
    });
    if (error instanceof AggregateError) {
      for (const nested of error.errors) failure(nested, scene, category);
    }
    if (value?.cause !== undefined) failure(value.cause, scene, category);
  }
  let database: TaskTestDatabase | undefined;
  let runtime: KairoMastra | undefined;
  let observer: ModelObservation | undefined;
  let pending: Promise<AgentAnswer> | undefined;
  let activeController: AbortController | undefined;
  let currentScene: string = '初始化';
  const reported = new Set<Scenario>();
  let runtimeLogs: (() => string) | undefined;
  try {
    requireProof(process.argv.length === 2, '不支持场景选择或替代模式');
    requireProof(process.env.KAIRO_TEST_DATABASE_URL?.trim(), '缺少测试数据库配置');
    const modelApiKey = process.env.KAIRO_T12_MODEL_API_KEY;
    requireProof(
      typeof modelApiKey === 'string' && modelApiKey.trim().length > 0,
      '缺少批准模型凭证'
    );
    const { config } = await loadBotConfig(undefined, Object.keys(knowledgeTools));
    const retrieval = loadRetrievalSettings(config.datasetId);
    requireProof(config.skills.includes('reader-sim'), '缺少批准reader-sim配置');
    const secrets = [modelApiKey, retrieval.apiKey];
    database = await createTaskTestDatabase();
    for (const scene of scenarios) {
      currentScene = scene.name;
      const started = performance.now();
      try {
        const fixture = await createAgentTask(database, scene.question);
        requireProof(
          fixture.dependencies.config.model.id === config.model.id &&
            fixture.dependencies.config.model.url === config.model.url &&
            fixture.dependencies.config.datasetId === config.datasetId,
          '验收期间正式配置发生变化'
        );
        if (!runtime) {
          runtime = createKairoMastra({
            config: fixture.dependencies.config,
            customization: fixture.customization,
            databaseUrl: database.databaseUrl,
            logger: fixture.dependencies.logger,
          });
          runtimeLogs = fixture.logs;
          const agents = Object.values(runtime.mastra.listAgents());
          requireProof(agents.length === 1 && agents[0] === runtime.agent, '唯一Agent装配失败');
          const model = await runtime.agent.getModel();
          requireProof(model instanceof ModelRouterLanguageModel, '非批准原生模型路由');
          observer = observeModel(model, secrets);
        }
        requireProof(observer, '模型调用观察器未建立');
        observer.reset();
        activeController = new AbortController();
        pending = runAgent(
          runtime.agent,
          { ...fixture.input, signal: activeController.signal },
          fixture.dependencies
        );
        const answer = await pending;
        pending = undefined;
        const schema = answerSchema.safeParse(answer);
        requireProof(schema.success, '回答Schema失败');
        const taskId = fixture.input.task.taskId;
        const knowledge = fixture.dependencies.knowledge;
        const queries = await readAll((offset, limit) =>
          knowledge.listQueries(taskId, { offset, limit })
        );
        const evidence = await readAll((offset, limit) =>
          knowledge.listEvidence(taskId, { offset, limit })
        );
        const python = pythonRecords(queries);
        const observed = observer.snapshot();
        requireProof(observed.callsObserved > 0, '缺少真实批准模型调用');
        requireProof(
          queries.every(query => query.datasetId === config.datasetId),
          '检索Dataset偏离正式配置'
        );
        const evidenceById = new Map(evidence.map(item => [item.evidenceId, item]));
        requireProof(
          [...answer.evidenceIds, ...answer.subQuestions.flatMap(item => item.evidenceIds)].every(
            id => evidenceById.has(id)
          ),
          '回答引用不存在的证据'
        );
        if (scene.kind === 'enterprise' || scene.kind === 'multiple') {
          const minimum = scene.kind === 'multiple' ? 2 : 1;
          requireProof(queries.length >= minimum, '企业知识查询不足');
          requireProof(
            queries.filter(query => query.resultCategory === 'found').length >= minimum &&
              new Set(evidence.map(item => item.queryId)).size >= minimum,
            '缺少实际ERP有资料结果'
          );
          requireProof(
            observed.toolNames.includes('knowledge-search'),
            '模型未取得真实知识工具结果'
          );
          requireProof(
            answer.answerType === 'enterprise' || answer.answerType === 'conflict',
            '企业回答类型不符'
          );
          requireProof(answer.evidenceIds.length > 0, '企业回答未关联资料');
          if (scene.kind === 'multiple') {
            requireProof(
              new Set(queries.map(query => query.query.trim())).size >= 2,
              '未分别组织检索问题'
            );
            requireProof(answer.subQuestions.length >= 2, '缺少各子问题结构');
            const citedQueries = answer.subQuestions.map(item => {
              requireProof(item.evidenceIds.length > 0, '子问题缺少实际证据');
              return item.evidenceIds.map(id => evidenceById.get(id)!.queryId);
            });
            requireProof(new Set(citedQueries.flat()).size >= 2, '多子问题未使用各次检索资料');
          }
        } else {
          requireProof(queries.length === 0, '显式通用知识发生企业查询');
          requireProof(answer.answerType === 'general', '显式通用知识回答类型不符');
          requireProof(answer.evidenceIds.length === 0, '通用回答误用企业证据');
        }
        if (scene.kind === 'skill') {
          requireProof(observed.readerSkillLoaded, 'reader-sim未真实加载到后续模型上下文');
        }
        const logs = `${runtimeLogs?.() ?? ''}${fixture.logs()}`;
        requireProof(
          secrets.every(secret => !logs.includes(secret)),
          '普通日志凭证边界失败'
        );
        requireProof(!logs.includes(scene.question), '普通日志出现员工正文');
        requireProof(
          evidence.every(item => !logs.includes(item.content)),
          '普通日志出现知识正文'
        );
        console.info(
          JSON.stringify({
            场景: scene.name,
            模型ID: config.model.id,
            回答类型: answer.answerType,
            耗时毫秒: Math.round(performance.now() - started),
            查询次数: queries.length,
            查询类别: queries.map(query => query.resultCategory),
            Python: python,
            实际工具名: observed.toolNames,
            断言: {
              回答Schema: true,
              证据关联: true,
              ...(scene.kind === 'multiple' ? { 多子问题独立检索: true } : {}),
              ...(scene.kind === 'skill' ? { readerSim真实加载且进入后续上下文: true } : {}),
            },
          })
        );
      } catch (error) {
        failure(error, scene.name, '场景调用或验收失败');
      } finally {
        activeController?.abort();
        try {
          await pending;
        } catch (error) {
          failure(error, scene.name, 'Agent收尾失败');
        }
        pending = undefined;
        activeController = undefined;
        reported.add(scene);
      }
    }
  } catch (error) {
    // 缺少前置条件时四场景均明确记为失败，不标记通过、不静默少跑。
    for (const scene of scenarios) {
      if (!reported.has(scene)) errors.push({ 场景: scene.name, 类别: '前置条件失败，未能执行' });
    }
    failure(error, currentScene, '配置或初始化失败');
  } finally {
    activeController?.abort();
    try {
      await pending;
    } catch (error) {
      failure(error, currentScene, 'Agent收尾失败');
    }
    // 必须先等待 Agent 与本地 Tool 结束，再关闭唯一 Mastra，最后只删除本次自建数据库。
    try {
      await runtime?.close();
    } catch (error) {
      failure(error, '资源收尾', 'Mastra关闭失败');
    }
    observer?.restore();
    try {
      await database?.close();
    } catch (error) {
      failure(error, '资源收尾', '临时数据库关闭失败');
    }
  }
  for (const error of errors) console.error(JSON.stringify(error));
  if (errors.length > 0) process.exitCode = 1;
}

await main();
