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

describe('任务和上下文竞争', () => {
  it.each(['queued', 'progress', 'final', 'notice:说明'] as const)(
    '%s 在交付锁获取前上下文失效时不调用 Driver',
    async purpose => {
      const f = fixture();
      f.state.task.status =
        purpose === 'queued' ? 'queued' : purpose === 'final' ? 'ready_to_send' : 'running';
      f.state.taskOutputHook = () => {
        f.state.context.invalidatedAt = Date.now();
      };
      const { service } = f.open();
      expect((await service.send({ ...f.request, purpose })).status).toBe('cancelled');
      expect(f.sends[0]).not.toHaveBeenCalled();
      expect(f.state.context.idleSince).toBeNull();
    }
  );

  it.each(['queued', 'progress', 'final'] as const)(
    '%s 在交付前期限经过时不使用预检查快照',
    async purpose => {
      const f = fixture();
      f.state.task.status =
        purpose === 'queued' ? 'queued' : purpose === 'progress' ? 'running' : 'ready_to_send';
      f.state.taskOutputHook = () => {
        vi.setSystemTime(START + 60_000);
      };
      const { service } = f.open();
      expect((await service.send({ ...f.request, purpose })).status).toBe('cancelled');
      expect(f.sends[0]).not.toHaveBeenCalled();
    }
  );

  it('交付锁内任务已经取消时拒绝固定提示，不仅检查上下文有效性', async () => {
    const f = fixture();
    f.state.taskOutputHook = () => {
      f.state.task.status = 'cancelled';
    };
    const { service } = f.open();
    expect((await service.send({ ...f.request, purpose: 'notice:说明' })).status).toBe('cancelled');
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('原始事件提示在交付锁前作废 thread 时不能迟到发送', async () => {
    const f = fixture();
    f.state.contextOutputHook = () => {
      f.state.context.invalidatedAt = Date.now();
    };
    const { service } = f.open();
    const result = await service.send({
      subject: {
        kind: 'event',
        botId: f.state.context.botId,
        sessionId: f.state.context.sessionId,
        messageId: '原始消息一',
        threadId: f.state.context.threadId,
      },
      purpose: 'notice:输入提示',
      text: '请补充信息',
    });
    expect(result.status).toBe('cancelled');
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('ready_to_send 转换过程中 /new 作废上下文时不触发 Driver', async () => {
    const f = fixture();
    f.state.transitionHook = input => {
      if (input.to === 'sending') f.state.context.invalidatedAt = Date.now();
    };
    const { service } = f.open();
    const result = await service.send(f.request);
    expect(result.status).toBe('cancelled');
    expect(f.sends[0]).not.toHaveBeenCalled();
    expect(f.state.task.status).not.toBe('completed');
  });

  it('第一次明确失败后上下文作废，不能重试', async () => {
    const f = fixture();
    const { service } = f.open({
      behaviors: [
        {
          mode: 'custom',
          handler: () => {
            f.state.context.invalidatedAt = Date.now();
            return observation('failed');
          },
        },
        behavior('delivered'),
      ],
    });
    const result = await service.send(f.request);
    expect(result.status).toBe('cancelled');
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.state.task.status).not.toBe('completed');
  });

  it('触发后才取消的任务不会被迟到送达复活', async () => {
    const f = fixture();
    const gate = deferred<SendResult>();
    const { service } = f.open({ behaviors: [{ mode: 'custom', handler: () => gate.promise }] });
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    f.state.task.status = 'cancelled';
    f.state.context.invalidatedAt = Date.now();
    gate.resolve(observation('delivered'));
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(f.state.task.status).toBe('cancelled');
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('sending 已触发时执行期限经过，不把实际送达改为超时', async () => {
    const f = fixture(['unknown'], 'delivered');
    f.state.task.executionDeadline = START + 1;
    const { service } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe('delivered');
    expect(f.state.task.status).toBe('completed');
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('已经进入 sending 后明确失败的同 ID 重试不重判执行期限', async () => {
    const f = fixture();
    f.state.task.executionDeadline = START + 1;
    const { service } = f.open({
      behaviors: [
        {
          mode: 'custom',
          handler: () => {
            vi.setSystemTime(START + 100);
            return observation('failed');
          },
        },
        behavior('delivered'),
      ],
    });
    expect((await service.send(f.request)).status).toBe('delivered');
    expect(f.sends[0]).toHaveBeenCalledTimes(2);
    expect(f.state.task.status).toBe('completed');
  });
});
