import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { buildCanvasCardScript, calculateCardLayout } from '../src/canvas/renderer.js';
import { createAlertCard, createDecisionCard, createReportCard } from '../src/canvas/templates.js';
import type { AlertCardParams, DecisionCardParams, ReportCardParams } from '../src/types/index.js';
import { DriverError } from '../src/utils/errors.js';

describe('业务卡片预设模板库测试 (Canvas Card Templates)', () => {
  describe('2. 监控告警卡片 (createAlertCard)', () => {
    it('应根据 critical / high / medium / low / info 严重度自动映射主题和图标', () => {
      const critical = createAlertCard({
        title: '网关集群发生 OOM 异常',
        severity: 'critical',
      });
      expect(critical.theme).toBe('danger');
      expect(critical.header.tag?.text).toContain('CRITICAL');
      expect(critical.header.tag?.variant).toBe('danger');
      expect(critical.header.icon).toBe('🚨');

      const high = createAlertCard({
        title: '支付接口错误率上升',
        severity: 'high',
      });
      expect(high.theme).toBe('danger');
      expect(high.header.tag?.text).toContain('HIGH');

      const medium = createAlertCard({
        title: '磁盘空间使用率达到 85%',
        severity: 'medium',
      });
      expect(medium.theme).toBe('warning');
      expect(medium.header.tag?.text).toContain('MEDIUM');
      expect(medium.header.icon).toBe('⚠️');

      const low = createAlertCard({
        title: '证书即将于 30 天后过期',
        severity: 'low',
      });
      expect(low.theme).toBe('info');
      expect(low.header.tag?.text).toContain('LOW');
      expect(low.header.icon).toBe('ℹ️');

      const info = createAlertCard({
        title: '服务自动扩容完成',
        severity: 'info',
      });
      expect(info.theme).toBe('info');
      expect(info.header.tag?.text).toContain('INFO');
    });

    it('缺省严重度时应默认为 high (danger 主题)', () => {
      const card = createAlertCard({
        title: 'Redis 慢查询陡增',
      });
      expect(card.theme).toBe('danger');
      expect(card.header.subtitle).toBe('监控告警中心');
    });

    it('监控指标项对比阈值时应正确格式化并自动标红超标指标', () => {
      const params: AlertCardParams = {
        title: '订单处理微服务异常',
        service: 'order-service-prod',
        description: '上游消息堆积超过 10,000 条，处理延迟陡增',
        metrics: [
          { name: 'CPU 使用率', value: '98.5%', threshold: '80%', exceeded: true },
          { name: '接口延迟', value: '1,500ms', threshold: '200ms' },
          { name: '内存占用', value: '4.2GB', threshold: '8GB', exceeded: false },
        ],
        actions: [
          { text: '一键扩容', variant: 'danger', replyCommand: 'scale' },
          { text: '静音 30m', variant: 'secondary', replyCommand: 'mute' },
        ],
      };

      const card = createAlertCard(params);

      // 服务字段高亮
      const serviceField = card.fields?.find(f => f.label === '告警服务');
      expect(serviceField?.value).toBe('order-service-prod');
      expect(serviceField?.highlight).toBe(true);

      // 指标项断言
      const cpuMetric = card.fields?.find(f => f.label === 'CPU 使用率');
      expect(cpuMetric?.value).toBe('98.5% (阈值: 80%)');
      expect(cpuMetric?.danger).toBe(true);

      const latencyMetric = card.fields?.find(f => f.label === '接口延迟');
      expect(latencyMetric?.value).toBe('1,500ms (阈值: 200ms)');
      expect(latencyMetric?.danger).toBe(true);

      const memMetric = card.fields?.find(f => f.label === '内存占用');
      expect(memMetric?.value).toBe('4.2GB (阈值: 8GB)');
      expect(memMetric?.danger).toBe(false);

      // 故障详情
      const descField = card.fields?.find(f => f.label === '故障详情');
      expect(descField?.value).toBe('上游消息堆积超过 10,000 条，处理延迟陡增');
      expect(descField?.span).toBe(2);

      // 按钮
      expect(card.actions).toHaveLength(2);
    });

    it('当传入数字或字符串时间戳时应在页脚正确格式化', () => {
      const cardWithString = createAlertCard({
        title: '测试告警',
        timestamp: '2026-08-20 14:00:00',
      });
      expect(cardWithString.footer).toBeDefined();
      const footerStr =
        typeof cardWithString.footer === 'string'
          ? cardWithString.footer
          : cardWithString.footer?.text;
      expect(footerStr).toContain('2026-08-20 14:00:00');

      const cardWithNumber = createAlertCard({
        title: '测试告警',
        timestamp: 1771468800000,
      });
      const footerNum =
        typeof cardWithNumber.footer === 'string'
          ? cardWithNumber.footer
          : cardWithNumber.footer?.text;
      expect(footerNum).toBeDefined();
    });

    it('缺失必要参数时应抛出 DriverError', () => {
      // @ts-expect-error 缺失 title
      expect(() => createAlertCard({})).toThrow(DriverError);
    });
  });

  describe('3. 汇总报告卡片 (createReportCard)', () => {
    it('应根据 success / warning / failure / running 状态映射主题与图标', () => {
      const success = createReportCard({
        title: '主干流水线构建成功',
        status: 'success',
      });
      expect(success.theme).toBe('success');
      expect(success.header.tag?.variant).toBe('success');
      expect(success.header.icon).toBe('✅');

      const warning = createReportCard({
        title: '代码静态检查发现告警',
        status: 'warning',
      });
      expect(warning.theme).toBe('warning');
      expect(warning.header.tag?.variant).toBe('warning');
      expect(warning.header.icon).toBe('⚠️');

      const failure = createReportCard({
        title: '端到端回归测试失败',
        status: 'failure',
      });
      expect(failure.theme).toBe('danger');
      expect(failure.header.tag?.variant).toBe('danger');
      expect(failure.header.icon).toBe('❌');

      const running = createReportCard({
        title: '全量基准压测进行中',
        status: 'running',
      });
      expect(running.theme).toBe('primary');
      expect(running.header.tag?.variant).toBe('primary');
      expect(running.header.icon).toBe('⏳');
    });

    it('应正确两两网格化排布核心指标项与耗时', () => {
      const params: ReportCardParams = {
        title: '全量单元测试与集成测试报告',
        reportId: 'RUN-20260820-99',
        duration: '2m 15s',
        status: 'success',
        metrics: [
          { label: '用例总数', value: 1420 },
          { label: '通过率', value: '100%', highlight: true },
          { label: '代码覆盖率', value: '88.6%', highlight: true },
          { label: '失败用例', value: 0 },
        ],
        summary: '所有回归用例均通过，系统稳定性指标正常，具备发布条件。',
        actions: [{ text: '查看完整报告', variant: 'outline' }],
      };

      const card = createReportCard(params);

      // 编号与耗时
      const idField = card.fields?.find(f => f.label === '报告编号');
      expect(idField?.value).toBe('RUN-20260820-99');
      expect(idField?.span).toBe(1);

      const durationField = card.fields?.find(f => f.label === '执行耗时');
      expect(durationField?.value).toBe('2m 15s');
      expect(durationField?.span).toBe(1);

      // 网格指标项均应为 span 1
      const totalField = card.fields?.find(f => f.label === '用例总数');
      expect(totalField?.value).toBe('1420');
      expect(totalField?.span).toBe(1);

      const passField = card.fields?.find(f => f.label === '通过率');
      expect(passField?.value).toBe('100%');
      expect(passField?.highlight).toBe(true);

      // 摘要说明
      const summaryField = card.fields?.find(f => f.label === '摘要说明');
      expect(summaryField?.value).toBe('所有回归用例均通过，系统稳定性指标正常，具备发布条件。');
      expect(summaryField?.span).toBe(2);

      expect(card.actions?.[0]?.text).toBe('查看完整报告');
    });

    it('缺失必要参数时应抛出 DriverError', () => {
      // @ts-expect-error 缺失 title
      expect(() => createReportCard({})).toThrow(DriverError);
    });
  });

  describe('4. 多选决策卡片 (createDecisionCard)', () => {
    it('应自动格式化选项编号、高亮推荐标金选项并生成快捷回复按钮', () => {
      const params: DecisionCardParams = {
        title: '双十一高峰容量保障方案决策',
        sponsor: '技术委员会架构组',
        deadline: '今天 18:00 前',
        description: '面对预计 5x 的流量峰值，请团队负责人评审以下扩容方案',
        options: [
          {
            key: 1,
            title: '方案 A：就地水平动态扩容 Pod 实例',
            description: '成本低、见效快，需关注数据库连接池上限',
            recommended: true,
          },
          {
            key: 2,
            title: '方案 B：启用多活机房分流',
            description: '容灾能力强，需进行跨机房数据一致性校验',
          },
          {
            key: 3,
            title: '方案 C：降级非核心查询业务',
            description: '保核心链路，部分周边体验略有降级',
          },
        ],
      };

      const card = createDecisionCard(params);

      expect(card.theme).toBe('primary');
      expect(card.header.title).toBe('双十一高峰容量保障方案决策');
      expect(card.header.subtitle).toBe('架构与方案决策中心');
      expect(card.header.icon).toBe('⚖️');
      expect(card.header.tag?.text).toBe('待决策');

      // 发起人与截止时间
      const sponsorField = card.fields?.find(f => f.label === '发起人');
      expect(sponsorField?.value).toBe('技术委员会架构组');

      const deadlineField = card.fields?.find(f => f.label === '截止时间');
      expect(deadlineField?.value).toBe('今天 18:00 前');
      expect(deadlineField?.variant).toBe('warning');

      // 背景
      const descField = card.fields?.find(f => f.label === '决策背景');
      expect(descField?.value).toContain('5x 的流量峰值');

      // 选项格式化断言
      const recOptionField = card.fields?.find(f => f.label.includes('1'));
      expect(recOptionField?.label).toContain('⭐');
      expect(recOptionField?.value).toContain('[推荐]');
      expect(recOptionField?.highlight).toBe(true);
      expect(recOptionField?.span).toBe(2);

      const normalOptionField = card.fields?.find(f => f.label.includes('2'));
      expect(normalOptionField?.value).toContain('方案 B');
      expect(normalOptionField?.highlight).toBeFalsy();

      // 自动生成的按钮列表断言
      expect(card.actions).toHaveLength(3);
      expect(card.actions?.[0]).toMatchObject({
        text: '⭐ 选项 1',
        variant: 'primary',
        replyCommand: '1',
      });
      expect(card.actions?.[1]).toMatchObject({
        text: '选项 2',
        replyCommand: '2',
      });
      expect(card.actions?.[2]).toMatchObject({
        text: '选项 3',
        replyCommand: '3',
      });

      // 自动生成的页脚断言
      const footerText = typeof card.footer === 'string' ? card.footer : card.footer?.text;
      expect(footerText).toContain('1/2/3');
      expect(footerText).toContain('今天 18:00 前');
    });

    it('当 options 未指定 key 时应按自然序号 1, 2, 3 自动分配', () => {
      const card = createDecisionCard({
        title: '午餐外卖品类投票',
        options: [{ title: '轻食沙拉' }, { title: '日式定食', recommended: true }],
      });

      expect(card.fields?.some(f => f.label.includes('1'))).toBe(true);
      expect(card.fields?.some(f => f.label.includes('2'))).toBe(true);
      expect(card.actions?.[0]?.replyCommand).toBe('1');
      expect(card.actions?.[1]?.replyCommand).toBe('2');
    });

    it('缺失必要参数或选项为空时应抛出 DriverError', () => {
      // @ts-expect-error 缺失 title
      expect(() => createDecisionCard({ options: [{ title: 'A' }] })).toThrow(DriverError);
      // @ts-expect-error 缺失 options
      expect(() => createDecisionCard({ title: '决策' })).toThrow(DriverError);
      // options 为空数组
      expect(() => createDecisionCard({ title: '决策', options: [] })).toThrow(DriverError);
    });
  });

  describe('5. 与 Canvas 渲染引擎端到端兼容性 (End-to-End Compatibility)', () => {
    it('所有 3 种模板生成的 CardData 均能被 calculateCardLayout 计算正确尺寸', () => {
      const alert = createAlertCard({ title: '高负载告警', severity: 'high' });
      const report = createReportCard({ title: '巡检报告', status: 'success', duration: '12s' });
      const decision = createDecisionCard({
        title: '方案选择',
        options: [{ title: '方案一', recommended: true }, { title: '方案二' }],
      });

      for (const card of [alert, report, decision]) {
        const layout = calculateCardLayout(card);
        expect(layout.width).toBe(460);
        expect(layout.height).toBeGreaterThan(100);
        expect(layout.headerHeight).toBeGreaterThan(0);
        expect(layout.fieldsHeight).toBeGreaterThan(0);
        expect(layout.dpr).toBe(2);
      }
    });

    it('所有 3 种模板生成的 CardData 均能被 buildCanvasCardScript 生成合法脚本并在沙箱执行', () => {
      const alert = createAlertCard({
        title: '集群内存告警',
        severity: 'critical',
        service: 'k8s-worker-node',
        metrics: [{ name: 'Mem', value: '96%', threshold: '90%' }],
      });
      const report = createReportCard({
        title: '每日构建总结',
        status: 'success',
        metrics: [{ label: '构建数', value: 12 }],
      });
      const decision = createDecisionCard({
        title: '灰度发布策略',
        options: [{ title: '金丝雀 10%', recommended: true }, { title: '全量发布' }],
      });

      const cards = [alert, report, decision];

      for (const card of cards) {
        const script = buildCanvasCardScript(card);
        expect(typeof script).toBe('string');
        expect(script).toContain("document.createElement('canvas')");

        const fillTextCalls: string[] = [];
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
          stroke: vi.fn(),
          fillRect: vi.fn(),
          fillText: vi.fn((text: string) => fillTextCalls.push(text)),
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
          toDataURL: vi.fn(() => 'data:image/png;base64,MOCK_DATA'),
        };

        const mockDoc = {
          createElement: () => mockCanvas,
        };

        const result = vm.runInNewContext(script, { document: mockDoc });
        expect(result).toBe('data:image/png;base64,MOCK_DATA');
        expect(fillTextCalls.length).toBeGreaterThan(0);
      }
    });
  });
});
