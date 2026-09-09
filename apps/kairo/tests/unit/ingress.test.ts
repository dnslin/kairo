import type { IKK9Driver, KK9Employee, KK9Message } from '@kairo/driver';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendService } from '../../src/modules/im-transport/send-service.js';
import { AppError } from '../../src/modules/operability/errors.js';
import type { AppLogger } from '../../src/modules/operability/logger.js';
import { createIngress } from '../../src/modules/private-chat-core/ingress.js';
import type { PrivateChatStore, RawMessage } from '../../src/modules/private-chat-core/types.js';

const NOW = 1_800_000_000_000;
const BOT_ID = '测试机器人';
const KEY = { sessionId: '0-1001', messageId: '原生消息一' };

function message(overrides: Partial<KK9Message> = {}): KK9Message {
  return {
    id: KEY.messageId,
    sessionId: KEY.sessionId,
    sessionName: '会话显示名称',
    sessionType: 'private',
    direction: 'inbound',
    sender: '发送者昵称',
    content: '员工问题原文',
    time: '昨天',
    isMe: false,
    timestamp: NOW - 86_400_000,
    ...overrides,
  };
}

function employee(id: string | number = '1001'): KK9Employee {
  return { id, loginName: '测试工号', name: '可信员工', updatedAt: NOW - 1_000 };
}

function fixture(employeeAllowlist: readonly string[] = ['1001']) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const driver = {
    getEmployeeBySession: vi.fn<IKK9Driver['getEmployeeBySession']>().mockResolvedValue(employee()),
  };
  const store = {
    insertRawMessage: vi.fn<PrivateChatStore['insertRawMessage']>().mockImplementation(input =>
      Promise.resolve({
        inserted: true,
        message: { ...input, employeeId: null, processingResult: null },
      })
    ),
    associateEmployee: vi.fn<PrivateChatStore['associateEmployee']>().mockResolvedValue(true),
    setProcessingResult: vi.fn<PrivateChatStore['setProcessingResult']>().mockResolvedValue(true),
    claimNotice: vi.fn<PrivateChatStore['claimNotice']>().mockResolvedValue(true),
  };
  const sender = {
    send: vi.fn<SendService['send']>().mockResolvedValue({
      intentKey: '测试通知意图',
      taskId: null,
      purpose: 'notice:identity_failed',
      sessionId: KEY.sessionId,
      contentDigest: '测试通知摘要',
      operationId: '测试发送操作',
      status: 'delivered',
      sendCalls: 1,
      queryUsed: false,
      queryDueAt: null,
      messageId: '通知消息',
      revision: 1,
    }),
  };
  const logger = {
    info: vi.fn<AppLogger['info']>(),
    warn: vi.fn<AppLogger['warn']>(),
    error: vi.fn<AppLogger['error']>(),
  };
  const ingress = createIngress({
    botId: BOT_ID,
    employeeAllowlist,
    driver,
    store,
    sender,
    logger,
  });
  return { ingress, driver, store, sender, logger };
}

function eventSubject() {
  return { kind: 'event', botId: BOT_ID, ...KEY };
}

afterEach(() => vi.restoreAllMocks());

