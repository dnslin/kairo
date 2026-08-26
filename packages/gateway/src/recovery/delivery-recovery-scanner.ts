import type { KKBotStore } from '@kkbot/store';
import { type Memory, createMastraTextMessage } from '@kkbot/agent';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('delivery-recovery-scanner');

export interface DeliveryRecoveryOptions {
  store: KKBotStore;
  mastraMemory?: Memory;
}

export interface DeliveryRecoveryReport {
  scannedCount: number;
  inFlightSendingRecovered: number;
  generatedRecovered: number;
  sentUncommittedCommitted: number;
  unknownSkipped: number;
  errors: Array<{ deliveryId: string; error: string }>;
}

/**
 * DeliveryRecoveryScanner
 * 负责系统启动或崩溃重启后的 Delivery 状态检查点恢复扫描
 *
 * 核心契约：
 * 1. Delivery=`sent` 且 memory_committed_at 为 NULL (sent-but-uncommitted): 仅补交 Memory，绝不调用 KK 发送。
 * 2. Delivery=`sending`: 重启后无法证明发送未发生，严格转换为 `unknown` 并进入人工安全路径，绝不自动补发。
 * 3. Delivery=`generated`: 重启发现未进入发送流程的生成结果，安全收敛为 `aborted`。
 * 4. Delivery=`unknown`: 保持人工门禁，不发送、不提交 Memory、不自动裁定。
 * 5. Delivery=`aborted` / `failed`: 不恢复发送。
 * 6. 依赖稳定 ID 与数据库条件更新保证串行与并发扫描的幂等性。
 */
export class DeliveryRecoveryScanner {
  private readonly store: KKBotStore;
  private readonly mastraMemory?: Memory;

  constructor(options: DeliveryRecoveryOptions) {
    this.store = options.store;
    this.mastraMemory = options.mastraMemory;
  }

  /**
   * 执行完整的恢复扫描流程
   */
  public async runRecoveryScan(): Promise<DeliveryRecoveryReport> {
    log.info('开始执行 Delivery 检查点恢复扫描...');
    const report: DeliveryRecoveryReport = {
      scannedCount: 0,
      inFlightSendingRecovered: 0,
      generatedRecovered: 0,
      sentUncommittedCommitted: 0,
      unknownSkipped: 0,
      errors: [],
    };

    // 1. 恢复在途 sending 状态：进程强杀/重启后无法判定是否已发送，安全收敛为 unknown (Fail-Closed)
    await this.recoverInFlightSendingDeliveries(report);

    // 2. 恢复未进入发送的 generated 状态：进程在发送前崩溃，安全收敛为 aborted
    await this.recoverGeneratedDeliveries(report);

    // 3. 补交 sent-but-uncommitted 检查点：仅提交 assistant Memory，绝不重复调用 KK
    await this.recoverSentUncommittedDeliveries(report);

    // 4. 统计已存在的 unknown 记录（跳过自动处理，保持人工门禁）
    await this.recordUnknownDeliveries(report);

    log.info(
      {
        inFlightRecovered: report.inFlightSendingRecovered,
        generatedRecovered: report.generatedRecovered,
        sentCommitted: report.sentUncommittedCommitted,
        unknownSkipped: report.unknownSkipped,
        errorsCount: report.errors.length,
      },
      'Delivery 检查点恢复扫描完成'
    );

    return report;
  }

