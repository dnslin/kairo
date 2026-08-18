/**
 * @kkbot/driver
 * 纯净事件驱动的 KK9 Electron 客户端 CDP 驱动
 */

export { KK9Driver } from './driver.js';
export { CdpClient } from './cdp/client.js';
export { SessionOps } from './dom/session-ops.js';
export { MessageOps } from './dom/message-ops.js';
export { SendOps } from './dom/send-ops.js';
export { DEFAULT_SELECTORS, resolveSelectors } from './dom/selectors.js';
export { DriverError, CdpError, DomError, SendError } from './utils/errors.js';
export { logger, createChildLogger } from './utils/logger.js';

export type {
  ConnectionStatus,
  KK9SessionType,
  KK9Session,
  KK9Message,
  SelectorsConfig,
  CdpConfig,
  PollingConfig,
  DriverConfig,
  SendResult,
  PreSendCheckResult,
  DriverEvents,
} from './types/index.js';
