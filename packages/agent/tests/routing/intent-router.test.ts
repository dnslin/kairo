import { describe, expect, it } from 'vitest';
import { IntentModelRouter } from '../../src/routing/intent-router.js';
import type { LLMProvider } from '../../src/types/index.js';

describe('IntentModelRouter 动态意图分流测试 (FAST vs DEEP)', () => {
  const mockFastLLM: LLMProvider = {
    chat() {
      return Promise.resolve({ content: 'FAST 回复' });
    },
  };

  const mockDeepLLM: LLMProvider = {
    chat() {
      return Promise.resolve({ content: 'DEEP 深度推理回复' });
    },
  };

  const router = new IntentModelRouter({
    fastModel: {
      id: 'fast-model-v3',
      name: 'DeepSeek-V3-Fast',
      provider: mockFastLLM,
    },
    deepModel: {
      id: 'deep-model-r1',
      name: 'DeepSeek-R1-Deep',
      provider: mockDeepLLM,
    },
  });

  it('日常问候、打招呼与闲聊应分流至 FAST 极速模型', async () => {
    const greetings = ['你好', '早安！', 'hi，在吗？', '谢谢你，收到啦', 'ok 好的'];
    for (const text of greetings) {
      const result = await router.classify(text);
      expect(result.intentLevel).toBe('FAST');
      expect(result.features.isChitchat).toBe(true);

      const routeResult = await router.route(text);
      expect(routeResult.selectedModel.id).toBe('fast-model-v3');
    }
  });

  it('员工工位、电话与部门查询应分流至 FAST 极速模型', async () => {
    const orgQueries = [
      '查一下张三的工位在哪',
      '李四的电话是多少',
      '王五在哪个部门',
      '请问技术支持找谁',
    ];
    for (const query of orgQueries) {
      const result = await router.classify(query);
      expect(result.intentLevel).toBe('FAST');
      expect(result.features.isOrgQuery).toBe(true);

      const routeResult = await router.route(query);
      expect(routeResult.selectedModel.id).toBe('fast-model-v3');
    }
  });

  it('代码报错、异常排查与堆栈调试应分流至 DEEP 深度推理模型', async () => {
    const codeQueries = [
      '这段代码报错 TypeError: Cannot read properties of undefined (reading "name")，请帮我排查原因',
      '```typescript\nfunction test() { return 1; }\n```\n帮我优化这个算法',
      '线上偶现死锁和内存泄漏，堆栈 dump 如下，请分析根因',
      '排查异常：数据库连接池打满 500 报错',
    ];
    for (const query of codeQueries) {
      const result = await router.classify(query);
      expect(result.intentLevel).toBe('DEEP');

      const routeResult = await router.route(query);
      expect(routeResult.selectedModel.id).toBe('deep-model-r1');
    }
  });

  it('纯自然语言代码编写与算法实现任务应分流至 DEEP 深度推理模型', async () => {
    const codeGenQueries = [
      '请帮我写一个 Python 脚本处理 CSV 文件',
      '请编写代码实现一个快速排序算法',
      '帮我写一个函数计算两个日期的工作日差值',
      '写一段代码实现并发控制逻辑，限制最大请求数为 5',
    ];
    for (const query of codeGenQueries) {
      const result = await router.classify(query);
      expect(result.intentLevel).toBe('DEEP');

      const routeResult = await router.route(query);
      expect(routeResult.selectedModel.id).toBe('deep-model-r1');
    }
  });

  it('普通日常文案撰写与请假日常问答应稳定分流至 FAST 轻量模型，不被误判为 DEEP', async () => {
    const ordinaryCopyQueries = [
      '帮我写一个请假理由',
      '帮我写一段中秋节日祝福语',
      '起草一个下午两点的周会通知',
      '帮我想一句生日祝福',
    ];
    for (const query of ordinaryCopyQueries) {
      const result = await router.classify(query);
      expect(result.intentLevel).toBe('FAST');

      const routeResult = await router.route(query);
      expect(routeResult.selectedModel.id).toBe('fast-model-v3');
    }
  });

  it('长文档方案对比、故障复盘与架构多步规划应分流至 DEEP 深度推理模型', async () => {
    const complexQueries = [
      '请对比方案 A 与方案 B 的优劣势，并给出技术选型建议',
      '针对昨天的生产故障做一份根因分析复盘报告',
      '请为我们的微服务重构制定详细的架构设计与实施步骤迁移计划',
    ];
    for (const query of complexQueries) {
      const result = await router.classify(query);
      expect(result.intentLevel).toBe('DEEP');
      expect(result.features.hasReasoningKeywords).toBe(true);

      const routeResult = await router.route(query);
      expect(routeResult.selectedModel.id).toBe('deep-model-r1');
    }
  });

  it('应支持注册自定义意图规则并优先命中', async () => {
    const customRouter = new IntentModelRouter({
      fastModel: mockFastLLM,
      deepModel: mockDeepLLM,
    });

    customRouter.registerRule({
      name: 'vip-urgent-command',
      intentLevel: 'DEEP',
      match: msg => typeof msg === 'string' && msg.includes('紧急VIP'),
      priority: 100,
    });

    const res = await customRouter.classify('紧急VIP：你好');
    expect(res.intentLevel).toBe('DEEP');
    expect(res.reason).toContain('vip-urgent-command');
  });

  it('当仅配置一个模型时，应能自适应回退并组装正确的候选调用链', async () => {
    const singleRouter = new IntentModelRouter({
      fastModel: mockFastLLM,
    });

    const routeRes = await singleRouter.route('帮我排查异常报错');
    expect(routeRes.selectedModel.provider).toBe(mockFastLLM);
    expect(routeRes.candidateChain.length).toBe(1);
  });

  it('当消息包含图片且配置了 Vision 模型时，应优先将 Vision 模型提升到候选链头部', async () => {
    const visionRouter = new IntentModelRouter({
      fastModel: {
        id: 'fast-text-only',
        name: 'Fast-Text',
        provider: mockFastLLM,
        supportsVision: false,
      },
      deepModel: {
        id: 'deep-vision-model',
        name: 'Deep-Vision',
        provider: mockDeepLLM,
        supportsVision: true,
      },
    });

    // 发送日常问候但带有图片
    const res = await visionRouter.route({
      sessionId: 's1',
      sessionName: '张三',
      sessionType: 'private',
      sender: '张三',
      content: '你好，帮我看看这张图 data/media/2026/08/diag.png',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 's1',
          sessionName: '张三',
          sessionType: 'private',
          sender: '张三',
          content: '你好，帮我看看这张图',
          time: '12:00',
          isMe: false,
          timestamp: Date.now(),
          images: [{ filePath: 'C:\\cache\\diag.png' }],
        },
      ],
      firstReceivedAt: Date.now(),
      lastReceivedAt: Date.now(),
      messageIds: ['m1'],
    });

    expect(res.selectedModel.id).toBe('deep-vision-model');
    expect(res.candidateChain[0]?.id).toBe('deep-vision-model');
    expect(res.candidateChain[1]?.id).toBe('fast-text-only');
  });

  it('普通办公文件卡片附件不应错误触发 Vision 提升，应按常规意图复杂度分流', async () => {
    const visionRouter = new IntentModelRouter({
      fastModel: {
        id: 'fast-text-only',
        name: 'Fast-Text',
        provider: mockFastLLM,
        supportsVision: false,
      },
      deepModel: {
        id: 'deep-vision-model',
        name: 'Deep-Vision',
        provider: mockDeepLLM,
        supportsVision: true,
      },
    });

    // 发送日常打招呼附带 Excel 考勤表
    const res = await visionRouter.route({
      sessionId: 's1',
      sessionName: '张三',
      sessionType: 'private',
      sender: '张三',
      content: '你好，发一份 [文件] 考勤表.xlsx (1.2MB)',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 's1',
          sessionName: '张三',
          sessionType: 'private',
          sender: '张三',
          content: '你好，发一份 [文件] 考勤表.xlsx (1.2MB)',
          time: '12:00',
          isMe: false,
          timestamp: Date.now(),
          fileInfo: { fileName: '考勤表.xlsx', fileSize: '1.2MB' },
        },
      ],
      firstReceivedAt: Date.now(),
      lastReceivedAt: Date.now(),
      messageIds: ['m1'],
    });

    // 应维持 FAST 轻量模型，不被误提升到 Vision
    expect(res.selectedModel.id).toBe('fast-text-only');
  });
});
