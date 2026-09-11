import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySendOperationStore, KK9Driver, type KK9Message } from '@kairo/driver';
import { createEnterpriseAnswerDriver } from '../../scripts/enterprise-answer-driver.js';

function createDriver() {
  return createEnterpriseAnswerDriver(
    { cdp: { url: 'http://127.0.0.1:1', pageMatch: 'test' } },
    new InMemorySendOperationStore(),
    '5761',
    '0-3585'
  );
}

function message(id: string, sessionId: string): KK9Message {
  return {
    id,
    sessionId,
    sessionName: '测试会话',
    sessionType: 'private',
    direction: 'inbound',
    sender: '测试员工',
    content: '测试问题',
    time: '12:00',
    isMe: false,
    timestamp: 1,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('企业真机验收的授权会话范围', () => {
  it('其他会话不能触发业务回复，目标会话消息与撤回仍正常进入', () => {
    const driver = createDriver();
    const events: string[] = [];
    driver.on('message', message => events.push(`消息:${message.id}`));
    driver.on('recalled', message => events.push(`撤回:${message.messageId}`));
    driver.emit('message', message('其他员工', '0-11273'));
    driver.emit('recalled', {
      messageId: '其他撤回',
      sessionId: '0-11273',
      sender: '测试员工',
      time: '12:00',
    });
    driver.emit('message', message('目标员工', '0-3585'));
    driver.emit('recalled', {
      messageId: '目标撤回',
      sessionId: '0-3585',
      sender: '测试员工',
      time: '12:00',
    });
    expect(events).toEqual(['消息:目标员工', '撤回:目标撤回']);
  });

  it('真实连接故障仍传播，不能用会话范围限制掩盖断线', () => {
    const driver = createDriver();
    const failures: Error[] = [];
    driver.on('error', error => failures.push(error));
    const cause = new Error('真实连接中断');
    driver.emit('error', cause);
    expect(failures).toEqual([cause]);
  });

  it('接收范围限制不能替代发送前的目标和Bot身份检查', async () => {
    const nativeSend = vi.spyOn(KK9Driver.prototype, 'sendText');
    const driver = createDriver();
    const identity = vi.spyOn(driver, 'getCurrentUserId').mockResolvedValue('5761');
    await expect(driver.sendText('不得发送', { targetSessionId: '0-11273' })).rejects.toThrow();
    identity.mockResolvedValue('其他Bot');
    await expect(driver.sendText('不得发送', { targetSessionId: '0-3585' })).rejects.toThrow();
    expect(nativeSend).not.toHaveBeenCalled();
  });
});
