import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  CARD_THEMES,
  DEFAULT_RENDER_OPTIONS,
  buildCanvasCardScript,
  calculateCardLayout,
  renderCardToBase64,
  resolveCardTheme,
} from '../src/canvas/renderer.js';
import type { CardData, CardThemeCustom, RenderCanvasOptions } from '../src/types/index.js';
import { DriverError } from '../src/utils/errors.js';

describe('Canvas 视觉卡片渲染引擎测试 (Canvas Card Engine)', () => {
  describe('主题色解析 (resolveCardTheme)', () => {
    it('应正确解析内置预设主题', () => {
      const primary = resolveCardTheme('primary');
      expect(primary.type).toBe('primary');
      expect(primary.gradientStart).toBe(CARD_THEMES.primary.gradientStart);
      expect(primary.gradientEnd).toBe(CARD_THEMES.primary.gradientEnd);

      const success = resolveCardTheme('success');
      expect(success.type).toBe('success');
      expect(success.accentColor).toBe('#00B42A');

      const warning = resolveCardTheme('warning');
      expect(warning.type).toBe('warning');
      expect(warning.accentColor).toBe('#FF7D00');

      const danger = resolveCardTheme('danger');
      expect(danger.type).toBe('danger');
      expect(danger.accentColor).toBe('#F53F3F');

      const info = resolveCardTheme('info');
      expect(info.type).toBe('info');
      expect(info.gradientStart).toBe(CARD_THEMES.info.gradientStart);
    });

    it('缺省或未识别主题时应优雅回退为 primary 主题', () => {
      const def = resolveCardTheme(undefined);
      expect(def.type).toBe('primary');
      expect(def.gradientStart).toBe('#165DFF');

      // @ts-expect-error 测试非法主题参数降级
      const unknown = resolveCardTheme('unknown_theme');
      expect(unknown.type).toBe('primary');
    });

    it('应支持自定义卡片主题配置 (CardThemeCustom)', () => {
      const custom: CardThemeCustom = {
        gradientStart: '#722ED1',
        gradientEnd: '#391085',
        accentColor: '#9254DE',
        tagBg: 'rgba(255, 255, 255, 0.25)',
        tagColor: '#FFFFFF',
      };
      const resolved = resolveCardTheme(custom);
      expect(resolved.type).toBe('custom');
      expect(resolved.gradientStart).toBe('#722ED1');
      expect(resolved.gradientEnd).toBe('#391085');
      expect(resolved.accentColor).toBe('#9254DE');
      expect(resolved.textColor).toBe('#FFFFFF');
    });
  });

  describe('卡片尺寸与布局边界计算 (calculateCardLayout)', () => {
    it('应正确计算基础卡片尺寸与默认高度', () => {
      const card: CardData = {
        header: {
          title: '基础测试卡片',
        },
      };
      const layout = calculateCardLayout(card);
      expect(layout.width).toBe(DEFAULT_RENDER_OPTIONS.width);
      expect(layout.dpr).toBe(DEFAULT_RENDER_OPTIONS.dpr);
      expect(layout.headerHeight).toBeGreaterThanOrEqual(56);
      expect(layout.height).toBeGreaterThan(layout.headerHeight);
    });

    it('应根据字段行数和跨度动态增长高度', () => {
      const simpleCard: CardData = {
        header: { title: '简单卡片' },
        fields: [{ label: '状态', value: '正常' }],
      };
      const complexCard: CardData = {
        header: { title: '复杂卡片', subtitle: '审批中心' },
        fields: [
          { label: '工单编号', value: 'TASK-1001', span: 1 },
          { label: '发起人', value: '张三', span: 1 },
          { label: '审批内容', value: '申请开放防火墙端口 8080 到生产环境', span: 2 },
          { label: '风险等级', value: '高风险', danger: true },
        ],
        actions: [
          { text: '同意', variant: 'success' },
          { text: '拒绝', variant: 'danger' },
        ],
        footer: '提示：请在 15 分钟内回复',
      };

      const simpleLayout = calculateCardLayout(simpleCard);
      const complexLayout = calculateCardLayout(complexCard);

      expect(complexLayout.height).toBeGreaterThan(simpleLayout.height);
      expect(complexLayout.actionsHeight).toBeGreaterThan(0);
      expect(complexLayout.footerHeight).toBeGreaterThan(0);
    });

    it('应支持自定义选项覆盖 width 和 dpr', () => {
      const card: CardData = {
        header: { title: '自定义尺寸卡片' },
      };
      const customOptions: RenderCanvasOptions = {
        width: 520,
        dpr: 3,
        padding: 24,
      };
      const layout = calculateCardLayout(card, customOptions);
      expect(layout.width).toBe(520);
      expect(layout.dpr).toBe(3);
    });
  });

  describe('Canvas 绘制脚本生成器 (buildCanvasCardScript)', () => {
    it('参数为空或缺失 header 时应抛出 DriverError', () => {
      // @ts-expect-error 故意传递非法参数
      expect(() => buildCanvasCardScript(null)).toThrow(DriverError);
      // @ts-expect-error 缺失 header
      expect(() => buildCanvasCardScript({})).toThrow(DriverError);
    });

    it('应生成自包含的 IIFE JavaScript 绘制脚本', () => {
      const card: CardData = {
        theme: 'primary',
        header: {
          icon: '🛡️',
          subtitle: 'KKBot 智能审批中心',
          title: '生产集群数据库索引重构',
          tag: { text: '待处理', variant: 'warning' },
        },
        fields: [
          { label: '工单编号', value: 'TASK-20260819-01' },
          { label: '发起系统', value: '@kkbot/agent 决策微内核' },
          { label: '风险等级', value: '🚨 P1 极高风险', danger: true },
        ],
        actions: [
          { text: '✔ 确认授权执行', replyCommand: '回复 1', variant: 'success' },
          { text: '✖ 拒绝驳回操作', replyCommand: '回复 2', variant: 'danger' },
        ],
        footer: {
          icon: '💡',
          text: '提示：本消息为智能卡片，请直接在会话中回复数字完成决策',
        },
      };

      const script = buildCanvasCardScript(card);

      expect(typeof script).toBe('string');
      expect(script).toContain('(() => {');
      expect(script).toContain('document.createElement(\'canvas\')');
      expect(script).toContain('toDataURL(\'image/png\')');
      expect(script).toContain('TASK-20260819-01');
      expect(script).toContain('生产集群数据库索引重构');
      expect(script).toContain('确认授权执行');
    });

    it('生成的脚本应在沙箱 Mock Canvas 环境中正常执行且无异常', () => {
      const card: CardData = {
        theme: 'danger',
        header: {
          icon: '🚨',
          title: '生产服务熔断告警',
          subtitle: '监控告警中心',
          tag: { text: 'CRITICAL', variant: 'danger' },
        },
        fields: [
          { label: '告警服务', value: 'payment-gateway-service', highlight: true },
          { label: '错误率', value: '88.4% (超阈值 5%)', danger: true },
          { label: '故障详情', value: '第三方网关接口超时达到阈值，触发熔断降级策略，请及时排查网络链路与下游可用性。', span: 'full' },
        ],
        actions: [
          { text: '立即切流', variant: 'danger', replyCommand: '1' },
          { text: '静音 15 分钟', variant: 'secondary', replyCommand: '2' },
        ],
        footer: '告警时间：2026-08-20 10:30:00',
      };

      const script = buildCanvasCardScript(card, { width: 480, dpr: 2 });

      // 在 Node.js 测试环境中模拟浏览器 DOM & Canvas 2D 上下文
      const fillTextCalls: string[] = [];
      const strokeCalls: string[] = [];
      const gradientStops: Array<{ offset: number; color: string }> = [];

      const mockCtx = {
        save: vi.fn(),
        restore: vi.fn(),
        scale: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(),
        roundRect: vi.fn(),
        clip: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(() => strokeCalls.push('stroke')),
        fillRect: vi.fn(),
        fillText: vi.fn((text: string) => fillTextCalls.push(text)),
        measureText: vi.fn((text: string) => ({
          width: text.length * 8,
          actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 2,
        })),
        createLinearGradient: vi.fn(() => ({
          addColorStop: (offset: number, color: string) => {
            gradientStops.push({ offset, color });
          },
        })),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        shadowColor: '',
        shadowBlur: 0,
        shadowOffsetY: 0,
      };

      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn((type: string) => (type === '2d' ? mockCtx : null)),
        toDataURL: vi.fn((format: string) => `data:${format};base64,MOCK_BASE64_IMAGE_DATA`),
      };

      // 构造沙箱执行环境
      const mockDocument = {
        createElement: (tag: string) => (tag === 'canvas' ? mockCanvas : null),
      };
      const result = vm.runInNewContext(script, { document: mockDocument }) as string;

      expect(result).toBe('data:image/png;base64,MOCK_BASE64_IMAGE_DATA');
      expect(mockCtx.scale).toHaveBeenCalledWith(2, 2);
      expect(mockCanvas.width).toBe(480 * 2);
      expect(mockCanvas.height).toBeGreaterThan(200);

      // 验证文本都被绘制到了画布上
      const allRenderedText = fillTextCalls.join(' ');
      expect(allRenderedText).toContain('生产服务熔断告警');
      expect(allRenderedText).toContain('payment-gateway-service');
      expect(allRenderedText).toContain('88.4%');
      expect(allRenderedText).toContain('立即切流');
      expect(allRenderedText).toContain('告警时间');
    });

    it('在不支持原生 roundRect 的旧版浏览器环境中应自动降级至 arcTo 绘制', () => {
      const card: CardData = {
        theme: 'success',
        header: {
          title: '构建部署成功',
          subtitle: 'CI/CD Pipeline',
          tag: { text: 'PASSED', variant: 'success' },
        },
        fields: [
          { label: '构建分支', value: 'release/v2.1.0' },
          { label: '耗时', value: '1m 24s' },
        ],
        actions: [
          { text: '查看日志', variant: 'outline' },
        ],
        footer: {
          text: '系统自动生成，无需回复',
          align: 'left',
        },
      };

      const script = buildCanvasCardScript(card, { shadow: false });
      const arcToCalls: number[] = [];

      const mockCtx = {
        save: vi.fn(),
        restore: vi.fn(),
        scale: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(() => arcToCalls.push(1)),
        clip: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
      };

      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
        toDataURL: vi.fn(() => 'data:image/png;base64,ARCTO_FALLBACK_OK'),
      };

      const result = vm.runInNewContext(script, {
        document: { createElement: () => mockCanvas },
      }) as string;

      expect(result).toBe('data:image/png;base64,ARCTO_FALLBACK_OK');
      expect(arcToCalls.length).toBeGreaterThan(0);
    });

    it('应支持 3 个及以上按钮的栅格排版与右对齐页脚', () => {
      const card: CardData = {
        header: {
          title: '超长标题测试：这是一条非常非常长的标题文本，用来测试标题过长时的自动截断与省略号处理机制是否正常生效',
        },
        fields: [
          { label: '多行文本', value: '第一行内容\n第二行内容\n第三行内容', span: 'full' },
        ],
        actions: [
          { text: '操作 A', variant: 'primary', replyCommand: 'A' },
          { text: '操作 B', variant: 'warning', replyCommand: 'B' },
          { text: '操作 C', variant: 'danger', replyCommand: 'C' },
        ],
        footer: {
          icon: '🕒',
          text: '2026-08-20',
          align: 'right',
        },
      };

      const script = buildCanvasCardScript(card);
      expect(script).toContain('操作 A');
      expect(script).toContain('操作 B');
      expect(script).toContain('操作 C');
    });
  });

  describe('CDP 运行时远程执行 (renderCardToBase64)', () => {
    it('应通过 CDP evaluate 执行生成的脚本并返回 Base64', async () => {
      const mockEvaluate = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...');
      const mockCdp = {
        evaluate: mockEvaluate,
      };

      const card: CardData = {
        header: { title: 'CDP 测试卡片' },
      };

      // @ts-expect-error 使用 mock CDP 客户端
      const res = await renderCardToBase64(mockCdp, card);
      expect(mockEvaluate).toHaveBeenCalledOnce();
      expect(res).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...');
    });

    it('CDP 返回非有效 DataURL 时应抛出 DriverError', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue('INVALID_NON_DATA_URL'),
      };
      const card: CardData = {
        header: { title: '失败卡片' },
      };
      // @ts-expect-error 使用 mock CDP 客户端
      await expect(renderCardToBase64(mockCdp, card)).rejects.toThrow(DriverError);
    });

    it('CDP evaluate 异常时应捕获并包装为 DriverError', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockRejectedValue(new Error('CDP execution context destroyed')),
      };
      const card: CardData = {
        header: { title: '异常卡片' },
      };
      // @ts-expect-error 使用 mock CDP 客户端
      await expect(renderCardToBase64(mockCdp, card)).rejects.toThrow(DriverError);
    });
  });
});
