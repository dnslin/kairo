/**
 * @kkbot/driver
 * 纯净事件驱动的 KK9 Electron 客户端 CDP 驱动
 */

export { KK9Driver } from './driver.js';
export { KK9EventBridge } from './bridge/event-bridge.js';
export {
  generateMessageFingerprint,
  normalizeNativeMessage,
  normalizeRecalledEvent,
} from './bridge/converter.js';
export { CdpClient } from './cdp/client.js';
export { SessionOps } from './dom/session-ops.js';
export { MessageOps, readImageAsBase64, saveImageToFile } from './dom/message-ops.js';
export { SendOps } from './dom/send-ops.js';
export { OrgOps, parseEmployee, parseEmployeeList } from './dom/org-ops.js';
export {
  escapeHtml,
  styleToCss,
  hexToKkBgrColor,
  formatSegmentsToHtml,
  markdownToKKHtml,
  formattedTextToHtml,
  parseFormattedTextToKK,
} from './dom/rich-text.js';
export { DEFAULT_SELECTORS, resolveSelectors } from './dom/selectors.js';
export { DriverError, CdpError, DomError, SendError } from './utils/errors.js';
export { logger, createChildLogger } from './utils/logger.js';

export type {
  ConnectionStatus,
  KK9SessionType,
  KK9MessageType,
  TextStyle,
  TextSegment,
  FormattedText,
  KK9ReplyTarget,
  KK9ReplyInfo,
  KK9MentionInfo,
  KK9MentionTarget,
  KK9FileInfo,
  KK9ImageInfo,
  KK9Session,
  KK9Message,
  KK9Employee,
  SelectorsConfig,
  CdpConfig,
  PollingConfig,
  DriverConfig,
  EventBridgeConfig,
  EventBridgeEvents,
  SendResult,
  KK9RecalledEvent,
  PreSendCheckResult,
  SendOptions,
  SendFileOptions,
  DriverEvents,
} from './types/index.js';
