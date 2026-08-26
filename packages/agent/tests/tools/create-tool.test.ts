import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createKkTool } from '../../src/tools/create-tool.js';

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
});
