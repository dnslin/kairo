import assert from 'node:assert/strict';
import {
  KK9Driver,
  type DriverConfig,
  type DriverEvents,
  type SendOperationStore,
  type SendResult,
} from '@kairo/driver';

/** 仅供授权会话真机验收使用；不改变正式入口的员工准入规则。 */
export function createEnterpriseAnswerDriver(
  config: DriverConfig,
  store: SendOperationStore,
  botUid: string,
  sessionId: string
): KK9Driver {
  const driver = new KK9Driver({ ...config, rejectExistingBridge: true }, store);
  // 发送限制与接收范围一致，避免其他员工触发无权发送的准入提示。
  const emit = driver.emit.bind(driver);
  driver.emit = <K extends keyof DriverEvents>(
    event: K,
    ...args: Parameters<DriverEvents[K]>
  ): boolean => {
    if (event === 'message' || event === 'recalled' || event === 'at') {
      const message = args[0] as { sessionId?: string } | undefined;
      if (message?.sessionId !== sessionId) return false;
    }
    return emit(event, ...args);
  };
  const connect = driver.connect.bind(driver);
  driver.connect = async (): Promise<void> => {
    await connect();
    assert.equal(await driver.getCurrentUserId(), botUid, '本代业务开放前Bot身份不匹配');
  };
  const send = driver.sendText.bind(driver);
  driver.sendText = async (text, options): Promise<SendResult> => {
    assert.equal(await driver.getCurrentUserId(), botUid, '发送前Bot身份不匹配');
    assert.equal(options?.targetSessionId, sessionId, '拒绝向未授权目标发送');
    return send(text, options);
  };
  return driver;
}
