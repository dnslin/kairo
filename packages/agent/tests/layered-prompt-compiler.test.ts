import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { LayeredPromptCompiler } from '../src/prompt/compiler.js';

describe('LayeredPromptCompiler', () => {
  let tmpDir: string;
  let soulFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-prompt-test-'));
    soulFile = path.join(tmpDir, 'soul.md');
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('4 层 Prompt 结构化编译', () => {
    it('应当在无 soul.md 文件时自动回退至默认人设预设并正确组装 4 层 Prompt', async () => {
      const compiler = new LayeredPromptCompiler({
        soulPath: path.join(tmpDir, 'non_existent_soul.md'),
      });

      const result = await compiler.compile({
        timestamp: new Date('2026-08-20T10:00:00Z'),
        userProfile: {
          nickname: '张三',
          tonePreference: '简明专业',
        },
        employeeContext: {
          employeeId: 'EMP001',
          name: '张三',
          department: '基础架构组',
          departmentPath: '技术研发中心/架构平台部/基础架构组',
          jobTitle: '高级后端工程师',
          collaborationBoundary: '仅协助企业内部系统技术咨询与审批支持',
        },
        retrievedFacts: ['KK9 客户端当前版本为 2.0.0，支持单聊会话。'],
      });

      // Layer 1: 基础人设包含默认 KK9 机器人人设
      expect(result.layer1).toContain('KK9 智能助手');
      expect(result.layer1).toContain('私聊');

      // Layer 2: 动态上下文包含系统时间和用户昵称偏好
      expect(result.layer2).toContain('2026-08-20');
      expect(result.layer2).toContain('张三');
      expect(result.layer2).toContain('简明专业');

      // Layer 3: 组织环境包含部门路径与岗位
      expect(result.layer3).toContain('技术研发中心/架构平台部/基础架构组');
      expect(result.layer3).toContain('高级后端工程师');
      expect(result.layer3).toContain('仅协助企业内部系统技术咨询与审批支持');

      // Layer 4: 安全防幻觉要求与召回事实
      expect(result.layer4).toContain('严禁捏造事实');
      expect(result.layer4).toContain('转人工');
      expect(result.layer4).toContain('KK9 客户端当前版本为 2.0.0');

      // 完整 Prompt 包含 4 层标记
      expect(result.fullPrompt).toContain(result.layer1);
      expect(result.fullPrompt).toContain(result.layer2);
      expect(result.fullPrompt).toContain(result.layer3);
      expect(result.fullPrompt).toContain(result.layer4);
    });

    it('应当优先加载并编译外部声明式 soul.md 文件的自定义人设', async () => {
      const customSoul = `# 运营专有助手人设
- 口吻：热情亲和，经常使用友好打招呼语
- 业务范围：专注办公用品申领与行政答疑
- 禁忌：严禁承诺未经审批的预算支出`;

      await fs.writeFile(soulFile, customSoul, 'utf-8');

      const compiler = new LayeredPromptCompiler({
        soulPath: soulFile,
      });

      const result = await compiler.compile();

      expect(result.layer1).toContain('运营专有助手人设');
      expect(result.layer1).toContain('专注办公用品申领与行政答疑');
      expect(result.layer1).toContain('严禁承诺未经审批的预算支出');
    });

    it('当员工上下文为空时，Layer 3 应当生成通用的内部员工安全协同说明', async () => {
      const compiler = new LayeredPromptCompiler();
      const result = await compiler.compile();

      expect(result.layer3).toContain('当前用户为企业内部员工');
    });
  });

  describe('soul.md 声明式热重载 (Hot Reload)', () => {
    it('当 soul.md 被修改时，应当异步触发重新加载并发出 prompt_reloaded 事件', async () => {
      const initialSoul = '# 初始人设：严肃技术顾问';
      await fs.writeFile(soulFile, initialSoul, 'utf-8');

      const compiler = new LayeredPromptCompiler({
        soulPath: soulFile,
        watchSoul: true,
      });

      // 等待初始化加载
      await compiler.init();
      expect(compiler.getSoulContent()).toContain('初始人设：严肃技术顾问');

      // 监听重载事件
      const { promise: reloadPromise, resolve } = Promise.withResolvers<{
        soulContent: string;
        timestamp: number;
      }>();
      compiler.once('prompt_reloaded', data => {
        resolve(data);
      });

      // 修改 soul.md
      const updatedSoul = '# 更新人设：幽默活泼助手';
      await fs.writeFile(soulFile, updatedSoul, 'utf-8');

      const eventData = await reloadPromise;
      expect(eventData.soulContent).toContain('更新人设：幽默活泼助手');
      expect(compiler.getSoulContent()).toContain('更新人设：幽默活泼助手');

      // 编译验证
      const compiled = await compiler.compile();
      expect(compiled.layer1).toContain('更新人设：幽默活泼助手');

      await compiler.close();
    });

    it('主动关闭 watcher 后不应再响应修改', async () => {
      await fs.writeFile(soulFile, '# 基础设定', 'utf-8');
      const compiler = new LayeredPromptCompiler({
        soulPath: soulFile,
        watchSoul: true,
      });
      await compiler.init();
      await compiler.close();

      let eventTriggered = false;
      compiler.once('prompt_reloaded', () => {
        eventTriggered = true;
      });

      await fs.writeFile(soulFile, '# 再次修改设定', 'utf-8');
      // 检查 watcher 关闭状态
      expect(compiler.isWatching()).toBe(false);
      expect(eventTriggered).toBe(false);
    });
  });
});