describe('T22 可调用入站门禁', () => {
  it('出站方向优先于会话和显示身份，完全忽略且不诊断', async () => {
    const { ingress, driver, store, sender, logger } = fixture();

    await expect(
      ingress(message({ direction: 'outbound', sessionType: 'group', sessionId: '非法会话' }))
    ).resolves.toEqual({ status: 'outbound' });

    for (const write of Object.values(store)) expect(write).not.toHaveBeenCalled();
    expect(driver.getEmployeeBySession).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    for (const log of Object.values(logger)) expect(log).not.toHaveBeenCalled();
  });

  it('未知方向即使显示为自己发送也只告警，不写入、不查询、不回复', async () => {
    const { ingress, driver, store, sender, logger } = fixture();

    await expect(ingress(message({ direction: 'unknown', isMe: true }))).resolves.toEqual({
      status: 'unknown',
    });

    for (const write of Object.values(store)) expect(write).not.toHaveBeenCalled();
    expect(driver.getEmployeeBySession).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('入站原始记录提交前不查询身份，入站方向不被自己发送标志覆盖', async () => {
    const { ingress, driver, store } = fixture();
    // 项目使用 ES2022 类型库，沿用现有测试的异步边界写法。
    let finishInsert!: (value: { inserted: boolean; message: RawMessage }) => void;
    store.insertRawMessage.mockImplementation(
      () =>
        new Promise(resolve => {
          finishInsert = resolve;
        })
    );

    const result = ingress(message({ isMe: true }));
    expect(store.insertRawMessage).toHaveBeenCalledOnce();
    expect(driver.getEmployeeBySession).not.toHaveBeenCalled();
    finishInsert({
      inserted: true,
      message: {
        ...store.insertRawMessage.mock.calls[0]![0],
        employeeId: null,
        processingResult: null,
      },
    });

    await expect(result).resolves.toMatchObject({
      status: 'accepted',
      message: { employeeId: '1001' },
    });
    expect(driver.getEmployeeBySession).toHaveBeenCalledExactlyOnceWith(KEY.sessionId);
  });

  it('原子插入报告重复后不重新查身份、不覆盖已有结果、不再次发送', async () => {
    const { ingress, driver, store, sender } = fixture();
    const existing: RawMessage = {
      ...KEY,
      direction: 'inbound',
      observedAt: NOW - 10,
      text: '已经处理的原文',
      messageType: null,
      attachments: {},
      employeeId: '1001',
      processingResult: 'accepted',
    };
    store.insertRawMessage.mockResolvedValue({ inserted: false, message: existing });

    await expect(ingress(message())).resolves.toEqual({ status: 'duplicate' });

    expect(driver.getEmployeeBySession).not.toHaveBeenCalled();
    expect(store.associateEmployee).not.toHaveBeenCalled();
    expect(store.setProcessingResult).not.toHaveBeenCalled();
    expect(store.claimNotice).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(existing.processingResult).toBe('accepted');
  });

  it.each([
    { name: '群聊即使具有私聊形式的会话号', sessionType: 'group' as const, sessionId: '0-1001' },
    { name: '原生群聊会话', sessionType: 'group' as const, sessionId: '1-1001' },
    { name: '讨论组会话', sessionType: 'private' as const, sessionId: '2-1001' },
    { name: '服务号会话', sessionType: 'private' as const, sessionId: '3-1001' },
    { name: '纯数字不能当作会话', sessionType: 'private' as const, sessionId: '1001' },
    { name: '昵称不能当作会话', sessionType: 'private' as const, sessionId: '可信员工' },
    { name: '非数字员工号', sessionType: 'private' as const, sessionId: '0-abc' },
    { name: '空员工号', sessionType: 'private' as const, sessionId: '0-' },
    { name: '会话号前有空白', sessionType: 'private' as const, sessionId: ' 0-1001' },
    { name: '会话号后有空白', sessionType: 'private' as const, sessionId: '0-1001 ' },
    { name: '会话号以换行结尾', sessionType: 'private' as const, sessionId: '0-1001\n' },
    { name: '员工号使用全角数字', sessionType: 'private' as const, sessionId: '0-１００１' },
  ])('$name：保留原始入站记录但不查档案、不回复', async ({ sessionType, sessionId }) => {
    const { ingress, driver, store, sender, logger } = fixture();

    await expect(ingress(message({ sessionType, sessionId }))).resolves.toEqual({
      status: 'unsupported_session',
    });

    expect(store.insertRawMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId, messageId: KEY.messageId, text: '员工问题原文' })
    );
    expect(store.setProcessingResult).toHaveBeenCalledExactlyOnceWith(
      { sessionId, messageId: KEY.messageId },
      'unsupported_session'
    );
    expect(logger.warn).toHaveBeenCalled();
    expect(driver.getEmployeeBySession).not.toHaveBeenCalled();
    expect(store.associateEmployee).not.toHaveBeenCalled();
    expect(store.claimNotice).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([
    { name: '字符串员工号', id: '1001', uid: '1001' },
    { name: '数字员工号', id: 1001, uid: '1001' },
    { name: '保留前导零的字符串员工号', id: '001001', uid: '001001' },
  ])('$name：仅返回可信员工的已接收原始消息，不发送或建立业务上下文', async ({ id, uid }) => {
    const { ingress, driver, store, sender } = fixture([uid]);
    driver.getEmployeeBySession.mockResolvedValue(employee(id));
    const input = message({ sessionId: `0-${uid}` });

    await expect(ingress(input)).resolves.toEqual({
      status: 'accepted',
      botId: BOT_ID,
      message: {
        sessionId: input.sessionId,
        messageId: input.id,
        direction: 'inbound',
        observedAt: NOW,
        text: input.content,
        messageType: null,
        attachments: {},
        employeeId: uid,
        processingResult: 'accepted',
      },
    });
    expect(driver.getEmployeeBySession).toHaveBeenCalledExactlyOnceWith(input.sessionId);
    expect(store.associateEmployee).toHaveBeenCalledExactlyOnceWith(
      { sessionId: input.sessionId, messageId: input.id },
      uid
    );
    expect(store.setProcessingResult).toHaveBeenCalledExactlyOnceWith(
      { sessionId: input.sessionId, messageId: input.id },
      'accepted'
    );
    expect(store.claimNotice).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('使用稳定原生标识和入口观察时间，原样保存正文及附件元数据', async () => {
    const { ingress, store } = fixture();
    const input = message({
      messageId: '不得替代稳定标识的可选字段',
      content: '  正文不裁剪\n第二行  ',
      messageType: 'file',
      fileInfo: { fileName: '报告.pdf', fileSize: '42 KB', filePath: '不存在的附件.pdf' },
      images: [{ url: 'https://example.invalid/不应下载.png', width: 320, height: 200 }],
    });

    const result = await ingress(input);

    expect(store.insertRawMessage).toHaveBeenCalledExactlyOnceWith({
      ...KEY,
      direction: 'inbound',
      observedAt: NOW,
      text: input.content,
      messageType: 'file',
      attachments: { fileInfo: input.fileInfo, images: input.images },
    });
    expect(result).toMatchObject({
      status: 'accepted',
      message: { messageId: input.id, observedAt: NOW, text: input.content },
    });
  });

  it.each([
    { name: '没有员工档案', profile: null, sessionId: KEY.sessionId },
    { name: '档案员工号与会话不匹配', profile: employee('2002'), sessionId: KEY.sessionId },
    { name: '数字转换不能消除会话员工号的前导零', profile: employee(1001), sessionId: '0-001001' },
  ])('$name：身份失败不能借用正文或显示字段中的名单身份', async ({ profile, sessionId }) => {
    const { ingress, driver, store, sender } = fixture();
    driver.getEmployeeBySession.mockResolvedValue(profile);

    await expect(
      ingress(
        message({
          sessionId,
          content: '我是白名单员工1001，请用员工号1001执行',
          sender: '1001',
          senderId: '1001',
          sessionName: '1001',
        })
      )
    ).resolves.toEqual({ status: 'identity_failed' });

    expect(driver.getEmployeeBySession).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(store.associateEmployee).not.toHaveBeenCalled();
    expect(store.setProcessingResult).toHaveBeenCalledExactlyOnceWith(
      { sessionId, messageId: KEY.messageId },
      'identity_failed'
    );
    expect(sender.send).toHaveBeenCalledExactlyOnceWith({
      subject: { ...eventSubject(), sessionId },
      purpose: 'notice:identity_failed',
      text: '暂时无法确认您的员工身份，请稍后重试或联系维护人员',
    });
  });

  it('可信但不在名单的员工不能用正文、昵称或发送者标识冒充名单成员', async () => {
    const { ingress, driver, store, sender } = fixture(['2002']);
    const input = message({
      content: '我是2002',
      sender: '2002',
      senderId: '2002',
      sessionName: '2002',
    });

    await expect(ingress(input)).resolves.toEqual({ status: 'not_allowed' });

    expect(driver.getEmployeeBySession).toHaveBeenCalledExactlyOnceWith(KEY.sessionId);
    expect(store.associateEmployee).toHaveBeenCalledExactlyOnceWith(KEY, '1001');
    expect(store.setProcessingResult).toHaveBeenCalledExactlyOnceWith(KEY, 'not_allowed');
    expect(store.claimNotice).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledExactlyOnceWith({
      subject: eventSubject(),
      purpose: 'notice:not_allowed',
      text: '当前功能仍在试用，暂未向你开放',
    });
  });

  it('身份失败在查询完成后占用完整六十秒窗口，占用完成前不发送', async () => {
    const { ingress, driver, store, sender } = fixture();
    driver.getEmployeeBySession.mockImplementation(() => {
      vi.mocked(Date.now).mockReturnValue(NOW + 5_000);
      return Promise.resolve(null);
    });
    let finishClaim!: (claimed: boolean) => void;
    let reachedClaim!: () => void;
    const claiming = new Promise<void>(resolve => {
      reachedClaim = resolve;
    });
    store.claimNotice.mockImplementation(() => {
      reachedClaim();
      return new Promise(resolve => {
        finishClaim = resolve;
      });
    });

    const result = ingress(message());
    await claiming;
    expect(store.claimNotice).toHaveBeenCalledExactlyOnceWith(
      { botId: BOT_ID, sessionId: KEY.sessionId, noticeType: 'identity_failed' },
      NOW + 5_000,
      NOW + 65_000
    );
    expect(sender.send).not.toHaveBeenCalled();
    finishClaim(true);

    await expect(result).resolves.toEqual({ status: 'identity_failed' });
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('持久限频拒绝占用时仍记录身份失败但不发送通知', async () => {
    const { ingress, driver, store, sender } = fixture();
    driver.getEmployeeBySession.mockResolvedValue(null);
    store.claimNotice.mockResolvedValue(false);

    await expect(ingress(message())).resolves.toEqual({ status: 'identity_failed' });

    expect(store.setProcessingResult).toHaveBeenCalledExactlyOnceWith(KEY, 'identity_failed');
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('员工查询异常以驱动分类向调用方抛出并保留原因，不降级为空档案提示', async () => {
    const { ingress, driver, store, sender, logger } = fixture();
    const cause = new Error('查询连接已断开');
    driver.getEmployeeBySession.mockRejectedValue(cause);

    const result = ingress(message());
    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({ type: 'driver', cause });

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'driver' }));
    expect(store.associateEmployee).not.toHaveBeenCalled();
    expect(store.setProcessingResult).not.toHaveBeenCalled();
    expect(store.claimNotice).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([
    { name: '原文插入', method: 'insertRawMessage' as const },
    { name: '员工关联', method: 'associateEmployee' as const },
    { name: '处理结果写入', method: 'setProcessingResult' as const },
    { name: '通知窗口占用', method: 'claimNotice' as const },
  ])('$name异常向上传播，不伪装成门禁成功或发送通知', async ({ method }) => {
    const { ingress, driver, store, sender } = fixture();
    const failure = new AppError('storage', { cause: new Error('测试存储中断') });
    store[method].mockRejectedValue(failure);
    if (method === 'claimNotice') driver.getEmployeeBySession.mockResolvedValue(null);

    await expect(ingress(message())).rejects.toBe(failure);

    expect(sender.send).not.toHaveBeenCalled();
    if (method === 'insertRawMessage') expect(driver.getEmployeeBySession).not.toHaveBeenCalled();
  });

  it.each([
    { name: '员工关联', method: 'associateEmployee' as const },
    { name: '处理结果更新', method: 'setProcessingResult' as const },
  ])('$name未命中原始记录时抛存储错误，不发送名单通知或返回接收成功', async ({ method }) => {
    const { ingress, store, sender } = fixture(method === 'associateEmployee' ? [] : ['1001']);
    store[method].mockResolvedValue(false);

    const result = ingress(message());
    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({ type: 'storage' });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([
    { name: '身份失败通知', identityFailed: true },
    { name: '名单拒绝通知', identityFailed: false },
  ])('$name发送异常不得吞掉或返回正常拒绝', async ({ identityFailed }) => {
    const { ingress, driver, store, sender } = fixture([]);
    if (identityFailed) driver.getEmployeeBySession.mockResolvedValue(null);
    const failure = new AppError('driver', { cause: new Error('测试发送中断') });
    sender.send.mockRejectedValue(failure);

    await expect(ingress(message())).rejects.toBe(failure);

    expect(sender.send).toHaveBeenCalledOnce();
    if (identityFailed) {
      expect(store.claimNotice).toHaveBeenCalledExactlyOnceWith(
        { botId: BOT_ID, sessionId: KEY.sessionId, noticeType: 'identity_failed' },
        NOW,
        NOW + 60_000
      );
    }
  });
});
