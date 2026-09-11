import { describe, expect, it, vi } from 'vitest';
import { createRecovery } from '../../src/modules/task-lifecycle/recovery.js';
import type { Task, TaskStore } from '../../src/modules/task-lifecycle/types.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import type { SendRequest, SendDispatch } from '../../src/modules/im-transport/send-policy.js';

const now = Date.now();
function task(status: Task['status'], extra: Partial<Task> = {}): Task {
  return {
    taskId: status,
    batchId: status,
    botId: 'bot',
    sessionId: status,
    employeeId: status,
    threadId: status,
    inputVersion: 1,
    configDigest: '原配置',
    status,
    createdAt: now - 2000,
    updatedAt: now - 1000,
    queueDeadline: now + 600000,
    executionStartedAt: now - 1000,
    executionDeadline: now + 239000,
    executionBudgetMs: 240000,
    queueNoticeRequired: false,
    currentAttemptId: '原尝试',
    currentWaitId: null,
    endedAt: null,
    recoveryUsed: false,
    answerText: null,
    ...extra,
  };
}
function fixture(rows: Task[]) {
  const recovered: Task[][] = [];
  const requests: Array<{ purpose: string; text: string }> = [];
  const collector = { recover: vi.fn(() => Promise.resolve()) };
  const scheduler = {
    recover: vi.fn((running: Task[]) => {
      recovered.push(running);
      return Promise.resolve();
    }),
    tick: vi.fn(() => Promise.resolve()),
  };
  const tasks = {
    listActiveTasks: vi.fn(() => Promise.resolve(rows)),
    getTaskWait: vi.fn<TaskStore['getTaskWait']>(() => Promise.resolve(null)),
    transitionTask: vi.fn<TaskStore['transitionTask']>(() => Promise.resolve(false)),
    failRecovery: vi.fn(({ taskId }: { taskId: string }) => {
      const row = rows.find(value => value.taskId === taskId)!;
      row.status = 'failed';
      return Promise.resolve(true);
    }),
  };
  const delivered = (request: SendRequest): Promise<SendDispatch> => {
    requests.push(request);
    return Promise.resolve({
      operationId: request.purpose,
      intentKey: request.purpose,
      taskId: null,
      purpose: request.purpose,
      sessionId: '受控会话',
      contentDigest: '受控摘要',
      status: 'delivered',
      sendCalls: 1,
      queryUsed: false,
      queryDueAt: null,
      resultAt: now,
      messageId: '受控消息',
      revision: 1,
    });
  };
  const sender = { send: vi.fn(delivered), recover: vi.fn(delivered) };
  const signal = new AbortController();
  const recovery = createRecovery({
    tasks,
    collector,
    scheduler,
    sender,
    signal: signal.signal,
    logger: createLogger({ write(): void {} }),
  });
  return { recovery, tasks, collector, scheduler, sender, signal, recovered, requests };
}

