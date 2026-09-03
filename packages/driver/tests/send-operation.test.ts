import { describe, expect, it } from 'vitest';
import {
  FakeKK9Driver,
  InMemorySendOperationStore,
  createSendOperationFingerprint,
} from '../src/index.js';

describe('发送操作 Store port 与 FakeDriver', () => {
  it('规范化目标并以发送类型和内容摘要组成 fingerprint', () => {
    const base = createSendOperationFingerprint({
      targetSessionId: 'session-1',
      messageType: 'text',
      content: '回答内容',
    });
    const normalized = createSendOperationFingerprint({
      targetSessionId: '  session-1  ',
      messageType: 'text',
      content: '回答内容',
    });

    expect(normalized).toEqual(base);
    expect(base.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createSendOperationFingerprint({
        targetSessionId: 'session-1',
        messageType: 'rich-text',
        content: '回答内容',
      })
    ).not.toEqual(base);
    expect(
      createSendOperationFingerprint({
        targetSessionId: 'session-1',
        messageType: 'text',
        content: '不同内容',
      })
    ).not.toEqual(base);
    expect(
      createSendOperationFingerprint({
        targetSessionId: undefined,
        messageType: 'text',
        content: '回答内容',
      })
    ).toEqual(
      createSendOperationFingerprint({
        targetSessionId: '   ',
        messageType: 'text',
        content: '回答内容',
      })
    );
  });

  it('claim 首次记录 unknown，update 后可查询最终 delivered', async () => {
    const store = new InMemorySendOperationStore();
    const fingerprint = createSendOperationFingerprint({
      targetSessionId: 'session-1',
      messageType: 'text',
      content: '回答内容',
    });

    const claim = await store.claim({ operationId: 'op-1', fingerprint });
    expect(claim.claimed).toBe(true);
    expect(claim.operation.status).toBe('unknown');

    const delivered = await store.update('op-1', {
      status: 'delivered',
      messageId: 'native-1',
      isPreTrigger: false,
    });

    expect(delivered).toMatchObject({
      operationId: 'op-1',
      fingerprint,
      status: 'delivered',
      messageId: 'native-1',
    });
    expect(await store.get('op-1')).toEqual(delivered);
  });

  it('同一 operationId 同内容重放只发送一次并复用 delivered', async () => {
    const store = new InMemorySendOperationStore();
    const driver = new FakeKK9Driver(store);
    driver.setSendBehavior({ mode: 'success', messageId: 'native-1' });

    const first = await driver.sendText('回答内容', {
      targetSessionId: '  session-1  ',
      operationId: 'op-1',
    });
    const replay = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    expect(first).toMatchObject({
      operationId: 'op-1',
      status: 'delivered',
      success: true,
      messageId: 'native-1',
    });
    expect(replay).toEqual(first);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('SendFileOptions 的 operationId 同样参与发送防重', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'success', messageId: 'native-file' });

    const first = await driver.sendFile('report.pdf', {
      targetSessionId: 'session-1',
      operationId: 'op-file',
    });
    const replay = await driver.sendFile('report.pdf', {
      targetSessionId: 'session-1',
      operationId: 'op-file',
    });

    expect(first).toMatchObject({
      operationId: 'op-file',
      status: 'delivered',
      success: true,
      messageId: 'native-file',
    });
    expect(replay).toEqual(first);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('空白 operationId 在发送前拒绝且不记录调用', async () => {
    const driver = new FakeKK9Driver();

    await expect(
      driver.sendText('回答内容', {
        targetSessionId: 'session-1',
        operationId: '   ',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(0);
  });

  it('同一 operationId 更换回复或提及参数时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-reply',
      replyTo: 'message-1',
    });

    await expect(
      driver.sendText('回答内容', {
        targetSessionId: 'session-1',
        operationId: 'op-reply',
        replyTo: 'message-2',
      })
    ).rejects.toThrow();

    await driver.sendRichText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-mentions',
      mentions: ['employee-1'],
    });
    await expect(
      driver.sendRichText('回答内容', {
        targetSessionId: 'session-1',
        operationId: 'op-mentions',
        mentions: ['employee-2'],
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it('同一 operationId 更换目标会话时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    await expect(
      driver.sendText('回答内容', {
        targetSessionId: 'session-2',
        operationId: 'op-1',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('同一 operationId 更换消息类型时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    await expect(
      driver.sendRichText('回答内容', {
        targetSessionId: 'session-1',
        operationId: 'op-1',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('同一 operationId 更换内容时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    await expect(
      driver.sendText('不同内容', {
        targetSessionId: 'session-1',
        operationId: 'op-1',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('unknown 重放不盲目再次发送', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'post_trigger_timeout', error: '回执丢失' });

    const first = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });
    const replay = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    expect(first).toMatchObject({
      operationId: 'op-1',
      status: 'unknown',
      success: false,
      isPreTrigger: false,
    });
    expect(replay).toEqual(first);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('确定的前置失败允许同一 operationId 安全重试并转为 delivered', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({
      mode: 'sequence',
      behaviors: [
        { mode: 'pre_trigger_failure', error: '会话切换失败' },
        { mode: 'success', messageId: 'native-2' },
      ],
    });

    const failed = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });
    const retried = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    expect(failed).toMatchObject({
      operationId: 'op-1',
      status: 'failed',
      success: false,
      isPreTrigger: true,
    });
    expect(retried).toMatchObject({
      operationId: 'op-1',
      status: 'delivered',
      success: true,
      messageId: 'native-2',
    });
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it('共享 Store 的并发调用只允许一个发送者触发动作', async () => {
    const store = new InMemorySendOperationStore();
    const firstDriver = new FakeKK9Driver(store);
    const secondDriver = new FakeKK9Driver(store);
    let markStarted = (): void => {};
    let release = (): void => {};
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const released = new Promise<void>(resolve => {
      release = resolve;
    });

    firstDriver.setSendBehavior({
      mode: 'custom',
      handler: async () => {
        markStarted();
        await released;
        return { success: true, messageId: 'native-concurrent' };
      },
    });

    const firstPromise = firstDriver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-concurrent',
    });
    await started;

    const concurrent = await secondDriver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-concurrent',
    });
    release();
    const first = await firstPromise;

    expect(concurrent).toMatchObject({
      operationId: 'op-concurrent',
      status: 'unknown',
      success: false,
    });
    expect(first).toMatchObject({
      operationId: 'op-concurrent',
      status: 'delivered',
      success: true,
      messageId: 'native-concurrent',
    });
    expect(firstDriver.recordedCalls).toHaveLength(1);
    expect(secondDriver.recordedCalls).toHaveLength(0);
  });

  it('没有 operationId 时保留旧发送路径并使用默认内存 Store', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'success', messageId: 'legacy-1' });

    const result = await driver.sendText('旧调用方内容');

    expect(result).toEqual({
      success: true,
      messageId: 'legacy-1',
      isPreTrigger: false,
      verifyLatencyMs: 15,
    });
    expect(driver.recordedCalls).toHaveLength(1);
  });
});
