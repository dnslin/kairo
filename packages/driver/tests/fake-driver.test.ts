import { describe, it, expect, beforeEach } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { KK9Employee, KK9Session } from '../src/types/index.js';

describe('FakeKK9Driver 故障注入与契约实现测试 (IKK9Driver)', () => {
  let driver: FakeKK9Driver;

  beforeEach(() => {
    driver = new FakeKK9Driver();
  });

  it('当前身份可从未登录切换账号并再次退出登录', async () => {
    await expect(driver.getCurrentUserId()).resolves.toBeNull();

    driver.setCurrentUserId('5761');
    await expect(driver.getCurrentUserId()).resolves.toBe('5761');

    driver.setCurrentUserId('9529');
    await expect(driver.getCurrentUserId()).resolves.toBe('9529');

    driver.setCurrentUserId(null);
    await expect(driver.getCurrentUserId()).resolves.toBeNull();
  });

  it('私聊场景(int2024)与群聊场景(测试123)发送记录与返回原生消息 ID', async () => {
    const resPrivate = await driver.sendText('私聊测试', { targetSessionId: 'int2024' });
    expect(resPrivate.success).toBe(true);
    expect(resPrivate).toMatchObject({ status: 'delivered', isPreTrigger: false });
    expect(resPrivate.messageId).toBeDefined();
    expect(driver.recordedCalls).toHaveLength(1);
    expect(driver.recordedCalls[0]?.payload).toBe('私聊测试');
    expect(driver.recordedCalls[0]?.options?.targetSessionId).toBe('int2024');

    const resGroup = await driver.sendRichText('群聊测试', {
      targetSessionId: '测试123',
      mentions: ['all'],
    });
    expect(resGroup.success).toBe(true);
    expect(driver.recordedCalls).toHaveLength(2);

    const resReply = await driver.sendReply('msg_1001', '回复内容', { targetSessionId: '测试123' });
    expect(resReply.success).toBe(true);
    expect(driver.recordedCalls[2]?.type).toBe('reply');
  });

  it('pre_trigger_failure: 正确标识为 isPreTrigger = true', async () => {
    driver.setSendBehavior({
      mode: 'pre_trigger_failure',
      error: '参数校验失败，发送未触发',
    });

    const res = await driver.sendText('测试内容', { targetSessionId: 'int2024' });
    expect(res.success).toBe(false);
    expect(res).toMatchObject({ status: 'failed', isPreTrigger: true });
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
    expect(res).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(res.isPreTrigger).toBe(false);
    expect(res.error).toBe('CDP 超时未收到回执');
  });

  it('触发后断开连接返回未知', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_disconnect',
      error: '发送过程中断开',
    });

    const res = await driver.sendText('断连内容');

    expect(res).toMatchObject({
      success: false,
      status: 'unknown',
      isPreTrigger: false,
      error: '发送过程中断开',
    });
  });

  it('触发后丢失响应返回未知', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_lost_response',
      error: '发送响应丢失',
    });

    const res = await driver.sendText('丢失响应内容');

    expect(res).toMatchObject({
      success: false,
      status: 'unknown',
      isPreTrigger: false,
      error: '发送响应丢失',
    });
  });

  it('成功结果缺少原生消息 ID 时返回未知', async () => {
    driver.setSendBehavior({
      mode: 'custom',
      handler: () => ({ success: true }),
    });

    const res = await driver.sendText('缺少原生 ID');

    expect(res).toMatchObject({
      success: true,
      status: 'unknown',
    });
    expect(res.isPreTrigger).toBeUndefined();
    expect(res.messageId).toBeUndefined();
  });

  it('旧版自定义处理器的显式状态保持原语义', async () => {
    driver.setSendBehavior({
      mode: 'custom',
      handler: () => ({
        success: true,
        status: 'unknown',
        messageId: 'legacy-explicit-status',
        isPreTrigger: false,
      }),
    });

    const res = await driver.sendText('显式状态');

    expect(res).toEqual({
      success: true,
      status: 'unknown',
      messageId: 'legacy-explicit-status',
      isPreTrigger: false,
    });
  });

  it('共享 Store 的新 FakeDriver 可以查询已有发送操作', async () => {
    const store = new InMemorySendOperationStore();
    const sender = new FakeKK9Driver(store);
    sender.setSendBehavior({ mode: 'success', messageId: 'shared-native-1' });

    const sent = await sender.sendText('共享查询内容', {
      targetSessionId: 'session-shared',
      operationId: 'op-shared',
    });
    const observer = new FakeKK9Driver(store);
    const status = await observer.getSendStatus('op-shared');

    expect(sent).toMatchObject({ status: 'delivered', messageId: 'shared-native-1' });
    expect(status).toEqual(sent);
    expect(observer.recordedCalls).toHaveLength(0);
  });

  it('同一 operationId 的 fingerprint 冲突仍在发送前拒绝', async () => {
    await driver.sendText('原始内容', {
      targetSessionId: 'session-conflict',
      operationId: 'op-conflict',
    });

    await expect(
      driver.sendText('冲突内容', {
        targetSessionId: 'session-conflict',
        operationId: 'op-conflict',
      })
    ).rejects.toThrow('fingerprint');
    expect(driver.recordedCalls).toHaveLength(1);
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

  it('会话管理与组织架构模拟数据装载', async () => {
    const mockSessions: KK9Session[] = [
      { id: '0-3585', name: 'int2024', type: 'private', unread: false },
      { id: '1-29467', name: '测试123', type: 'group', unread: true, unreadCount: 1 },
    ];
    driver.setSessions(mockSessions);

    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);

    const switched = await driver.selectSession('int2024');
    expect(switched).toBe(true);
    expect(driver.selectSessionCallsCount).toBe(1);

    const markRead = await driver.markSessionRead('测试123');
    expect(markRead).toBe(true);
    expect(driver.markSessionReadCallsCount).toBe(1);

    const mockEmployees: KK9Employee[] = [
      {
        id: 5761,
        name: '董仕林',
        loginName: '0123040139',
        position: 'IT开发工程师',
        updatedAt: Date.now(),
      },
    ];
    driver.setEmployees(mockEmployees);

    const emps = await driver.getOrgEmployees();
    expect(emps).toHaveLength(1);

    const user = await driver.getUserProfile(5761);
    expect(user?.name).toBe('董仕林');

    const fromSesId = await driver.getEmployeeBySession('0-5761');
    expect(fromSesId?.loginName).toBe('0123040139');

    const fromGroup = await driver.getEmployeeBySession('1-29467');
    expect(fromGroup).toBeNull();
  });
});
