import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createMastraGenerateFileDeliverableTool,
  executeGenerateFileDeliverableCore,
} from '../../src/tools/builtin/generate-file-deliverable.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createKkTool, decorateKkTool } from '../../src/tools/create-tool.js';
import type { Tool } from '@mastra/core/tools';
import { KKBotAgent } from '../../src/agent.js';
import { MastraModelFactory } from '../../src/models/factory.js';
import { createFakeModel } from '../fixtures/fake-model.js';
describe('createKkTool (Mastra Tool Factory & Contract Guard)', () => {
  it('应成功创建合法的只读 Mastra Tool', async () => {
    const tool = createKkTool({
      id: 'get_user_profile',
      description: '获取用户基本档案信息',
      inputSchema: z.object({
        userId: z.string().min(1),
      }),
      outputSchema: z.object({
        name: z.string(),
        title: z.string(),
      }),
      effect: 'read',
      risk: 'low',
      execute: async ({ context }) => {
        await Promise.resolve();
        return {
          name: `User-${context.userId}`,
          title: '工程师',
        };
      },
    });

    expect(tool.id).toBe('get_user_profile');
    expect(tool.description).toBe('获取用户基本档案信息');

    const res = await tool.execute({ userId: '1001' });
    expect(res).toEqual({
      name: 'User-1001',
      title: '工程师',
    });
  });

  it('应成功创建合法的低风险写 Tool，并具有幂等控制', async () => {
    const executedKeys: string[] = [];

    const tool = createKkTool({
      id: 'append_audit_log',
      description: '追加低风险审计日志',
      inputSchema: z.object({
        action: z.string(),
        idempotencyKey: z.string().optional(),
      }),
      outputSchema: z.object({
        status: z.string(),
      }),
      effect: 'write',
      risk: 'low',
      execute: async ({ context }) => {
        await Promise.resolve();
        const key = context.idempotencyKey ?? context.action;
        executedKeys.push(key);
        return { status: 'ok' };
      },
    });

    expect(tool.id).toBe('append_audit_log');
    const res = await tool.execute({ action: 'login', idempotencyKey: 'key_1' });
    expect(res).toEqual({ status: 'ok' });
    expect(executedKeys).toEqual(['key_1']);
  });

  it('执行时拒绝缺少幂等键的低风险写 Tool', async () => {
    const tool = createKkTool({
      id: 'write_without_idempotency',
      description: '缺少幂等键的写工具',
      inputSchema: z.object({ action: z.string() }),
      outputSchema: z.object({ status: z.string() }),
      effect: 'write',
      risk: 'low',
      execute: () => Promise.resolve({ status: 'ok' }),
    });

    await expect(tool.execute({ action: 'write' })).rejects.toThrow(/幂等键/);
  });

  it('拒绝注册 risk 为非 "low" 的高危工具', () => {
    expect(() => {
      createKkTool({
        id: 'dangerous_write_tool',
        description: '高风险工具',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        effect: 'write',
        // @ts-expect-error 故意传入非 low 风险等级
        risk: 'high',
        execute: async () => {
          await Promise.resolve();
          return {};
        },
      });
    }).toThrow(/risk 必须为 'low'/);
  });

  it('拒绝注册 effect 为非 read/write 的未知操作', () => {
    expect(() => {
      createKkTool({
        id: 'unknown_effect_tool',
        description: '未知操作',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        // @ts-expect-error 故意传入非法 effect
        effect: 'delete',
        risk: 'low',
        execute: async () => {
          await Promise.resolve();
          return {};
        },
      });
    }).toThrow(/effect 必须为 'read' 或 'write'/);
  });

  it('原位装饰 Tool 时保留 identity、prototype 和 toModelOutput 方法', () => {
    const prototype = {
      toModelOutput: () => 'native-output',
    };
    const rawTool = Object.create(prototype) as {
      id: string;
      description: string;
      execute: (inputData: unknown, context?: unknown) => Promise<unknown>;
    };
    rawTool.id = 'native-tool';
    rawTool.description = '原生 Tool';
    rawTool.execute = () => Promise.resolve({ ok: true });

    const decorated = decorateKkTool(
      rawTool as unknown as Tool<unknown, unknown, unknown, unknown>,
      { id: rawTool.id, effect: 'read', risk: 'low' }
    );

    expect(decorated).toBe(rawTool);
    expect(Object.getPrototypeOf(decorated)).toBe(prototype);
    expect(
      (decorated as unknown as { toModelOutput: () => string }).toModelOutput()
    ).toBe('native-output');
  });

  describe('createMastraGenerateFileDeliverableTool 路径安全与低风险写契约', () => {
    let sandboxDir: string;
    let baseDir: string;

    beforeEach(async () => {
      sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-genfile-sandbox-'));
      baseDir = path.join(sandboxDir, 'media', 'inner');
      await fs.mkdir(baseDir, { recursive: true });
    });

    afterEach(async () => {
      try {
        await fs.rm(sandboxDir, { recursive: true, force: true });
      } catch {
        // 测试临时目录清理失败不影响后续测试
      }
    });
    it('拦截试图通过 .. 逃逸出受管媒体目录的路径穿越攻击 (subDir 穿越)', () => {
      expect(() => {
        executeGenerateFileDeliverableCore(
          {
            fileType: 'md',
            fileName: 'attack.md',
            subDir: '../escaped_subdir',
            content: 'malicious payload',
            idempotencyKey: 'key_attack_1',
          },
          baseDir,
          {},
          { sessionId: 'test_session', operatorId: 'test_op' }
        );
      }).toThrow(/逃逸出受管媒体根目录/);
    });

    it('拦截试图通过 fileName 包含 .. 的路径穿越攻击', () => {
      expect(() => {
        executeGenerateFileDeliverableCore(
          {
            fileType: 'md',
            fileName: '../escaped_file.md',
            content: 'malicious payload',
            idempotencyKey: 'key_attack_2',
          },
          baseDir,
          {},
          { sessionId: 'test_session', operatorId: 'test_op' }
        );
      }).toThrow(/逃逸出受管媒体根目录/);
    });

    it('缺少上下文身份时直接调用 Mastra 工具坚决 fail-closed 阻断', async () => {
      const tool = createMastraGenerateFileDeliverableTool({ baseDir });
      await expect(
        tool.execute({
          fileType: 'md',
          fileName: 'no_ctx.md',
          content: 'no context content',
          idempotencyKey: 'key_no_ctx',
        })
      ).rejects.toThrow(/缺少权威 sessionId 会话身份/);
    });

    it('低风险写操作缺失 idempotencyKey 时拒绝执行', () => {
      expect(() => {
        // @ts-expect-error 故意传入空 idempotencyKey
        executeGenerateFileDeliverableCore(
          {
            fileType: 'md',
            fileName: 'no_key.md',
            content: 'no key content',
          },
          baseDir,
          {},
          { sessionId: 'test_session', operatorId: 'test_op' }
        );
      }).toThrow(/idempotencyKey/);
    });

    it('同一会话复用幂等键换文件名时拒绝第二次写入', async () => {
      const seenIdempotencyKeys: Record<string, string> = {};
      executeGenerateFileDeliverableCore(
        {
          fileType: 'md',
          fileName: 'first.md',
          content: 'first content',
          idempotencyKey: 'same-key',
        },
        baseDir,
        seenIdempotencyKeys,
        { sessionId: 'same-session', operatorId: 'same-operator' }
      );

      expect(() =>
        executeGenerateFileDeliverableCore(
          {
            fileType: 'md',
            fileName: 'second.md',
            content: 'second content',
            idempotencyKey: 'same-key',
          },
          baseDir,
          seenIdempotencyKeys,
          { sessionId: 'same-session', operatorId: 'same-operator' }
        )
      ).toThrow(/幂等键/);
      await expect(fs.access(path.join(baseDir, 'files', 'same-session', 'second.md'))).rejects.toThrow();
    });

    it('新建 Tool 实例后重放同一幂等键不得覆盖原文件', async () => {
      const first = executeGenerateFileDeliverableCore(
        {
          fileType: 'md',
          fileName: 'restart.md',
          content: 'original content',
          idempotencyKey: 'restart-key',
        },
        baseDir,
        {},
        { sessionId: 'restart-session', operatorId: 'same-operator' }
      );

      const replay = executeGenerateFileDeliverableCore(
        {
          fileType: 'md',
          fileName: 'restart.md',
          content: 'changed content',
          idempotencyKey: 'restart-key',
        },
        baseDir,
        {},
        { sessionId: 'restart-session', operatorId: 'same-operator' }
      );

      expect(replay.alreadyExisted).toBe(true);
      expect(await fs.readFile(first.filePath, 'utf-8')).toBe('original content');
    });

    it('经由 KKBotAgent.execute({ sessionId, senderId }) 执行时，严格实现单会话内基于 idempotencyKey 的幂等防重与跨会话隔离', async () => {
      const deliverableTool = createMastraGenerateFileDeliverableTool({ baseDir });
      const report1FilePath = path.join(baseDir, 'files', 'session_A', 'report_1.md');
      const report2FilePath = path.join(baseDir, 'files', 'session_B', 'report_2.md');

      // Fake Model 第一次调用生成 report_1.md
      const fakeModel = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            toolCalls: [
              {
                id: 'call_1',
                name: 'generate_file_deliverable',
                input: {
                  fileType: 'md',
                  fileName: 'report_1.md',
                  content: 'session A content 1',
                  idempotencyKey: 'key_shared_001',
                },
              },
            ],
          },
          {
            text: '报告生成成功',
          },
        ],
      });
      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fakeModel }] },
          DEEP: { models: [{ model: fakeModel }] },
        },
      });

      const agent = new KKBotAgent({
        modelFactory: factory,
        tools: { generate_file_deliverable: deliverableTool },
      });

      // 1. Session A (emp_001) 首次执行，真实落盘文件
      const res1 = await agent.execute({
        input: '请生成报告',
        sessionId: 'session_A',
        senderId: 'emp_001',
      });
      expect(res1.finishReason).toBeDefined();
      const file1OnDisk = await fs.readFile(report1FilePath, 'utf-8');
      expect(file1OnDisk).toBe('session A content 1');

      // 2. Session A (emp_001) 重复执行相同 idempotencyKey (重放命中幂等，不覆盖原文件)
      const fakeModelReplay = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            toolCalls: [
              {
                id: 'call_replay',
                name: 'generate_file_deliverable',
                input: {
                  fileType: 'md',
                  fileName: 'report_1.md',
                  content: 'session A modified content',
                  idempotencyKey: 'key_shared_001',
                },
              },
            ],
          },
          {
            text: '重复报告已返回既有结果',
          },
        ],
      });
      const factoryReplay = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fakeModelReplay }] },
          DEEP: { models: [{ model: fakeModelReplay }] },
        },
      });
      const agentReplay = new KKBotAgent({
        modelFactory: factoryReplay,
        tools: { generate_file_deliverable: deliverableTool },
      });

      const res1Replay = await agentReplay.execute({
        input: '请重复生成报告',
        sessionId: 'session_A',
        senderId: 'emp_001',
      });
      expect(res1Replay.finishReason).toBeDefined();
      const file1AfterReplay = await fs.readFile(report1FilePath, 'utf-8');
      expect(file1AfterReplay).toBe('session A content 1'); // 验证没有被修改内容覆盖

      // 3. Session B (emp_002) 传入相同 idempotencyKey，必须与 Session A 严格隔离，独立生成新文件
      const fakeModelSessionB = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            toolCalls: [
              {
                id: 'call_session_b',
                name: 'generate_file_deliverable',
                input: {
                  fileType: 'md',
                  fileName: 'report_2.md',
                  content: 'session B content',
                  idempotencyKey: 'key_shared_001',
                },
              },
            ],
          },
          {
            text: 'Session B 独立生成成功',
          },
        ],
      });
      const factorySessionB = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fakeModelSessionB }] },
          DEEP: { models: [{ model: fakeModelSessionB }] },
        },
      });
      const agentSessionB = new KKBotAgent({
        modelFactory: factorySessionB,
        tools: { generate_file_deliverable: deliverableTool },
      });

      const resSessionB = await agentSessionB.execute({
        input: 'Session B 请求生成报告',
        sessionId: 'session_B',
        senderId: 'emp_002',
      });
      expect(resSessionB.finishReason).toBeDefined();
      const file2OnDisk = await fs.readFile(report2FilePath, 'utf-8');
      expect(file2OnDisk).toBe('session B content');
    });

    it('不同会话请求完全相同的 fileName 与 idempotencyKey 时，物理落盘路径按会话命名空间隔离，绝不发生跨会话文件覆盖', async () => {
      const deliverableTool = createMastraGenerateFileDeliverableTool({ baseDir });

      // 1. Session A 执行同名文件写入
      const fakeModelA = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model-a',
        responses: [
          {
            toolCalls: [
              {
                id: 'call_a',
                name: 'generate_file_deliverable',
                input: {
                  fileType: 'md',
                  fileName: 'conflict_report.md',
                  content: 'Session A exclusive content',
                  idempotencyKey: 'shared_conflict_key',
                },
              },
            ],
          },
          { text: 'Session A 完成' },
        ],
      });
      const agentA = new KKBotAgent({
        modelFactory: new MastraModelFactory({
          tiers: {
            FAST: { models: [{ model: fakeModelA }] },
            DEEP: { models: [{ model: fakeModelA }] },
          },
        }),
        tools: { generate_file_deliverable: deliverableTool },
      });

      await agentA.execute({
        input: '生成报告',
        sessionId: 'session_A',
        senderId: 'emp_001',
      });

      // 2. Session B 请求完全相同的 fileName 与相同的 idempotencyKey
      const fakeModelB = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model-b',
        responses: [
          {
            toolCalls: [
              {
                id: 'call_b',
                name: 'generate_file_deliverable',
                input: {
                  fileType: 'md',
                  fileName: 'conflict_report.md',
                  content: 'Session B exclusive content',
                  idempotencyKey: 'shared_conflict_key',
                },
              },
            ],
          },
          { text: 'Session B 完成' },
        ],
      });
      const agentB = new KKBotAgent({
        modelFactory: new MastraModelFactory({
          tiers: {
            FAST: { models: [{ model: fakeModelB }] },
            DEEP: { models: [{ model: fakeModelB }] },
          },
        }),
        tools: { generate_file_deliverable: deliverableTool },
      });

      await agentB.execute({
        input: '生成同名报告',
        sessionId: 'session_B',
        senderId: 'emp_002',
      });

      // 3. 断言各自会话命名空间下的物理文件独立存在，Session A 文件未被 Session B 覆盖
      const sessionAFilePath = path.join(baseDir, 'files', 'session_A', 'conflict_report.md');
      const sessionBFilePath = path.join(baseDir, 'files', 'session_B', 'conflict_report.md');

      expect(await fs.readFile(sessionAFilePath, 'utf-8')).toBe('Session A exclusive content');
      expect(await fs.readFile(sessionBFilePath, 'utf-8')).toBe('Session B exclusive content');
    });

    it('低风险写工具严格要求 idempotencyKey 不能为空', async () => {
      const tool = createMastraGenerateFileDeliverableTool({ baseDir });
      await expect(
        // @ts-expect-error 故意不传 idempotencyKey
        tool.execute({
          fileType: 'md',
          fileName: 'no_key.md',
          content: 'no key content',
        })
      ).rejects.toThrow(/idempotencyKey|幂等键/);
    });
  });
});
