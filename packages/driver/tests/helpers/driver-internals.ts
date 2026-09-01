import type { BridgeMessageOps } from '../../src/bridge/message-ops.js';
import type { BridgeOrgOps } from '../../src/bridge/org-ops.js';
import type { BridgeSessionOps } from '../../src/bridge/session-ops.js';
import type { CdpClient } from '../../src/cdp/client.js';
import type { KK9Driver } from '../../src/driver.js';
import type { MessageOps } from '../../src/dom/message-ops.js';
import type { OrgOps } from '../../src/dom/org-ops.js';
import type { SendOps } from '../../src/dom/send-ops.js';
import type { SessionOps } from '../../src/dom/session-ops.js';
import type { KK9RecalledEvent, KK9Session } from '../../src/types/index.js';

interface DriverTestInternalSlots {
  cdp: CdpClient;
  bridgeSessionOps: BridgeSessionOps;
  bridgeMessageOps: BridgeMessageOps;
  bridgeOrgOps: BridgeOrgOps;
  domSessionOps: SessionOps;
  domMessageOps: MessageOps;
  domSendOps: SendOps;
  domOrgOps: OrgOps;
  collectAndEmitMessages(session: KK9Session, limit: number): Promise<void>;
  handleRecalledEvent(event: KK9RecalledEvent): void;
}

export type DriverTestInternals<TOverrides extends object = Record<never, never>> = Omit<
  DriverTestInternalSlots,
  keyof TOverrides
> &
  TOverrides;

/** 测试专用：显式绕过 KK9Driver 的编译期私有边界。 */
export function getDriverTestInternals<TOverrides extends object = Record<never, never>>(
  driver: KK9Driver
): DriverTestInternals<TOverrides> {
  return driver as unknown as DriverTestInternals<TOverrides>;
}

export function getMessageOpsTestInternals<TCdp>(messageOps: MessageOps): { cdp: TCdp } {
  return messageOps as unknown as { cdp: TCdp };
}
