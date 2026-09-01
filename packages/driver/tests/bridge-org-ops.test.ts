import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeOrgOps } from '../src/bridge/org-ops.js';

describe('BridgeOrgOps 纯数据组织架构与员工档案测试', () => {
  it('getOrgEmployees 应通过 getChildDeptsAndMembers 递归遍历全量部门并提取员工档案', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('getChildDeptsAndMembers')) {
          if (script.includes('"deptID":0') || script.includes('"deptID": 0') || script.includes('deptID: 0')) {
            return Promise.resolve({
              code: 0,
              data: {
                deptPaths: [{ id: 0, name: '根部门' }],
                depts: [{ id: 15, name: '联合光电' }],
                members: [
                  { id: 1001, name: '张三', login_name: '001', pos: '总监' },
                ],
              },
            });
          }
          if (script.includes('"deptID":15') || script.includes('"deptID": 15') || script.includes('deptID: 15')) {
            return Promise.resolve({
              code: 0,
              data: {
                deptPaths: [{ id: 15, name: '联合光电' }],
                depts: [],
                members: [
                  { id: 5761, name: '董仕林', login_name: '0123040139', pos: 'IT开发工程师' },
                ],
              },
            });
          }
        }
        if (script.includes('usersInfo')) {
          return Promise.resolve([
            { id: 9999, name: '缓存成员', login_name: '999', pos: '架构师' },
          ]);
        }
        return Promise.resolve({ code: 0, data: { depts: [], members: [] } });
      }),
    } as unknown as CdpClient;

    const ops = new BridgeOrgOps(mockCdp);
    const employees = await ops.getOrgEmployees(5000);

    expect(employees.length).toBeGreaterThanOrEqual(2);
    const dsl = employees.find(e => e.id === 5761);
    expect(dsl).toBeDefined();
    expect(dsl?.name).toBe('董仕林');
    expect(dsl?.loginName).toBe('0123040139');
    expect(dsl?.position).toBe('IT开发工程师');
  });

  it('首页恰好 200 名成员时仍应遍历该响应返回的子部门', async () => {
    const firstPageMembers = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      name: `根部门成员${index + 1}`,
      login_name: String(index + 1),
    }));
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('getMyDepts')) {
          return Promise.resolve([0]);
        }
        if (script.includes('getChildDeptsAndMembers')) {
          const isChildDept = script.includes('"deptID":15');
          const isFirstPage = script.includes('"pageNo":1');
          if (isChildDept) {
            return Promise.resolve({
              code: 0,
              data: {
                depts: [],
                members: [{ id: 201, name: '子部门成员', login_name: '201' }],
              },
            });
          }
          if (isFirstPage) {
            return Promise.resolve({
              code: 0,
              data: {
                depts: [{ id: 15, name: '子部门' }],
                members: firstPageMembers,
              },
            });
          }
          return Promise.resolve({ code: 0, data: { depts: [], members: [] } });
        }
        if (script.includes('usersInfo')) {
          return Promise.resolve([]);
        }
        return Promise.resolve(null);
      }),
    } as unknown as CdpClient;

    const employees = await new BridgeOrgOps(mockCdp).getOrgEmployees(5000);

    expect(employees).toHaveLength(201);
    expect(employees.some(employee => employee.id === 201)).toBe(true);
  });

  it('getUserProfile 应通过 getMemberDetail 查询单人完整档案并解析部门路径', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('getMemberDetail')) {
          return Promise.resolve({
            code: 0,
            data: {
              id: 5761,
              name: '董仕林',
              login_name: '0123040139',
              pos: 'IT开发工程师',
              region: 'IT办公室第二个位置',
              sig: '个性签名',
              deptPaths: [
                { id: 15, name: '联合光电' },
                { id: 29, name: 'IT组' },
              ],
            },
          });
        }
        return Promise.resolve({ code: -1 });
      }),
    } as unknown as CdpClient;

    const ops = new BridgeOrgOps(mockCdp);
    const profile = await ops.getUserProfile(5761);

    expect(profile).not.toBeNull();
    expect(profile?.id).toBe(5761);
    expect(profile?.name).toBe('董仕林');
    expect(profile?.position).toBe('IT开发工程师');
    expect(profile?.region).toBe('IT办公室第二个位置');
    expect(profile?.deptPaths).toHaveLength(2);
    expect(profile?.deptPaths?.[1]?.name).toBe('IT组');
  });

  it('当 getMemberDetail 未命中时应降级尝试 getUserByUserId', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('getMemberDetail')) {
          return Promise.resolve({ code: 1, message: 'Not found' });
        }
        if (script.includes('getUserByUserId')) {
          return Promise.resolve({
            code: 0,
            data: [
              { id: 3705, name: '姜鹏', login_name: 'jp01', pos: '经理' },
            ],
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as CdpClient;

    const ops = new BridgeOrgOps(mockCdp);
    const profile = await ops.getUserProfile(3705);

    expect(profile).not.toBeNull();
    expect(profile?.id).toBe(3705);
    expect(profile?.name).toBe('姜鹏');
  });
});
