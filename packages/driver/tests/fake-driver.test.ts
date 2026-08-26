import { describe, it, expect, beforeEach } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';

describe('FakeKK9Driver 故障注入与发送不可逆边界测试', () => {
  let driver: FakeKK9Driver;

  beforeEach(() => {
    driver = new FakeKK9Driver();
  });

  it('默认行为：发送文本返回明确成功与原生消息 ID', async () => {
    const res = await driver.sendText('测试内容', { targetSessionId: 'ses_01' });
    expect(res.success).toBe(true);
    expect(res.messageId).toBeDefined();
    expect(res.isPreTrigger).toBe(false);
    expect(driver.recordedCalls.length).toBe(1);
    expect(driver.recordedCalls[0].payload).toBe('测试内容');
  });

  it('pre_trigger_failure: 正确标识为 isPreTrigger = true', async () => {
    driver.setSendBehavior({
      mode: 'pre_trigger_failure',
      error: '参数校验失败，发送未触发',
    });

    const res = await driver.sendText('测试内容');
    expect(res.success).toBe(false);
    expect(res.isPreTrigger).toBe(true);
    expect(res.error).toBe('参数校验失败，发送未触发');
  });

  it('post_trigger_timeout: 正确标识为 isPreTrigger = false', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_timeout',
      error: 'CDP 超时未收到回执',
    });

    const res = await driver.sendText('超时内容');
    expect(res.success).toBe(false);
    expect(res.isPreTrigger).toBe(false);
    expect(res.error).toBe('CDP 超时未收到回执');
  });

  it('post_trigger_disconnect: 正确标识为 isPreTrigger = false', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_disconnect',
      error: '发送动作发出后 CDP 连接断开',
    });

    const res = await driver.sendText('断线内容');
    expect(res.success).toBe(false);
    expect(res.isPreTrigger).toBe(false);
    expect(res.error).toContain('CDP 连接断开');
  });

  it('sequence: 支持模拟顺序执行 (前置失败 -> 成功)', async () => {
    driver.setSendBehavior({
      mode: 'sequence',
      behaviors: [
        { mode: 'pre_trigger_failure', error: '瞬时切换失败' },
        { mode: 'success', messageId: 'kk_seq_success' },
      ],
    });

    const res1 = await driver.sendText('重试第1次');
    expect(res1.success).toBe(false);
    expect(res1.isPreTrigger).toBe(true);

    const res2 = await driver.sendText('重试第2次');
    expect(res2.success).toBe(true);
    expect(res2.messageId).toBe('kk_seq_success');
    expect(driver.recordedCalls.length).toBe(2);
  });

  it('selectSession 与 preSendCheck 自定义模拟', async () => {
    driver.setSelectSessionBehavior((sessionId) => sessionId === 'ses_valid');
    expect(await driver.selectSession('ses_valid')).toBe(true);
    expect(await driver.selectSession('ses_invalid')).toBe(false);

    driver.setPreSendCheckBehavior((sessionId) => {
      if (sessionId === 'ses_busy') {
        return { canSend: false, reason: 'input_not_empty' };
      }
      return { canSend: true };
    });

    const check1 = await driver.preSendCheck('ses_normal');
    expect(check1.canSend).toBe(true);

    const check2 = await driver.preSendCheck('ses_busy');
    expect(check2.canSend).toBe(false);
    expect(check2.reason).toBe('input_not_empty');
  });
});
