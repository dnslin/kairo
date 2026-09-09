import type { IKK9Driver, KK9Employee, KK9Message } from '@kairo/driver';
import { toRawMessage } from '../im-transport/driver-adapter.js';
import type { SendService } from '../im-transport/send-service.js';
import { AppError, getErrorType } from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import type { PrivateChatStore, RawMessage } from './types.js';

const IDENTITY_NOTICE_WINDOW_MS = 60_000;
const notices = {
  identity_failed: '暂时无法确认您的员工身份，请稍后重试或联系维护人员',
  not_allowed: '当前功能仍在试用，暂未向你开放',
} as const;

type StoppedStatus =
  | 'outbound'
  | 'unknown'
  | 'duplicate'
  | 'unsupported_session'
  | 'identity_failed'
  | 'not_allowed';

export type IngressResult =
  | { status: 'accepted'; botId: string; message: RawMessage & { employeeId: string } }
  | { status: StoppedStatus };

export interface IngressOptions {
  botId: string;
  employeeAllowlist: readonly string[];
  driver: Pick<IKK9Driver, 'getEmployeeBySession'>;
  store: Pick<
    PrivateChatStore,
    'insertRawMessage' | 'associateEmployee' | 'setProcessingResult' | 'claimNotice'
  >;
  sender: Pick<SendService, 'send'>;
  logger: AppLogger;
}

/** 只交付可信原始消息；不订阅 Driver、不创建上下文，也不消费后续业务。 */
export function createIngress(
  options: IngressOptions
): (message: KK9Message) => Promise<IngressResult> {
  const { botId, driver, store, sender, logger } = options;
  const allowlist = new Set(options.employeeAllowlist);

  return async message => {
    if (message.direction === 'outbound') return { status: 'outbound' };
    const key = { sessionId: message.sessionId, messageId: message.id };
    if (message.direction === 'unknown') {
      logger.warn({ event: '运行状态', ...key, status: 'unknown', errorType: 'driver' });
      return { status: 'unknown' };
    }

    const input = toRawMessage(message, Date.now());
    const sessionType = message.sessionType;
    async function record(status: 'accepted' | StoppedStatus): Promise<void> {
      if (!(await store.setProcessingResult(key, status))) {
        throw new AppError('storage', { cause: new Error('入站处理结果未能关联原始消息') });
      }
    }
    async function notify(type: keyof typeof notices): Promise<void> {
      await sender.send({
        subject: { kind: 'event', botId, ...key },
        purpose: `notice:${type}`,
        text: notices[type],
      });
    }

    try {
      const saved = await store.insertRawMessage(input);
      if (!saved.inserted) return { status: 'duplicate' };

      // 不 trim；负向前瞻要求真正的字符串结尾，拒绝 $ 会放过的末尾换行。
      const uid = /^0-([0-9]+)(?![\s\S])/.exec(key.sessionId)?.[1];
      if (sessionType !== 'private' || uid === undefined) {
        await record('unsupported_session');
        logger.warn({ event: '运行状态', ...key, status: 'unknown', errorType: 'identity' });
        return { status: 'unsupported_session' };
      }

      let employee: KK9Employee | null;
      try {
        employee = await driver.getEmployeeBySession(key.sessionId);
      } catch (cause) {
        throw new AppError('driver', { cause });
      }
      if (employee === null || String(employee.id) !== uid) {
        await record('identity_failed');
        logger.warn({ event: '运行失败', ...key, status: 'failed', errorType: 'identity' });
        const now = Date.now();
        // 先占用持久窗口；发送失败也不退还，重启不会重新获得提示机会。
        if (
          await store.claimNotice(
            { botId, sessionId: key.sessionId, noticeType: 'identity_failed' },
            now,
            now + IDENTITY_NOTICE_WINDOW_MS
          )
        ) {
          await notify('identity_failed');
        }
        return { status: 'identity_failed' };
      }

      const employeeId = String(employee.id);
      if (!(await store.associateEmployee(key, employeeId))) {
        throw new AppError('storage', { cause: new Error('可信员工未能关联原始消息') });
      }
      if (!allowlist.has(employeeId)) {
        await record('not_allowed');
        await notify('not_allowed');
        return { status: 'not_allowed' };
      }

      await record('accepted');
      return {
        status: 'accepted',
        botId,
        message: { ...saved.message, employeeId, processingResult: 'accepted' },
      };
    } catch (error) {
      logger.error({ event: '运行失败', ...key, errorType: getErrorType(error, 'storage') });
      throw error;
    }
  };
}
