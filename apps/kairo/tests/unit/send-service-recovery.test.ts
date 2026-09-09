import type { SendResult } from '@kairo/driver';
import { describe, expect, it, vi } from 'vitest';
import {
  START,
  behavior,
  deferred,
  fixture,
  observation,
  setupSendServiceTests,
} from '../helpers/send-service-fixture.js';

setupSendServiceTests();

describe('最终判定时刻与空闲起点', () => {
  it('Driver 回执先于交付事务提交时，等待数据库不推迟送达起点', async () => {
    const f = fixture();
    const commit = deferred<void>();
    f.state.outputCommitHook = () => commit.promise;
    const { service } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect([...f.dispatches.records.values()][0]?.resultAt).toBeNull();
    vi.setSystemTime(START + 90_000);
    commit.resolve();
    const result = await pending;
    expect(result.resultAt).toBe(START);
    expect(f.state.context.idleSince).toBe(START);
    expect(f.state.task.endedAt).toBe(START + 90_000);
  });

  it('未知发送尚未最终判定时没有空闲起点，查询未知才开始计时', async () => {
    const f = fixture(['unknown']);
    const { service } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect([...f.dispatches.records.values()][0]).toMatchObject({
      status: 'unknown',
      resultAt: null,
    });
    expect(f.state.context.idleSince).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'send_unconfirmed', resultAt: START + 30_000 });
    expect(f.state.context.idleSince).toBe(START + 30_000);
  });

  it.each(['delivered', 'unknown'] as const)(
    '%s 结果已持久化但任务未结束，恢复沿用首次结果时刻',
    async observed => {
      const f = fixture([observed]);
      const interrupted = new Error('保存最终结果后任务事务中断');
      f.state.transitionHook = input => {
        if (input.to === 'completed' || input.to === 'send_unconfirmed') throw interrupted;
      };
      const old = f.open();
      const pending = old.service.send(f.request);
      const rejected = expect(pending).rejects.toBe(interrupted);
      await vi.advanceTimersByTimeAsync(observed === 'unknown' ? 30_000 : 0);
      await rejected;
      const resultAt = Date.now();
      const saved = [...f.dispatches.records.values()][0]!;
      expect(saved.resultAt).toBe(resultAt);
      expect(f.state.context.idleSince).toBeNull();
      old.service.close();
      f.state.transitionHook = undefined;
      vi.setSystemTime(resultAt + 3 * 60 * 60_000);
      const next = f.open();
      expect(await next.service.recover(f.request)).toEqual(saved);
      expect(f.state.context.idleSince).toBe(resultAt);
      expect(f.state.task.endedAt).toBe(Date.now());
      vi.setSystemTime(Date.now() + 60_000);
      expect(await next.service.recover(f.request)).toEqual(saved);
      expect(f.state.context.idleSince).toBe(resultAt);
      expect(f.sends[1]).not.toHaveBeenCalled();
      expect(f.queries[1]).not.toHaveBeenCalled();
    }
  );

  it('缺少真实判定时刻的既有送达结果明确拒绝恢复，不猜测历史时间', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    const saved = await f.seed({ status: 'delivered', messageId: '旧记录', resultAt: null });
    const { service } = f.open();
    await expect(service.recover(f.request)).rejects.toThrow();
    expect(await f.dispatches.get(saved.operationId)).toEqual(saved);
    expect(f.state.context.idleSince).toBeNull();
    expect(f.state.task.status).toBe('sending');
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('明确失败恢复以任务结束时刻计空闲，不使用发送判定时刻', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    await f.seed({ status: 'failed', resultAt: START - 5_000 });
    const { service } = f.open();
    await service.recover(f.request);
    expect(f.state.task.status).toBe('failed');
    expect(f.state.task.endedAt).toBe(START);
    expect(f.state.context.idleSince).toBe(START);
  });
});

