import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import type {
  LayeredPromptResult,
  PromptCompilerOptions,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { PromptCompileError } from '../utils/errors.js';

const log = createChildLogger('layered-prompt-compiler');

/**
 * 内置默认人设与语气准则
 */
export const DEFAULT_SOUL_PROMPT = `# KK9 智能助手基础人设与语气准则
- 角色定位：KK9 企业级即时通讯智能协同助手，服务于企业内部员工与团队日常办公协同。
- 口吻风格：专业、高效、亲和、严谨。使用自然得体的中文进行沟通交流。
- 业务范围：专注于解答企业内部流程规范、系统使用、工单流转、技术支持与办公答疑。
- 会话边界约束：当前处于 1v1 私聊会话环境，严格遵守多租户与多用户物理隔离，严禁跨会话泄露其他员工的私密信息。
- 核心禁忌：严禁承诺未经审批的资金或权限操作；严禁提供虚假系统入口或编造内部政策。`;

/**
 * 4 层结构化 Prompt 编译器
 * 负责组装 Layer 1 (基础人设) ~ Layer 4 (安全防幻觉) 提示词，
 * 并支持通过 chokidar 监听声明式 soul.md 文件的热重载。
 */
export class LayeredPromptCompiler extends EventEmitter {
  private soulPath?: string;
  private soulContent: string;
  private watchSoul: boolean;
  private watcher: FSWatcher | null = null;
  private initialized = false;

  constructor(options?: {
    soulPath?: string;
    defaultSoul?: string;
    watchSoul?: boolean;
  }) {
    super();
    this.soulPath = options?.soulPath;
    this.soulContent = options?.defaultSoul ?? DEFAULT_SOUL_PROMPT;
    this.watchSoul = options?.watchSoul ?? false;
  }

  /**
   * 初始化编译器 (尝试异步读取外部 soul.md 并按需启动监听)
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    if (this.soulPath) {
      try {
        const content = await fs.readFile(this.soulPath, 'utf-8');
        if (content.trim()) {
          this.soulContent = content.trim();
        }
      } catch (err: unknown) {
        log.debug(
          { soulPath: this.soulPath, err },
          '未找到指定的 soul.md 文件或读取失败，使用默认人设预设'
        );
      }

      if (this.watchSoul) {
        this.startWatching();
      }
    }

    this.initialized = true;
  }

  /**
   * 启动 soul.md 文件监听
   */
  public startWatching(): void {
    if (!this.soulPath || this.watcher) return;

    try {
      this.watcher = watch(this.soulPath, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 50,
          pollInterval: 20,
        },
      });

      const handleFileChange = (): void => {
        void (async (): Promise<void> => {
          if (!this.soulPath) return;
          try {
            const newContent = await fs.readFile(this.soulPath, 'utf-8');
            if (newContent.trim()) {
              this.soulContent = newContent.trim();
              log.info({ soulPath: this.soulPath }, 'soul.md 人设文件热重载完成');
              this.emit('prompt_reloaded', {
                soulContent: this.soulContent,
                timestamp: Date.now(),
              });
            }
          } catch (err: unknown) {
            log.warn({ soulPath: this.soulPath, err }, '读取更新后的 soul.md 异常');
          }
        })();
      };

      this.watcher.on('change', handleFileChange);
      this.watcher.on('add', handleFileChange);
    } catch (err: unknown) {
      log.error({ soulPath: this.soulPath, err }, '启动 soul.md 文件监听器失败');
    }
  }

  /**
   * 停止文件监听
   */
  public async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * 是否正在监听文件
   */
  public isWatching(): boolean {
    return this.watcher !== null;
  }

  /**
   * 获取当前人设内容
   */
  public getSoulContent(): string {
    return this.soulContent;
  }

  /**
   * 手动设置人设内容
   */
  public setSoulContent(content: string): void {
    this.soulContent = content.trim();
  }

  /**
   * 结构化编译 4 层完整 System Prompt
   */
  public async compile(
    options?: PromptCompilerOptions
  ): Promise<LayeredPromptResult> {
    if (!this.initialized && this.soulPath) {
      await this.init();
    }

    try {
      // 1. Layer 1: 基础人设
      const layer1 = this.compileLayer1(options?.defaultSoul);

      // 2. Layer 2: 动态运行时上下文 (系统时间、用户偏好)
      const layer2 = this.compileLayer2(options);

      // 3. Layer 3: 组织环境与协同边界
      const layer3 = this.compileLayer3(options);

      // 4. Layer 4: 安全防幻觉与事实依据
      const layer4 = this.compileLayer4(options);

      // 拼接完整 System Prompt
      const fullPrompt = [layer1, layer2, layer3, layer4].join('\n\n');

      return {
        layer1,
        layer2,
        layer3,
        layer4,
        fullPrompt,
      };
    } catch (err: unknown) {
      throw new PromptCompileError(
        `Prompt 编译失败: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
  }

  /**
   * 编译 Layer 1: 基础人设
   */
  private compileLayer1(overrideSoul?: string): string {
    const soul = overrideSoul ?? this.soulContent;
    return `### [Layer 1: 基础人设与核心原则]\n${soul}`;
  }

  /**
   * 编译 Layer 2: 动态上下文
   */
  private compileLayer2(options?: PromptCompilerOptions): string {
    const ts = options?.timestamp ?? new Date();
    const dateStr =
      ts instanceof Date
        ? ts.toISOString().replace('T', ' ').substring(0, 19)
        : typeof ts === 'number'
          ? new Date(ts).toISOString().replace('T', ' ').substring(0, 19)
          : String(ts);

    const lines: string[] = [
      '### [Layer 2: 当前动态运行时上下文]',
      `- 当前系统时间: ${dateStr}`,
    ];

    if (options?.userProfile) {
      const up = options.userProfile;
      if (up.nickname) lines.push(`- 用户称呼偏好: ${up.nickname}`);
      if (up.tonePreference) lines.push(`- 沟通语气偏好: ${up.tonePreference}`);
      if (up.language) lines.push(`- 首选交互语言: ${up.language}`);
      if (up.customPreferences) {
        for (const [k, v] of Object.entries(up.customPreferences)) {
          lines.push(`- 自定义偏好 [${k}]: ${v}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 编译 Layer 3: 组织环境
   */
  private compileLayer3(options?: PromptCompilerOptions): string {
    const lines: string[] = ['### [Layer 3: 提问员工组织环境与协同边界]'];
    const ec = options?.employeeContext;

    if (ec && (ec.name || ec.department || ec.jobTitle || ec.departmentPath)) {
      if (ec.name) lines.push(`- 员工姓名: ${ec.name}`);
      if (ec.employeeId) lines.push(`- 员工工号: ${ec.employeeId}`);
      if (ec.departmentPath) {
        lines.push(`- 所属部门层级: ${ec.departmentPath}`);
      } else if (ec.department) {
        lines.push(`- 所属部门: ${ec.department}`);
      }
      if (ec.jobTitle) lines.push(`- 岗位职务: ${ec.jobTitle}`);
      if (ec.collaborationBoundary) {
        lines.push(`- 工作协同边界: ${ec.collaborationBoundary}`);
      }
    } else {
      lines.push('- 当前用户为企业内部员工，请根据通用内部规范提供协同协助。');
    }

    return lines.join('\n');
  }

  /**
   * 编译 Layer 4: 安全与防幻觉
   */
  private compileLayer4(options?: PromptCompilerOptions): string {
    const lines: string[] = [
      '### [Layer 4: 安全防幻觉与事实依据指令]',
      '- 事实依据强约束：必须严格依据检索召回的事实及工具调用执行结果进行答复，严禁捏造事实、编造未经验证的内部系统地址或虚构流程。',
      '- 防幻觉与转人工规范：若未能检索到相关事实依据，或在当前权限下无法确定准确答案，必须诚实告知“未查询到相关记录”，并友好引导用户联系人工客服或相关责任人，严禁盲目猜测。',
    ];

    if (options?.retrievedFacts) {
      lines.push('\n[检索召回事实依据]:');
      const facts = Array.isArray(options.retrievedFacts)
        ? options.retrievedFacts
        : [options.retrievedFacts];
      for (const fact of facts) {
        lines.push(`* ${fact}`);
      }
    }

    if (options?.customInstructions) {
      lines.push(`\n[自定义扩展指令]:\n${options.customInstructions}`);
    }

    return lines.join('\n');
  }
}
