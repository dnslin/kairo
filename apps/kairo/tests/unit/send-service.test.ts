import type { SendResult, SendStatus } from '@kairo/driver';
import { describe, expect, it, vi } from 'vitest';
import type { SendDispatch, SendRequest } from '../../src/modules/im-transport/send-policy.js';
import { AppError, getFailureMessage } from '../../src/modules/operability/errors.js';
import {
  START,
  deferred,
  fixture,
  observation,
  setupSendServiceTests,
} from '../helpers/send-service-fixture.js';

let eventSequence = 0;

setupSendServiceTests();

describe('统一出站协调器结果树', () => {
  const branches: {
    path: string;
    sends: SendStatus[];
    query?: SendStatus;
    final: SendDispatch['status'];
  }[] = [
    { path: 'D', sends: ['delivered'], final: 'delivered' },
    { path: 'F-D', sends: ['failed', 'delivered'], final: 'delivered' },
    { path: 'F-F', sends: ['failed', 'failed'], final: 'failed' },
    { path: 'F-U-D', sends: ['failed', 'unknown'], query: 'delivered', final: 'delivered' },
    { path: 'F-U-F', sends: ['failed', 'unknown'], query: 'failed', final: 'failed' },
    { path: 'F-U-U', sends: ['failed', 'unknown'], query: 'unknown', final: 'send_unconfirmed' },
    { path: 'U-D', sends: ['unknown'], query: 'delivered', final: 'delivered' },
    { path: 'U-U', sends: ['unknown'], query: 'unknown', final: 'send_unconfirmed' },
    { path: 'U-F-D', sends: ['unknown', 'delivered'], query: 'failed', final: 'delivered' },
    { path: 'U-F-F', sends: ['unknown', 'failed'], query: 'failed', final: 'failed' },
    { path: 'U-F-U', sends: ['unknown', 'unknown'], query: 'failed', final: 'send_unconfirmed' },
  ];

  it.each(branches)('$path 遵守整条意图的发送和查询预算', async branch => {
    const f = fixture(branch.sends, branch.query);
    const { service, fake } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    if (branch.query) {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.queries[0]).not.toHaveBeenCalled();
      expect(f.state.task.status).toBe('sending');
      await vi.advanceTimersByTimeAsync(1);
    }
    const result = await pending;
    expect(result.status).toBe(branch.final);
    expect(result.sendCalls).toBe(branch.sends.length);
    expect(result.queryUsed).toBe(branch.query !== undefined);
    expect(f.state.task.status).toBe(branch.final === 'delivered' ? 'completed' : branch.final);
    expect(f.sends[0]).toHaveBeenCalledTimes(branch.sends.length);
    expect(fake.recordedCalls).toHaveLength(branch.sends.length);
    expect(f.queries[0]).toHaveBeenCalledTimes(branch.query ? 1 : 0);
    for (const call of fake.recordedCalls) {
      expect(call.payload).toBe(f.request.text);
      expect(call.options).toMatchObject({
        operationId: result.operationId,
        targetSessionId: f.state.task.sessionId,
      });
    }
    if (branch.query) expect(f.queries[0]).toHaveBeenCalledWith(result.operationId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sends[0]).toHaveBeenCalledTimes(branch.sends.length);
    expect(f.queries[0]).toHaveBeenCalledTimes(branch.query ? 1 : 0);
  });
});

