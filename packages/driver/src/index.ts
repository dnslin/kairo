/**
 * @kairo/driver
 * 纯净事件驱动的 KK9 Electron 客户端 CDP 驱动
 */

// 顶层抽象接口与驱动实现
export { KK9Driver } from './driver.js';
export { FakeKK9Driver, type FakeSendBehavior, type RecordedSendCall } from './fake-driver.js';

// Bridge 核心操作与事件总线
export { KK9EventBridge } from './bridge/event-bridge.js';
export { BridgeSessionOps } from './bridge/session-ops.js';
export { BridgeMessageOps } from './bridge/message-ops.js';
export { BridgeOrgOps } from './bridge/org-ops.js';
export { callIpcToData, type IpcResponse } from './bridge/rpc.js';
export {
  createMessageIdentityKey,
  normalizeNativeMessage,
  normalizeRecalledEvent,
  extractRecalledEventsFromPayload,
} from './bridge/converter.js';
export type {
  InboundNormalizationDiagnostic,
  NormalizeNativeMessageContext,
  InboundNormalizationSource,
} from './bridge/converter.js';

// 底层 CDP 客户端
export { CdpClient, type CdpClientOptions } from './cdp/client.js';

// 后备 DOM 操作层 (保留以备极窄 UI 场景)
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

// 异常与日志
export { DriverError, CdpError, DomError, SendError } from './utils/errors.js';
export { logger, createChildLogger } from './utils/logger.js';

// 纯净类型系统导出
export type {
  IKK9Driver,
  ConnectionStatus,
  DriverHealthKind,
  CdpConnectionIdentity,
  CdpConnectionLostEvent,
  DriverHealthEvent,
  DriverHealthSnapshot,
  KK9SessionType,
  KK9MessageType,
  KK9MessageOrigin,
  MessageDirection,
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
  CompensationScanOptions,
  DriverConfig,
  EventBridgeConfig,
  SendResult,
  KK9RecalledEvent,
  PreSendCheckResult,
  SendOptions,
  SendFileOptions,
  DriverEvents,
} from './types/index.js';