  /**
   * 恢复处于 sending 状态的 Delivery 为 unknown
   * Fail-Closed 契约：
   * 1. 若查询 in-flight 记录异常，属于致命错误，直接抛出阻断启动。
   * 2. 对每个 sending 记录，若 CAS 更新失败，回读确认是否已离开 sending。
   *    若依然处于 sending 或无法确认，属于致命错误，直接抛出阻断启动！
   */
  private async recoverInFlightSendingDeliveries(report: DeliveryRecoveryReport): Promise<void> {
    let inFlightList;
    try {
      inFlightList = await this.store.deliveries.getInFlightSendingDeliveries();
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause.message }, '查询 in-flight sending 记录发生致命错误，阻断启动');
      throw new Error(`Delivery 恢复扫描查询 in-flight sending 失败: ${cause.message}`, { cause });
    }

    report.scannedCount += inFlightList.length;

    for (const deliv of inFlightList) {
      try {
        await this.store.deliveries.updateStatus(deliv.id, 'unknown', {
          errorCode:
            'RECOVERY_IN_FLIGHT_SENDING_INTERRUPTED: 进程重启发现未确认在途发送，安全进入 unknown',
          updatedAt: Date.now(),
        });
        report.inFlightSendingRecovered++;
        log.warn(
          { deliveryId: deliv.id, sessionId: deliv.sessionId },
          '已将在途 sending Delivery 安全转换为 unknown，等待人工决议'
        );
      } catch (err) {
        // CAS 竞争检查：回读确认是否已被并发进程安全收敛
        const recheck = await this.store.deliveries.getDeliveryById(deliv.id);
        if (recheck && recheck.status !== 'sending') {
          log.info(
            { deliveryId: deliv.id, status: recheck.status },
            '在途 sending Delivery 已由并发恢复进程推进至安全状态'
          );
          continue;
        }

        const cause = err instanceof Error ? err : new Error(String(err));
        log.error(
          { err: cause.message, deliveryId: deliv.id },
          '无法将处于 sending 的 Delivery 转换为安全状态，触发 Fail-Closed 阻断启动'
        );
        throw new Error(
          `Delivery [${deliv.id}] 无法安全退出 sending 状态: ${cause.message}`,
          { cause }
        );
      }
    }
  }

  /**
   * 恢复处于 generated 状态的 Delivery 为 aborted (pre-trigger 崩溃中断)
   */
  private async recoverGeneratedDeliveries(report: DeliveryRecoveryReport): Promise<void> {
    try {
      const generatedList = await this.store.deliveries.getGeneratedDeliveries();
      report.scannedCount += generatedList.length;

      for (const deliv of generatedList) {
        try {
          await this.store.deliveries.updateStatus(deliv.id, 'aborted', {
            errorCode:
              'RECOVERY_GENERATED_INTERRUPTED_ABORTED: 进程重启发现未进入发送流程的生成结果，安全中止',
            updatedAt: Date.now(),
          });
          report.generatedRecovered++;
          log.info(
            { deliveryId: deliv.id, sessionId: deliv.sessionId },
            '已将重启前未进入发送的 generated Delivery 安全转换为 aborted'
          );
        } catch (err) {
          const current = await this.store.deliveries.getDeliveryById(deliv.id);
          if (current && current.status !== 'generated') {
            log.debug({ deliveryId: deliv.id, status: current.status }, '并发进程已推进 generated Delivery 状态');
          } else {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log.error({ err, deliveryId: deliv.id }, '恢复 generated 状态失败');
            report.errors.push({ deliveryId: deliv.id, error: errorMsg });
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err }, '查询 generated 记录异常');
      report.errors.push({ deliveryId: 'system_query_generated', error: errorMsg });
    }
  }

  /**
   * 补交处于 sent 状态但尚未提交 Memory 的 Delivery
   */
  private async recoverSentUncommittedDeliveries(report: DeliveryRecoveryReport): Promise<void> {
    let uncommittedList;
    try {
      uncommittedList = await this.store.deliveries.getSentUncommittedDeliveries();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err }, '查询 sent-but-uncommitted 记录异常');
      report.errors.push({ deliveryId: 'global_sent_uncommitted', error: errorMsg });
      return;
    }

    report.scannedCount += uncommittedList.length;

    if (uncommittedList.length > 0 && !this.mastraMemory) {
      const errorMsg = `发现 ${uncommittedList.length} 条待恢复的 sent-but-uncommitted 交付，但未配置 mastraMemory，阻断启动 (Fail-Closed)`;
      log.error(errorMsg);
      report.errors.push({ deliveryId: 'global_sent_uncommitted', error: errorMsg });
      return;
    }

    if (!this.mastraMemory) {
      log.debug('未配置 mastraMemory 且无待恢复的 sent-but-uncommitted 交付，跳过补交');
      return;
    }

    for (const deliv of uncommittedList) {
      try {
        const thread = await this.mastraMemory.getThreadById({ threadId: deliv.sessionId });
        const resourceId = thread?.resourceId;
        if (!resourceId) {
          const err = new Error(
            `会话 [${deliv.sessionId}] 在 Mastra Memory 中未找到有效 Thread 或 resourceId，保留 sent-but-uncommitted 检查点`
          );
          log.error(
            { err: err.message, deliveryId: deliv.id, sessionId: deliv.sessionId },
            '无法解析权威 resourceId，阻断 Memory 补交'
          );
          report.errors.push({ deliveryId: deliv.id, error: err.message });
          continue;
        }

        const mastraMessageId = deliv.mastraMessageId;
        const asstMsg = createMastraTextMessage({
          id: mastraMessageId,
          role: 'assistant',
          content: deliv.content,
          threadId: deliv.sessionId,
          resourceId,
          createdAt: new Date(deliv.updatedAt || deliv.createdAt),
        });

        await this.mastraMemory.saveMessages({ messages: [asstMsg] });
        const commitRes = await this.store.deliveries.markMemoryCommitted(deliv.id, Date.now());
        if (commitRes.isNewlyCommitted) {
          report.sentUncommittedCommitted++;
        }
        log.info(
          { deliveryId: deliv.id, sessionId: deliv.sessionId, mastraMessageId, resourceId },
          'sent-but-uncommitted 检查点已成功补交 assistant Memory'
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error({ err, deliveryId: deliv.id }, '补交 sent-but-uncommitted Memory 异常');
        report.errors.push({ deliveryId: deliv.id, error: errorMsg });
      }
    }
  }

  /**
   * 统计 unknown 状态的交付记录
   */
  private async recordUnknownDeliveries(report: DeliveryRecoveryReport): Promise<void> {
    try {
      const unknownList = await this.store.deliveries.getUnresolvedUnknownDeliveries();
      report.unknownSkipped += unknownList.length;
      report.scannedCount += unknownList.length;
    } catch (err) {
      log.debug({ err }, '统计 unknown 交付记录异常');
    }
  }
}