describe('进程重启恢复协调', () => {
  it('只将原 running 交给原调度，queued与等待不被改写，重复调用共享一次恢复', async () => {
    const running = task('running');
    const queued = task('queued');
    const waiting = task('waiting_for_user', { currentWaitId: '原等待' });
    const f = fixture([running, queued, waiting]);
    await Promise.all([f.recovery.recover(), f.recovery.recover()]);
    await f.recovery.recover();
    expect(f.recovered).toEqual([[running]]);
    expect(running.executionDeadline).toBe(now + 239000);
    expect(queued.queueDeadline).toBe(now + 600000);
    expect(waiting.currentWaitId).toBe('原等待');
    expect(f.requests).toEqual([]);
    expect(f.collector.recover).toHaveBeenCalledTimes(1);
  });

  it('再次重启的未到期 running 失败并通知，不再分配恢复 attempt', async () => {
    const running = task('running', { recoveryUsed: true });
    const f = fixture([running]);
    await f.recovery.recover();
    expect(running.status).toBe('failed');
    expect(f.recovered).toEqual([[]]);
    expect(f.requests.map(request => request.purpose)).toEqual(['notice:recovery_failure']);
  });

  it('已过期恢复不误记失败，交既有调度按原截止超时', async () => {
    const running = task('running', { recoveryUsed: true, executionDeadline: now - 1 });
    const f = fixture([running]);
    await f.recovery.recover();
    expect(f.tasks.failRecovery).not.toHaveBeenCalled();
    expect(f.recovered).toEqual([[running]]);
  });

  it('sending和ready只用持久正文调用T21恢复，不生成或直接send', async () => {
    const f = fixture([
      task('sending', { answerText: '原已检查答案', executionDeadline: now - 1 }),
      task('ready_to_send', { answerText: '第二份原答案' }),
    ]);
    await f.recovery.recover();
    expect(f.sender.send).not.toHaveBeenCalled();
    expect(f.requests.map(request => request.text)).toEqual(['原已检查答案', '第二份原答案']);
    expect(f.scheduler.tick).toHaveBeenCalledTimes(2);
  });

  it('缺失已检查正文时失败并通知，不虚构原答案或重新生成', async () => {
    const sending = task('sending');
    const f = fixture([sending]);
    await f.recovery.recover();
    expect(sending.status).toBe('failed');
    expect(f.sender.recover).not.toHaveBeenCalled();
    expect(f.requests.map(request => request.purpose)).toEqual(['notice:recovery_failure']);
  });

  it('发送查询错误原样传播，同时等待其他恢复收尾', async () => {
    const failure = new Error('真实查询错误');
    const f = fixture([task('sending', { answerText: '原答案' })]);
    f.sender.recover.mockRejectedValueOnce(failure);
    await expect(f.recovery.recover()).rejects.toBe(failure);
    expect(f.collector.recover).toHaveBeenCalledTimes(1);
  });

  it('失效代次不能开始进程恢复', async () => {
    const f = fixture([task('running')]);
    f.signal.abort();
    await expect(f.recovery.recover()).rejects.toThrow();
    expect(f.tasks.listActiveTasks).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it('失败裁决等锁跨截止时仍交回原调度超时，不遗留无人执行running', async () => {
    const running = task('running', { recoveryUsed: true });
    const f = fixture([running]);
    f.tasks.failRecovery.mockImplementationOnce(() => {
      running.executionDeadline = now - 1;
      return Promise.resolve(false);
    });
    await f.recovery.recover();
    expect(f.recovered).toEqual([[running]]);
  });

  it('失败通知拒绝仍恢复其他会话与聚合，最后保留原错误', async () => {
    const exhausted = task('running', { recoveryUsed: true });
    const other = task('running', { taskId: '其他会话' });
    const f = fixture([exhausted, other]);
    const failure = new Error('失败通知发送错误');
    f.sender.send.mockRejectedValueOnce(failure);
    await expect(f.recovery.recover()).rejects.toBe(failure);
    expect(f.recovered).toEqual([[other]]);
    expect(f.collector.recover).toHaveBeenCalledTimes(1);
  });

  it('恢复尚未交付的当前等待问题，沿用原waitId和正文', async () => {
    const f = fixture([task('waiting_for_user', { currentWaitId: '原等待' })]);
    f.tasks.getTaskWait.mockResolvedValue({
      waitId: '原等待',
      taskId: 'waiting_for_user',
      inputVersion: 1,
      question: '原先尚未交付的问题',
      allowedQuestionIds: ['原问题'],
      createdAt: now,
      deadline: now + 600000,
      remainingExecutionMs: 200000,
      closedAt: null,
      resolution: null,
      answerMessage: null,
    });
    await f.recovery.recover();
    expect(f.requests).toMatchObject([
      { purpose: 'notice:user_wait:原等待', text: '原先尚未交付的问题' },
    ]);
    expect(f.sender.send).not.toHaveBeenCalled();
  });
});
