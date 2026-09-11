import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { CdpClient, type KK9Session } from '@kairo/driver';
import { startKairo, type KairoApplication } from '../src/index.js';
import { loadBotConfig } from '../src/config/load.js';
import { knowledgeTools } from '../src/modules/tool-integration/knowledge-tool.js';
import { PostgresKnowledgeRecordStore } from '../src/modules/knowledge-qa/knowledge-record-store.js';
import { PostgresTaskStore } from '../src/modules/task-lifecycle/store.js';
import { validateAnswer } from '../src/modules/knowledge-qa/validate-answer.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../tests/helpers/task-database.js';
import { createEnterpriseAnswerDriver } from './enterprise-answer-driver.js';

// 真实入口、批准模型、Skill/Tool/Python/RAGFlow与真实IM；只使用本次随机库，不撤回消息。
// --preflight 只读页面身份及已有桥接占用，不创建Driver或发送消息。
// --continuous 持续接收授权会话，输入“停止”结束；不自动宣告人工验收通过。
const botUid = process.env.KK9_STAGE1_BOT_UID;
const employeeUid = process.env.KK9_STAGE1_EMPLOYEE_UID;
const sessionId = process.env.KK9_STAGE1_SESSION_ID;
const sessionName = process.env.KK9_STAGE1_SESSION_NAME;
assert.ok(botUid && employeeUid && sessionId && sessionName, '缺少明确的真机目标');
assert.equal(sessionId, `0-${employeeUid}`, '授权私聊与员工不一致');
assert.equal(
  process.env.KK9_STAGE1_CONFIRM,
  `${botUid}:${employeeUid}:${sessionId}`,
  '真机授权不一致'
);
const { config } = await loadBotConfig(undefined, Object.keys(knowledgeTools));
assert.ok(config.employeeAllowlist.includes(employeeUid), '目标员工不在既有allowlist');
const cdpConfig = {
  url: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
  pageMatch: process.env.PAGE_MATCH ?? 'renderer.html',
};
const inspection = new CdpClient(cdpConfig);
try {
  await inspection.connect();
  const state = await inspection.evaluate<{ uid: string; bridge: boolean }>(`(() => {
    const main = document.querySelector('.main-page')?.__vue__;
    const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
    return { uid: String(main?.userID || editor?.userID || ''), bridge: typeof window.__kairo_bridge_cleanup === 'function' };
  })()`);
  assert.equal(state.uid, botUid, '实际登录Bot与授权不一致');
  assert.equal(state.bridge, false, '已有Driver桥接占用，不能接管或覆盖他人连接');
  console.info(
    JSON.stringify({
      验证: '只读真机预检',
      Bot: state.uid,
      目标员工: employeeUid,
      会话: sessionId,
      桥接空闲: !state.bridge,
    })
  );
} finally {
  await inspection.disconnect();
}

