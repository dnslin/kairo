export class WorkAdmissionGateClosedError extends Error {
  readonly startupGenerationId: string;

  constructor(startupGenerationId: string) {
    super(`Work Admission Gate 未开放或已关闭 (启动代次: ${startupGenerationId})，拒绝准入新工作`);
    this.name = 'WorkAdmissionGateClosedError';
    this.startupGenerationId = startupGenerationId;
  }
}

/**
 * 唯一工作准入门（Work Admission Gate）
 * 初始为关闭状态，只有 Ready Barrier 成功后才可开放；
 * 在关闭状态下坚决拒绝任何消息、定时任务或新 Run。
 */
export class WorkAdmissionGate {
  readonly startupGenerationId: string;
  private openState: boolean = false;

  constructor(startupGenerationId: string) {
    this.startupGenerationId = startupGenerationId;
  }

  isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    this.openState = true;
  }

  close(): void {
    this.openState = false;
  }

  assertOpen(): void {
    if (!this.openState) {
      throw new WorkAdmissionGateClosedError(this.startupGenerationId);
    }
  }
}
