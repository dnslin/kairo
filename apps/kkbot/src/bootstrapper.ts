import { loadConfigFromYaml, type AppConfig } from './config.js';
import { ConfigValidationError } from './errors.js';

export interface BootstrapperOptions {
  /** YAML 配置文件路径 */
  configPath: string;
}

/**
 * KKBot 唯一统一启动器（UnifiedBootstrapper）
 * 负责静态校验、资源编排与生命周期治理。
 */
export class UnifiedBootstrapper {
  private readonly configPath: string;
  private config: AppConfig | null = null;

  constructor(options: BootstrapperOptions) {
    this.configPath = options.configPath;
  }

  /**
   * 执行 Static Validation：仅读取配置与环境变量，不占用进程资源或网络连接。
   */
  async staticValidate(): Promise<AppConfig> {
    const loadedConfig = await loadConfigFromYaml(this.configPath);
    this.config = loadedConfig;
    return loadedConfig;
  }

  /**
   * 获取已加载的配置对象
   */
  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Bootstrapper 尚未完成配置加载与静态校验，请先调用 staticValidate()');
    }
    return this.config;
  }
}

export { ConfigValidationError };