describe('关闭和显式恢复', () => {
  it.each(['有效', '任务取消', '上下文失效'] as const)(
    '查询预算已用但已持久送达：%s时不重查、不重发且不刷新空闲',
    async state => {
      const f = fixture();
      f.state.task.status = state === '任务取消' ? 'cancelled' : 'sending';
      const row = await f.seed({
        status: 'querying',
        sendCalls: 1,
        queryUsed: true,
        queryDueAt: START + 30_000,
      });
      await f.driverStore.claim({
        operationId: row.operationId,
        fingerprint: {
          targetSessionId: f.state.task.sessionId,
          messageType: 'text',
          contentDigest: '已送达答案摘要',
        },
      });
      await f.driverStore.update(row.operationId, {
        status: 'delivered',
        messageId: '持久送达编号',
      });
      if (state === '上下文失效') f.state.context.invalidatedAt = START + 1;
      vi.setSystemTime(START + 3 * 60 * 60_000);
      const { service } = f.open();
      const result = await service.recover(f.request);
      expect(result.status).toBe(state === '有效' ? 'delivered' : 'cancelled');
      expect(f.state.task.status).toBe(state === '有效' ? 'completed' : 'cancelled');
      expect(f.state.context.idleSince).toBe(state === '有效' ? START : null);
      if (state === '有效') expect(result.resultAt).toBe(START);
      expect(await f.driverStore.get(row.operationId)).toMatchObject({
        status: 'delivered',
        updatedAt: START,
        messageId: '持久送达编号',
      });
      expect(f.queries[0]).not.toHaveBeenCalled();
      expect(f.sends[0]).not.toHaveBeenCalled();
    }
  );

  it('查询预算已用时读取持久证据失败仍传播，不假装未确认并结束任务', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    const row = await f.seed({
      status: 'querying',
      sendCalls: 1,
      queryUsed: true,
      queryDueAt: START + 30_000,
    });
    const failure = new Error('持久送达证据读取失败');
    vi.spyOn(f.driverStore, 'get').mockRejectedValueOnce(failure);
    const { service } = f.open();
    await expect(service.recover(f.request)).rejects.toBe(failure);
    expect(await f.dispatches.get(row.operationId)).toEqual(row);
    expect(f.state.task.status).toBe('sending');
    expect(f.state.context.idleSince).toBeNull();
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.sends[0]).not.toHaveBeenCalled();
  });
  it('等待查询期间才保存送达证据，保留原回执时间且不再查询 Driver', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    const row = await f.seed({
      status: 'sending',
      sendCalls: 1,
      queryUsed: false,
      queryDueAt: START + 30_000,
    });
    await f.driverStore.claim({
      operationId: row.operationId,
      fingerprint: {
        targetSessionId: f.state.task.sessionId,
        messageType: 'text',
        contentDigest: '在途答案摘要',
      },
    });
    const { service } = f.open({ query: id => Promise.resolve(observation('delivered', id)) });
    const pending = service.recover(f.request);
    await vi.advanceTimersByTimeAsync(5000);
    await f.driverStore.update(row.operationId, { status: 'delivered', messageId: '已送达消息' });
    await vi.advanceTimersByTimeAsync(25000);
    const recovered = await pending;
    expect(recovered).toMatchObject({
      status: 'delivered',
      resultAt: START + 5000,
      queryUsed: false,
    });
    expect(f.state.context.idleSince).toBe(START + 5000);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.sends[0]).not.toHaveBeenCalled();
  });
  it('关闭等待后新服务沿用绝对查询时间，不获得新的三十秒窗口', async () => {
    const f = fixture(['unknown'], 'delivered');
    const old = f.open();
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.queryDueAt).toBe(START + 30_000);
    old.service.close();
    await vi.advanceTimersByTimeAsync(10_000);
    const next = f.open();
    const pending = next.service.recover(f.request);
    await vi.advanceTimersByTimeAsync(9_999);
    for (const query of f.queries) expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe('delivered');
    expect(result.operationId).toBe(row.operationId);
    expect(result.sendCalls).toBe(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.queries[1]).toHaveBeenCalledExactlyOnceWith(row.operationId);
    expect(f.sends[1]).not.toHaveBeenCalled();
    await abandoned;
  });

  it('关闭不关闭 Driver，迟到发送结果不能覆盖恢复的未确认终态', async () => {
    const f = fixture();
    const gate = deferred<SendResult>();
    const old = f.open({ behaviors: [{ mode: 'custom', handler: () => gate.promise }] });
    const disconnect = vi.spyOn(old.fake, 'disconnect');
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(0);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.status).toBe('sending');
    expect(row.sendCalls).toBe(1);
    old.service.close();
    const next = f.open();
    const pending = next.service.recover(f.request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.queries[1]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const recovered = await pending;
    expect(recovered.status).toBe('send_unconfirmed');
    gate.resolve(observation('delivered'));
    await abandoned;
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.dispatches.get(row.operationId)).toEqual(recovered);
    expect(f.state.task.status).toBe('send_unconfirmed');
    expect(disconnect).not.toHaveBeenCalled();
    expect(f.sends[1]).not.toHaveBeenCalled();
  });

  it('querying 中崩溃已经消耗唯一查询，恢复直接未确认且忽略旧查询迟到结果', async () => {
    const f = fixture(['unknown']);
    const queryGate = deferred<SendResult>();
    const old = f.open({ query: () => queryGate.promise });
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(30_000);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.status).toBe('querying');
    expect(row.queryUsed).toBe(true);
    expect(f.queries[0]).toHaveBeenCalledTimes(1);
    old.service.close();
    const next = f.open();
    const recovered = await next.service.recover(f.request);
    expect(recovered.status).toBe('send_unconfirmed');
    expect(recovered.operationId).toBe(row.operationId);
    expect(f.queries[1]).not.toHaveBeenCalled();
    expect(f.sends[1]).not.toHaveBeenCalled();
    queryGate.resolve(observation('delivered', row.operationId));
    await abandoned;
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.dispatches.get(row.operationId)).toEqual(recovered);
    expect(f.state.task.status).toBe('send_unconfirmed');
  });

  it('第二次发送预算已占用时恢复不能再发第三次', async () => {
    const f = fixture(['failed', 'unknown'], 'failed');
    const old = f.open();
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.sendCalls).toBe(2);
    old.service.close();
    const next = f.open();
    const pending = next.service.recover(f.request);
    await vi.advanceTimersByTimeAsync(20_000);
    const recovered = await pending;
    expect(recovered.status).toBe('failed');
    expect(recovered.sendCalls).toBe(2);
    expect(recovered.queryUsed).toBe(true);
    expect(f.sends[0]).toHaveBeenCalledTimes(2);
    expect(f.sends[1]).not.toHaveBeenCalled();
    expect(f.queries[1]).toHaveBeenCalledExactlyOnceWith(row.operationId);
    await abandoned;
  });

  it('prepared 尚未占用发送预算时可以正常恢复发送', async () => {
    const f = fixture();
    const row = await f.seed({ status: 'prepared' });
    const { service } = f.open();
    const result = await service.recover(f.request);
    expect(result.status).toBe('delivered');
    expect(result.operationId).toBe(row.operationId);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('retryable 崩溃恢复先查询，不能把已记失败当作直接重发许可', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    const row = await f.seed({ status: 'retryable', sendCalls: 1, queryDueAt: START + 30_000 });
    const { service } = f.open({
      query: operationId => Promise.resolve(observation('delivered', operationId)),
    });
    const pending = service.recover(f.request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.sends[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe('delivered');
    expect(result.sendCalls).toBe(1);
    expect(f.queries[0]).toHaveBeenCalledExactlyOnceWith(row.operationId);
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('查询已确认失败并保存后中断，恢复仅使用剩余一次发送预算', async () => {
    const f = fixture(['unknown'], 'failed');
    const write = f.dispatches.compareAndSet.bind(f.dispatches);
    const interruption = new Error('已保存查询结果后中断');
    const intercepted = vi
      .spyOn(f.dispatches, 'compareAndSet')
      .mockImplementation(async (id, revision, update) => {
        const saved = await write(id, revision, update);
        if (saved?.status === 'retryable' && saved.queryUsed) throw interruption;
        return saved;
      });
    const old = f.open();
    const pending = old.service.send(f.request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(interruption);
    old.service.close();
    intercepted.mockRestore();
    const next = f.open({ behaviors: [behavior('delivered')] });
    const result = await next.service.recover(f.request);
    expect(result).toMatchObject({ status: 'delivered', sendCalls: 2, queryUsed: true });
    expect(f.sends[1]).toHaveBeenCalledExactlyOnceWith(f.request.text, {
      operationId: result.operationId,
      targetSessionId: f.state.task.sessionId,
    });
    expect(f.queries[1]).not.toHaveBeenCalled();
  });

  it('Driver 抛错不算明确失败，保留预算供只读恢复', async () => {
    const f = fixture();
    const cause = new Error('Driver 回执异常');
    const { service } = f.open({
      behaviors: [
        {
          mode: 'custom',
          handler: () => {
            throw cause;
          },
        },
      ],
    });
    await expect(service.send(f.request)).rejects.toMatchObject({ type: 'driver', cause });
    const saved = [...f.dispatches.records.values()][0]!;
    expect(saved).toMatchObject({ status: 'sending', sendCalls: 1, queryUsed: false });
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('查询抛错保留 cause 并结束为未确认，重复恢复不补查', async () => {
    const f = fixture(['unknown']);
    const cause = new Error('只读查询连接异常');
    const { service } = f.open({
      query: () => Promise.reject(cause),
    });
    const pending = service.send(f.request);
    const rejected = expect(pending).rejects.toMatchObject({ type: 'driver', cause });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(f.state.task.status).toBe('send_unconfirmed');
    expect((await service.recover(f.request)).status).toBe('send_unconfirmed');
    expect(f.queries[0]).toHaveBeenCalledTimes(1);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('查询故障后保存未确认又失败时同时保留两个原因', async () => {
    const f = fixture(['unknown']);
    const driverCause = new Error('查询断连');
    const storageCause = new Error('保存终态数据库断连');
    const { service } = f.open({
      query: () => {
        vi.spyOn(f.dispatches, 'compareAndSet').mockRejectedValue(storageCause);
        return Promise.reject(driverCause);
      },
    });
    const pending = service.send(f.request);
    const rejected = expect(pending).rejects.toMatchObject({
      errors: [expect.objectContaining({ type: 'driver', cause: driverCause }), storageCause],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect([...f.dispatches.records.values()][0]?.status).toBe('querying');
    expect(f.queries[0]).toHaveBeenCalledTimes(1);
  });

  it('关闭与查询异常同时到达时不丢弃原查询 cause', async () => {
    const f = fixture(['unknown']);
    const cause = new Error('关闭期间查询断连');
    const gate = deferred<SendResult>();
    const { service } = f.open({
      query: async () => {
        await gate.promise;
        throw cause;
      },
    });
    const pending = service.send(f.request);
    const rejected = expect(pending).rejects.toMatchObject({ type: 'driver', cause });
    await vi.advanceTimersByTimeAsync(30_000);
    service.close();
    gate.resolve(observation('unknown'));
    await rejected;
    expect([...f.dispatches.records.values()][0]?.status).toBe('querying');
  });
});
