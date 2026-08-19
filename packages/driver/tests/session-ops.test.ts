import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SessionOps } from '../src/dom/session-ops.js';

describe('SessionOps 会话管理与虚拟滚动穿透测试', () => {
  it('getSessions 应正确解析 Vue 虚拟滚动列表数据并识别 unreadAt 与群聊', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue([
        {
          id: 'ses_1',
          name: '测试123',
          type: 'group',
          unread: true,
          unreadCount: 3,
          unreadAt: true,
          lastMessage: '[@有人@我] 紧急需求请看下',
          lastMessageTime: '12:00',
          active: false,
        },
        {
          id: 'ses_2',
          name: 'init2024',
          type: 'private',
          unread: false,
          unreadCount: 0,
          unreadAt: false,
          lastMessage: '收到了',
          lastMessageTime: '11:30',
          active: true,
        },
      ]),
    } as unknown as CdpClient;

    const ops = new SessionOps(mockCdp, DEFAULT_SELECTORS);
    const sessions = await ops.getSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({
      id: 'ses_1',
      name: '测试123',
      type: 'group',
      unread: true,
      unreadCount: 3,
      unreadAt: true,
      lastMessage: '[@有人@我] 紧急需求请看下',
      lastMessageTime: '12:00',
      active: false,
    });
    expect(sessions[0]?.unreadAt).toBe(true);
    expect(sessions[1]?.active).toBe(true);
    expect(mockCdp.evaluate).toHaveBeenCalledOnce();
  });

  it('getCurrentSession 应优先返回激活会话', async () => {
    const mockCdp = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ id: 'ses_2', name: '王五' })
        .mockResolvedValueOnce([
          { id: 'ses_1', name: '李四', type: 'private', unread: false, active: false },
          { id: 'ses_2', name: '王五', type: 'private', unread: false, active: true },
        ]),
    } as unknown as CdpClient;

    const ops = new SessionOps(mockCdp, DEFAULT_SELECTORS);
    const current = await ops.getCurrentSession();

    expect(current).not.toBeNull();
    expect(current?.id).toBe('ses_2');
    expect(current?.name).toBe('王五');
  });

  it('selectSession 应正确调用切换脚本并返回结果', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({ success: true, method: 'direct_click' }),
    } as unknown as CdpClient;

    const ops = new SessionOps(mockCdp, DEFAULT_SELECTORS);
    const success = await ops.selectSession('ses_1');

    expect(success).toBe(true);
    expect(mockCdp.evaluate).toHaveBeenCalledOnce();
  });

  it('markSessionRead 应执行消除未读红点脚本并返回结果', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as CdpClient;

    const ops = new SessionOps(mockCdp, DEFAULT_SELECTORS);
    const success = await ops.markSessionRead('ses_1');

    expect(success).toBe(true);
    expect(mockCdp.evaluate).toHaveBeenCalledOnce();
  });
});
