import type { SendResult } from '@kairo/driver';
import { describe, expect, it, vi } from 'vitest';
import { createSendIntent } from '../../src/modules/im-transport/send-policy.js';
import {
  START,
  deferred,
  fixture,
  observation,
  setupSendServiceTests,
} from '../helpers/send-service-fixture.js';

setupSendServiceTests();

describe('T25 进度发送的等待暂停门禁', () => {
  it('预算占用前已等待时保留唯一 prepared，恢复后同 purpose 只发送一次', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'waiting_for_user';
    f.state.task.currentWaitId = '等待一';
    f.state.task.executionDeadline = null;
    const { service } = f.open();
    const prepared = await f.dispatches.ensure(createSendIntent(f.request, f.state.task.sessionId));
    expect(await service.send(f.request)).toEqual(prepared);
    expect(f.sends[0]).not.toHaveBeenCalled();
    f.state.task.status = 'running';
    f.state.task.executionDeadline = START + 60_000;
    const sent = await service.send(f.request);
    expect(sent).toMatchObject({
      operationId: prepared.operationId,
      purpose: 'progress',
      status: 'delivered',
      sendCalls: 1,
    });
    expect(await service.send(f.request)).toEqual(sent);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('10.001秒已占预算但交付前转等待，只退本次未调用预算，恢复沿用原意图', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'running';
    vi.setSystemTime(START + 10_001);
    const prepared = await f.dispatches.ensure(createSendIntent(f.request, f.state.task.sessionId));
    f.state.taskOutputHook = async () => {
      expect(await f.dispatches.get(prepared.operationId)).toMatchObject({
        status: 'sending',
        sendCalls: 1,
      });
      f.state.task.status = 'waiting_for_user';
      f.state.task.currentWaitId = '等待一';
      f.state.task.executionDeadline = null;
    };
    const { service } = f.open();
    const paused = await service.send(f.request);
    expect(paused).toMatchObject({
      operationId: prepared.operationId,
      status: 'prepared',
      sendCalls: 0,
      queryDueAt: null,
      queryUsed: false,
      resultAt: null,
    });
    expect(f.sends[0]).not.toHaveBeenCalled();
    f.state.taskOutputHook = undefined;
    f.state.task.status = 'running';
    f.state.task.executionDeadline = Date.now() + 60_000;
    const sent = await service.send(f.request);
    expect(sent).toMatchObject({
      operationId: prepared.operationId,
      purpose: 'progress',
      status: 'delivered',
      sendCalls: 1,
    });
    expect(await service.send(f.request)).toEqual(sent);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('已触发的进度在等待中收到回执，不退预算且恢复不会再次发送', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'running';
    const receipt = deferred<SendResult>();
    const { service } = f.open({ behaviors: [{ mode: 'custom', handler: () => receipt.promise }] });
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    f.state.task.status = 'waiting_for_user';
    f.state.task.currentWaitId = '等待一';
    f.state.task.executionDeadline = null;
    receipt.resolve(observation('delivered'));
    const result = await pending;
    expect(result).toMatchObject({ status: 'cancelled', sendCalls: 1, queryDueAt: START + 30_000 });
    f.state.task.status = 'running';
    f.state.task.executionDeadline = START + 60_000;
    expect(await service.send(f.request)).toEqual(result);
    expect(await service.recover(f.request)).toEqual(result);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('重试调用在锁内暂停只退第二次 reservation，不抹除首次明确失败及原查询截止', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'running';
    const prior = await f.seed({
      status: 'retryable',
      sendCalls: 1,
      queryUsed: true,
      queryDueAt: START + 5_000,
    });
    f.state.taskOutputHook = () => {
      f.state.task.status = 'waiting_for_user';
      f.state.task.currentWaitId = '等待一';
      f.state.task.executionDeadline = null;
    };
    const { service } = f.open();
    expect(await service.send(f.request)).toMatchObject({
      operationId: prior.operationId,
      status: 'retryable',
      sendCalls: 1,
      queryUsed: true,
      queryDueAt: START + 5_000,
    });
    expect(f.sends[0]).not.toHaveBeenCalled();
    f.state.taskOutputHook = undefined;
    f.state.task.status = 'running';
    f.state.task.executionDeadline = START + 60_000;
    expect(await service.send(f.request)).toMatchObject({
      status: 'delivered',
      sendCalls: 2,
      queryUsed: true,
      queryDueAt: START + 5_000,
    });
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('sending 崩溃快照在等待中恢复也不退预算，不凭未见回执猜测未触发', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'waiting_for_user';
    f.state.task.currentWaitId = '等待一';
    f.state.task.executionDeadline = null;
    const prior = await f.seed({ status: 'sending', sendCalls: 1, queryDueAt: START });
    const { service } = f.open();
    const result = await service.recover(f.request);
    expect(result).toMatchObject({
      operationId: prior.operationId,
      status: 'cancelled',
      sendCalls: 1,
      queryDueAt: START,
    });
    f.state.task.status = 'running';
    f.state.task.executionDeadline = START + 60_000;
    expect(await service.send(f.request)).toEqual(result);
    expect(f.sends[0]).not.toHaveBeenCalled();
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('交付锁发现上下文已失效时取消，不因等待退还预算或复活意图', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'running';
    f.state.taskOutputHook = () => {
      f.state.task.status = 'waiting_for_user';
      f.state.task.currentWaitId = '等待一';
      f.state.context.invalidatedAt = Date.now();
    };
    const { service } = f.open();
    expect(await service.send(f.request)).toMatchObject({ status: 'cancelled', sendCalls: 1 });
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('reservation CAS 败方不接管胜方已推进的 retryable', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'running';
    const compare = f.dispatches.compareAndSet.bind(f.dispatches);
    vi.spyOn(f.dispatches, 'compareAndSet').mockImplementationOnce(
      async (operationId, revision, update) => {
        const won = await compare(operationId, revision, update);
        await compare(operationId, won!.revision, { ...won!, status: 'retryable' });
        return null;
      }
    );
    const { service } = f.open();
    expect(await service.send(f.request)).toMatchObject({ status: 'retryable', sendCalls: 1 });
    expect(f.sends[0]).not.toHaveBeenCalled();
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('暂停回退 CAS 败方保留胜方终态及预算，不复活 prepared', async () => {
    const f = fixture();
    f.request.purpose = 'progress';
    f.state.task.status = 'running';
    f.state.taskOutputHook = () => {
      f.state.task.status = 'waiting_for_user';
      f.state.task.currentWaitId = '等待一';
    };
    const compare = f.dispatches.compareAndSet.bind(f.dispatches);
    vi.spyOn(f.dispatches, 'compareAndSet').mockImplementation(
      async (operationId, revision, update) => {
        if (update.status === 'prepared') {
          const current = (await f.dispatches.get(operationId))!;
          await compare(operationId, revision, {
            ...current,
            status: 'cancelled',
            resultAt: Date.now(),
          });
          return null;
        }
        return compare(operationId, revision, update);
      }
    );
    const { service } = f.open();
    const result = await service.send(f.request);
    expect(result).toMatchObject({ status: 'cancelled', sendCalls: 1 });
    expect(f.sends[0]).not.toHaveBeenCalled();
    f.state.taskOutputHook = undefined;
    f.state.task.status = 'running';
    expect(await service.send(f.request)).toEqual(result);
    expect(f.sends[0]).not.toHaveBeenCalled();
  });
});
