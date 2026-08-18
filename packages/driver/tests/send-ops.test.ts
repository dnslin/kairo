import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SendOps } from '../src/dom/send-ops.js';
import type { CdpClient } from '../src/cdp/client.js';

describe('SendOps 消息发送与安全校验测试', () => {
  it('sendText 空内容应直接拦截返回错误', async () => {
    const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
    const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

    const res = await ops.sendText('   ');
    expect(res.success).toBe(false);
    expect(res.error).toContain('不能为空');
    expect(mockCdp.evaluate).not.toHaveBeenCalled();
  });

  it('checkPreSendState 应根据 DOM 会话状态返回是否可发送', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({
        canSend: false,
        reason: 'session_switched',
        details: '当前活跃会话与目标会话不一致',
      }),
    } as unknown as CdpClient;

    const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
    const check = await ops.checkPreSendState('target_session_id');

    expect(check.canSend).toBe(false);
    expect(check.reason).toBe('session_switched');
  });

  it('sendText 在前置校验未通过时应中止发送', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({
        canSend: false,
        reason: 'session_switched',
      }),
    } as unknown as CdpClient;

    const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
    const res = await ops.sendText('你好', { targetSessionId: 'expected_id' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('发送前检查未通过');
  });

  it('sendImage 不存在的文件应返回错误', async () => {
    const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
    const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

    const res = await ops.sendImage('./non_existent_image_12345.png');
    expect(res.success).toBe(false);
    expect(res.error).toContain('文件不存在');
  });
});
