import express from 'express';
import type { Request, Response } from 'express';
import type { Server } from 'node:http';
import type { Store } from '../store/index.js';
import type { CdpConnector } from '../cdp/index.js';
import type { Sender } from '../send/index.js';
import type { DomLocator } from '../dom/index.js';
import type { OpsConfig, OperationMode } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';
import { getHtmlPage } from './page.js';

const log = createChildLogger('ops');

export class OpsServerError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'OpsServerError';
    this.originalCause = originalCause;
  }
}

/**
 * OpsServer 运行时依赖上下文
 */
export interface OpsContext {
  /** 数据存储层 */
  store: Store;
  /** CDP 连接器 */
  connector: CdpConnector;
  /** 消息发送器 */
  sender: Sender;
  /** DOM 定位器 */
  locator: DomLocator;
  /** 当前运行模式 */
  mode: OperationMode;
  /** 获取暂停状态 */
  isPaused: () => boolean;
  /** 设置暂停状态 */
  setPaused: (paused: boolean) => void;
  /** 检查当前是否在工作时间 */
  isWithinWorkingHours: () => boolean;
}

/**
 * Web 控制台服务器
 *
 * 提供 API 端点和前端页面，用于系统监控和草稿管理。
 * 默认仅监听 127.0.0.1，确保安全性。
 */
export class OpsServer {
  private server: Server | null = null;
  private readonly app: express.Express;