describe('意图隔离与并发幂等', () => {
  it('完成后的同一请求返回既有结果，不再次发送', async () => {
    const f = fixture();
    const { service } = f.open();
    const first = await service.send(f.request);
    const repeated = await service.send({ ...f.request });
    expect(repeated).toEqual(first);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('字段书写顺序不同的同一请求仍可重放，不新增发送', async () => {
    const f = fixture();
    const { service } = f.open();
    const first = await service.send(f.request);
    const replay: SendRequest = {
      ...f.request,
      subject: { inputVersion: 1, taskId: f.state.task.taskId, kind: 'task' },
    };
    expect(await service.recover(replay)).toEqual(first);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('迟到旧输入版本不能抢占当前任务的最终回答用途', async () => {
    const f = fixture();
    f.state.task.inputVersion = 2;
    const { service } = f.open();
    await expect(service.send(f.request)).rejects.toMatchObject({ type: 'cancelled' });
    expect(f.dispatches.records.size).toBe(0);
    const result = await service.send({
      ...f.request,
      subject: { kind: 'task', taskId: f.state.task.taskId, inputVersion: 2 },
    });
    expect(result.status).toBe('delivered');
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('同实例并发共享结果，但进行中的正文和输入版本冲突仍拒绝', async () => {
    const f = fixture();
    const gate = deferred<SendResult>();
    const { service } = f.open({ behaviors: [{ mode: 'custom', handler: () => gate.promise }] });
    const first = service.send(f.request);
    const second = service.send({ ...f.request });
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.send({ ...f.request, text: '另一份正文' })).rejects.toThrow();
    await expect(
      service.send({
        ...f.request,
        subject: { kind: 'task', taskId: f.state.task.taskId, inputVersion: 2 },
      })
    ).rejects.toThrow();
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    gate.resolve(observation('delivered'));
    expect(await second).toEqual(await first);
    expect(f.state.task.status).toBe('completed');
  });

  it('既有终态也不能被不同正文重新解释', async () => {
    const f = fixture();
    const { service } = f.open();
    await service.send(f.request);
    await expect(service.send({ ...f.request, text: '修改后的答案' })).rejects.toThrow();
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.state.task.status).toBe('completed');
  });

  it.each(['sending', 'querying'] as const)('跨实例普通 send 不抢占 %s', async status => {
    const f = fixture();
    f.state.task.status = 'sending';
    const existing = await f.seed({
      status,
      sendCalls: 1,
      queryUsed: status === 'querying',
      queryDueAt: START + 30_000,
    });
    const left = f.open();
    const right = f.open();
    const results = await Promise.all([
      left.service.send(f.request),
      right.service.send(f.request),
    ]);
    expect(results.map(result => result.operationId)).toEqual([
      existing.operationId,
      existing.operationId,
    ]);
    expect(results.map(result => result.status)).toEqual([status, status]);
    expect(f.drivers.flatMap(driver => driver.recordedCalls)).toEqual([]);
    for (const query of f.queries) expect(query).not.toHaveBeenCalled();
    expect(f.state.task.status).toBe('sending');
  });

  it('queued、progress、notice 与 final 独立，只有 final 终结任务', async () => {
    const f = fixture();
    const { service } = f.open();
    const operationIds = new Set<string>();
    for (const purpose of ['queued', 'progress', 'notice:说明'] as const) {
      f.state.task.status = purpose === 'queued' ? 'queued' : 'running';
      const statusBefore = f.state.task.status;
      const result = await service.send({ ...f.request, purpose });
      expect(result.status).toBe('delivered');
      operationIds.add(result.operationId);
      expect(f.state.task.status).toBe(statusBefore);
    }
    f.state.task.status = 'ready_to_send';
    const final = await service.send(f.request);
    operationIds.add(final.operationId);
    expect(operationIds.size).toBe(4);
    expect(f.sends[0]).toHaveBeenCalledTimes(4);
    expect(f.state.task.status).toBe('completed');
  });

  it('无任务事件允许独立 notice，但拒绝 final', async () => {
    const f = fixture();
    const { service } = f.open();
    const subject = {
      kind: 'event' as const,
      botId: f.state.task.botId,
      sessionId: f.state.task.sessionId,
      messageId: '原始消息一',
      threadId: f.state.context.threadId,
    };
    const result = await service.send({ subject, purpose: 'notice:输入提示', text: '请补充信息' });
    expect(result.status).toBe('delivered');
    expect(result.taskId).toBeNull();
    expect(f.state.task.status).toBe('ready_to_send');
    await expect(service.send({ subject, purpose: 'final', text: '不合法答案' })).rejects.toThrow();
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });
});

describe('存储故障固定提示例外', () => {
  it.each(['delivered', 'failed', 'unknown'] as const)(
    '%s 也只发送一次固定正文，跨服务同进程去重且不碰业务存储',
    async status => {
      const f = fixture([status]);
      const fail = () => {
        throw new Error('业务存储不可访问');
      };
      const business = [
        vi.spyOn(f.driverStore, 'claim').mockImplementation(fail),
        vi.spyOn(f.driverStore, 'get').mockImplementation(fail),
        vi.spyOn(f.driverStore, 'update').mockImplementation(fail),
        vi.spyOn(f.dispatches, 'ensure').mockImplementation(fail),
        vi.spyOn(f.dispatches, 'get').mockImplementation(fail),
        vi.spyOn(f.dispatches, 'compareAndSet').mockImplementation(fail),
        vi.mocked(f.tasks.getTask).mockImplementation(fail),
        vi.mocked(f.tasks.transitionTask).mockImplementation(fail),
        vi.mocked(f.contexts.getContext).mockImplementation(fail),
        vi.mocked(f.contexts.getRawMessage).mockImplementation(fail),
      ];
      const event = {
        botId: '故障机器人',
        sessionId: '0-2001',
        messageId: `故障事件-${++eventSequence}`,
      };
      const error = new AppError('storage', {
        cause: new Error('机密 SQL、正文和连接凭据不能发送'),
      });
      const first = f.open();
      const second = f.open();
      const results = await Promise.all([
        first.service.sendStorageFailure(event, error),
        second.service.sendStorageFailure({ ...event }, error),
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      await second.service.sendStorageFailure(event, new AppError('storage'));
      const calls = f.drivers.flatMap(driver => driver.recordedCalls);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toBe(getFailureMessage('storage'));
      expect(calls[0]!.options?.targetSessionId).toBe(event.sessionId);
      const operationId = calls[0]!.options?.operationId;
      expect(operationId).toEqual(expect.any(String));
      const result = results.find(value => value !== null)!;
      expect(result.status).toBe(status);
      expect(result.operationId).toBe(operationId);
      for (const query of f.queries) expect(query).not.toHaveBeenCalled();
      for (const method of business) expect(method).not.toHaveBeenCalled();
      expect(f.state.task.status).toBe('ready_to_send');
    }
  );

  it('相同消息号不同会话的存储故障不是同一事件', async () => {
    const f = fixture();
    const { service, fake } = f.open();
    const messageId = `跨会话故障-${++eventSequence}`;
    const first = await service.sendStorageFailure(
      { botId: '机器人', sessionId: '0-3001', messageId },
      new AppError('storage')
    );
    const second = await service.sendStorageFailure(
      { botId: '机器人', sessionId: '0-3002', messageId },
      new AppError('storage')
    );
    expect(first?.operationId).not.toBe(second?.operationId);
    expect(fake.recordedCalls.map(call => call.payload)).toEqual([
      getFailureMessage('storage'),
      getFailureMessage('storage'),
    ]);
    expect(f.dispatches.records.size).toBe(0);
  });

  it('非 storage AppError 不允许进入绕过持久化的提示通道', async () => {
    const f = fixture();
    const { service } = f.open();
    const event = {
      botId: '机器人',
      sessionId: '0-3001',
      messageId: `非法故障-${++eventSequence}`,
    };
    await expect(service.sendStorageFailure(event, new AppError('driver'))).rejects.toThrow();
    await expect(
      service.sendStorageFailure(event, new Error('伪装存储故障') as AppError)
    ).rejects.toThrow();
    expect(f.sends[0]).not.toHaveBeenCalled();
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.dispatches.records.size).toBe(0);
  });
});