if (!process.argv.includes('--preflight')) {
  let database: TaskTestDatabase | undefined;
  let app: KairoApplication | undefined;
  let target: KK9Session | undefined;
  const lifetime = new AbortController();
  const cancel = (): void => lifetime.abort(new DOMException('真机验收已取消', 'AbortError'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const calls = new Set<string>();
  let skillLoaded = false;
  const generate = ModelRouterLanguageModel.prototype.doGenerate;
  // 仅观察真实模型请求与工具调用，不替换响应、不改模型、参数或内容。
  ModelRouterLanguageModel.prototype.doGenerate = async function (input) {
    if (JSON.stringify(input.prompt).includes('ERP 知识检索')) skillLoaded = true;
    const result = await generate.call(this, input);
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === 'tool-call') calls.add(chunk.toolName);
            controller.enqueue(chunk);
          },
        })
      ),
    };
  };
  const errors: unknown[] = [];
  try {
    database = await createTaskTestDatabase();
    app = await startKairo({
      databaseUrl: database.databaseUrl,
      port: 0,
      cdp: cdpConfig,
      driverFactory(driverConfig, store) {
        return createEnterpriseAnswerDriver(driverConfig, store, botUid, sessionId);
      },
    });
    const readyDeadline = Date.now() + 90000;
    while (Date.now() < readyDeadline) {
      const result = await fetch(`${app.url}/health/dependencies`);
      const health = (await result.json()) as {
        dependencies: { driver: string; model: string; ragflow: string; postgres: string };
      };
      if (Object.values(health.dependencies).every(value => value === 'up')) break;
      await delay(500, undefined, { signal: lifetime.signal });
    }
    const driver = app.driver;
    assert.ok(driver, '真实Driver未连接');
    assert.equal(await driver.getCurrentUserId(), botUid, '公共接口实际Bot核对失败');
    const employee = await driver.getEmployeeBySession(sessionId);
    assert.equal(String(employee?.id), employeeUid, '真实员工身份不匹配');
    const sessions = (await driver.getSessions()).filter(
      row => row.id === sessionId && row.name === sessionName && row.type === 'private'
    );
    assert.equal(sessions.length, 1, '授权私聊必须唯一且名称/类型一致');
    target = sessions[0]!;
    const health = (await (await fetch(`${app.url}/health/dependencies`)).json()) as {
      dependencies: { model: string; ragflow: string; driver: string };
    };
    assert.equal(health.dependencies.model, 'up', '批准模型尚未就绪');
    assert.equal(health.dependencies.ragflow, 'up', '真实RAGFlow尚未就绪');
    assert.equal(health.dependencies.driver, 'up', '真实Driver尚未就绪');
    console.info(
      JSON.stringify({
        状态: '等待员工真实IM提问',
        会话: sessionId,
        员工: employeeUid,
        数据库: database.databaseName,
        模型: config.model.id,
        健康地址: app.url,
      })
    );
    if (process.argv.includes('--continuous')) {
      console.info('持续测试已就绪：可逐题提问；输入“停止”关闭本轮，不代替人工验收。');
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
        signal: lifetime.signal,
      });
      try {
        for await (const line of terminal) {
          if (line.trim() === '停止') break;
        }
      } finally {
        terminal.close();
      }
      console.info('持续测试已停止，答案正确性仍需人工判断。');
    } else {
      const records = new PostgresKnowledgeRecordStore(database.poolA);
      const tasks = new PostgresTaskStore(database.poolA);
      const deadline = Date.now() + 600000;
      let completed: { taskId: string } | undefined;
      while (Date.now() < deadline) {
        const result = await database.poolA.query<{ taskId: string }>(
          'SELECT task_id AS "taskId" FROM kairo.formal_answers WHERE boot_id=$1',
          [app.bootId]
        );
        completed = result.rows[0];
        if (completed) break;
        await delay(500, undefined, { signal: lifetime.signal });
      }
      assert.ok(completed, '等待真实企业回答送达超时，未以替身补齐');
      const task = await tasks.getTask(completed.taskId);
      assert.ok(task?.currentAttemptId);
      const formal = await records.getFormalAnswer(task.taskId);
      const check = await records.getAnswerCheck(task.currentAttemptId);
      assert.ok(formal && check?.answer);
      const queries = await records.listQueries(task.taskId, { limit: 1000, offset: 0 });
      const evidence = await records.listEvidence(task.taskId, { limit: 1000, offset: 0 });
      assert.equal(
        validateAnswer(
          check.answer,
          { taskId: task.taskId, attemptId: task.currentAttemptId, datasetId: config.datasetId },
          { queries, evidence }
        ).status,
        'accepted'
      );
      assert.equal(task.status, 'completed');
      assert.equal(task.employeeId, employeeUid);
      const taskCount = await database.poolA.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM kairo.tasks'
      );
      assert.equal(
        taskCount.rows[0]!.count,
        '1',
        '本轮必须仅有一个员工任务，不能混用不同任务的工具观察'
      );
      assert.ok(
        calls.has('knowledge-search') && calls.has('skill') && skillLoaded,
        '必须实际使用Skill及知识Tool，不能只看最终答案'
      );
      const history = await driver.getRecentMessages(50, target);
      const received = history.find(message => message.id === formal.nativeMessageId);
      assert.ok(received, '真实会话历史中未找到送达消息');
      assert.equal(received.content, formal.answer, '真实消息正文与已检查答案不一致');
      assert.equal(received.direction, 'outbound', '真实回显方向错误');
      console.info(
        JSON.stringify({
          状态: '真实闭环证据核对通过，等待员工人工确认',
          taskId: task.taskId,
          attemptId: task.currentAttemptId,
          operationId: formal.operationId,
          nativeMessageId: formal.nativeMessageId,
          查询数: queries.length,
          采用证据数: check.answer.evidenceIds.length,
          工具: [...calls],
          Skill已加载: skillLoaded,
          正文与数据库一致: true,
          内部来源检查: '通过',
          数据库: database.databaseName,
        })
      );
      console.info(
        '请在本终端输入“完成”结束验收；输入“失败”记录人工未通过。此前保留隔离库供核对，不撤回真实消息。'
      );
      let confirmed = false;
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
        signal: lifetime.signal,
      });
      try {
        for await (const line of terminal) {
          if (line.trim() === '完成') {
            confirmed = true;
            break;
          }
          if (line.trim() === '失败') throw new Error('员工人工验收未通过');
        }
      } finally {
        terminal.close();
      }
      assert.ok(confirmed, '未收到员工人工确认，终端关闭不能算验收通过');
    }
  } catch (cause) {
    errors.push(cause);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    try {
      await app?.close();
    } catch (cause) {
      errors.push(cause);
    }
    ModelRouterLanguageModel.prototype.doGenerate = generate;
    try {
      await database?.close();
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length) {
    console.error(
      JSON.stringify({
        状态: '真实验收未完成',
        错误类型: errors.map(error => (error instanceof Error ? error.name : typeof error)),
        说明: errors
          .filter(error => error instanceof assert.AssertionError)
          .map(error => error.message),
      })
    );
    process.exitCode = 1;
  }
}