  constructor(
    private readonly config: OpsConfig,
    private readonly ctx: OpsContext
  ) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    log.debug({ port: config.port, host: config.host }, 'OpsServer 已初始化');
  }

  /**
   * 启动 HTTP 服务器
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, this.config.host, () => {
          log.info(
            { port: this.config.port, host: this.config.host },
            `Web 控制台已启动: http://${this.config.host}:${String(this.config.port)}`
          );
          resolve();
        });

        this.server.on('error', (err: Error) => {
          log.error({ err }, 'HTTP 服务器错误');
          reject(new OpsServerError('HTTP 服务器启动失败', err));
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        reject(new OpsServerError('HTTP 服务器启动失败', err));
      }
    });
  }

  /**
   * 停止 HTTP 服务器
   */
  stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        log.info('Web 控制台已停止');
        this.server = null;
        resolve();
      });
    });
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
  }

  private setupRoutes(): void {
    // 前端页面
    this.app.get('/', (_req: Request, res: Response) => {
      res.type('html').send(getHtmlPage());
    });

    // API 路由
    this.app.get('/api/status', this.handleGetStatus.bind(this));
    this.app.get('/api/drafts', this.handleGetDrafts.bind(this));
    this.app.post('/api/drafts/:id/send', this.handleSendDraft.bind(this));
    this.app.post('/api/drafts/:id/edit', this.handleEditDraft.bind(this));
    this.app.delete('/api/drafts/:id', this.handleDeleteDraft.bind(this));
    this.app.get('/api/logs', this.handleGetLogs.bind(this));
    this.app.post('/api/control/pause', this.handlePause.bind(this));
    this.app.post('/api/control/resume', this.handleResume.bind(this));
  }

  /**
   * GET /api/status - 获取系统状态
   */
  private handleGetStatus(_req: Request, res: Response): void {
    try {
      const status = {
        cdp: this.ctx.connector.getStatus(),
        mode: this.ctx.mode,
        paused: this.ctx.isPaused(),
        withinWorkingHours: this.ctx.isWithinWorkingHours(),
        uptime: this.ctx.connector.getUptime(),
      };
      res.json(status);
    } catch (error) {
      log.error({ err: error }, '获取状态失败');
      res.status(500).json({ error: '获取状态失败' });
    }
  }

  /**
   * GET /api/drafts - 获取待确认草稿列表
   */
  private handleGetDrafts(_req: Request, res: Response): void {
    try {
      const drafts = this.ctx.store.getPendingDrafts();
      res.json(drafts);
    } catch (error) {
      log.error({ err: error }, '获取草稿列表失败');
      res.status(500).json({ error: '获取草稿列表失败' });
    }
  }

  /**
   * POST /api/drafts/:id/send - 发送草稿
   */
  private async handleSendDraft(req: Request, res: Response): Promise<void> {
    const draftId = parseInt(req.params['id'] as string, 10);
    if (isNaN(draftId)) {
      res.status(400).json({ error: '无效的草稿 ID' });
      return;
    }

    try {
      const draft = this.ctx.store.getDraftById(draftId);
      if (!draft) {
        res.status(404).json({ error: '草稿不存在' });
        return;
      }

      if (draft.status !== 'pending') {
        res.status(400).json({ error: `草稿状态无效: ${draft.status}` });
        return;
      }

      // 切换到目标会话
      const selected = await this.ctx.locator.selectSession(draft.sessionId);
      if (!selected) {
        res.status(500).json({ error: '切换会话失败' });
        return;
      }

      // 等待会话切换完成
      await new Promise(resolve => setTimeout(resolve, 500));

      // 发送消息
      const result = await this.ctx.sender.send(draft.draftContent);
      if (!result.success) {
        res.status(500).json({ error: `发送失败: ${result.error ?? '未知错误'}` });
        return;
      }

      // 更新草稿状态
      this.ctx.store.updateDraftStatus(draftId, 'sent');
      this.ctx.store.logEvent('draft_sent', { draftId, sessionId: draft.sessionId });
      log.info({ draftId, sessionId: draft.sessionId }, '草稿已发送');
      res.json({ success: true });
    } catch (error) {
      log.error({ err: error, draftId }, '发送草稿失败');
      res.status(500).json({ error: '发送草稿失败' });
    }
  }

  /**
   * POST /api/drafts/:id/edit - 编辑后发送草稿
   */
  private async handleEditDraft(req: Request, res: Response): Promise<void> {
    const draftId = parseInt(req.params['id'] as string, 10);
    if (isNaN(draftId)) {
      res.status(400).json({ error: '无效的草稿 ID' });
      return;
    }

    const { content } = req.body as { content?: string };
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: '编辑内容不能为空' });
      return;
    }

    try {
      const draft = this.ctx.store.getDraftById(draftId);
      if (!draft) {
        res.status(404).json({ error: '草稿不存在' });
        return;
      }

      if (draft.status !== 'pending') {
        res.status(400).json({ error: `草稿状态无效: ${draft.status}` });
        return;
      }

      // 更新草稿内容
      this.ctx.store.updateDraftContent(draftId, content.trim());

      // 切换到目标会话
      const selected = await this.ctx.locator.selectSession(draft.sessionId);
      if (!selected) {
        res.status(500).json({ error: '切换会话失败' });
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      // 发送编辑后的内容
      const result = await this.ctx.sender.send(content.trim());
      if (!result.success) {
        res.status(500).json({ error: `发送失败: ${result.error ?? '未知错误'}` });
        return;
      }

      // 更新草稿状态
      this.ctx.store.updateDraftStatus(draftId, 'edited_sent');
      this.ctx.store.logEvent('draft_edited_sent', {
        draftId,
        sessionId: draft.sessionId,
        originalContent: draft.draftContent,
        editedContent: content.trim(),
      });
      log.info({ draftId, sessionId: draft.sessionId }, '编辑后草稿已发送');
      res.json({ success: true });
    } catch (error) {
      log.error({ err: error, draftId }, '编辑发送草稿失败');
      res.status(500).json({ error: '编辑发送草稿失败' });
    }
  }

  /**
   * DELETE /api/drafts/:id - 丢弃草稿
   */
  private handleDeleteDraft(req: Request, res: Response): void {
    const draftId = parseInt(req.params['id'] as string, 10);
    if (isNaN(draftId)) {
      res.status(400).json({ error: '无效的草稿 ID' });
      return;
    }

    try {
      const draft = this.ctx.store.getDraftById(draftId);
      if (!draft) {
        res.status(404).json({ error: '草稿不存在' });
        return;
      }

      this.ctx.store.updateDraftStatus(draftId, 'discarded');
      this.ctx.store.logEvent('draft_discarded', { draftId, sessionId: draft.sessionId });
      log.info({ draftId }, '草稿已丢弃');
      res.json({ success: true });
    } catch (error) {
      log.error({ err: error, draftId }, '丢弃草稿失败');
      res.status(500).json({ error: '丢弃草稿失败' });
    }
  }

  /**
   * GET /api/logs - 获取操作日志
   */
  private handleGetLogs(req: Request, res: Response): void {
    try {
      const limit = parseInt(req.query['limit'] as string, 10) || 50;
      const type = req.query['type'] as string | undefined;
      const events = this.ctx.store.getEvents(type, Math.min(limit, 200));
      res.json(events);
    } catch (error) {
      log.error({ err: error }, '获取日志失败');
      res.status(500).json({ error: '获取日志失败' });
    }
  }

  /**
   * POST /api/control/pause - 暂停自动回复
   */
  private handlePause(_req: Request, res: Response): void {
    try {
      this.ctx.setPaused(true);
      this.ctx.store.logEvent('system_paused');
      log.info('自动回复已暂停');
      res.json({ success: true, paused: true });
    } catch (error) {
      log.error({ err: error }, '暂停失败');
      res.status(500).json({ error: '暂停失败' });
    }
  }

  /**
   * POST /api/control/resume - 恢复自动回复
   */
  private handleResume(_req: Request, res: Response): void {
    try {
      this.ctx.setPaused(false);
      this.ctx.store.logEvent('system_resumed');
      log.info('自动回复已恢复');
      res.json({ success: true, paused: false });
    } catch (error) {
      log.error({ err: error }, '恢复失败');
      res.status(500).json({ error: '恢复失败' });
    }
  }
}
