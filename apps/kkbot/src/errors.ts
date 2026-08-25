// 结构化配置校验错误与类型定义

export interface ConfigFieldError {
  /** 字段路径（如 knowledge.embedding.apiKey） */
  path: string;
  /** 失败原因（中文） */
  reason: string;
  /** 修复建议（中文） */
  hint: string;
  /** 完整可读提示信息 */
  message: string;
}

export class ConfigValidationError extends Error {
  readonly errors: ConfigFieldError[];

  constructor(errors: ConfigFieldError[]) {
    const formatted = errors
      .map(
        (err, idx) =>
          `[${idx + 1}] 字段路径: ${err.path}\n    失败原因: ${err.reason}\n    修复建议: ${err.hint}`
      )
      .join('\n');
    super(`配置静态校验失败，共发现 ${errors.length} 处错误：\n${formatted}`);
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}
