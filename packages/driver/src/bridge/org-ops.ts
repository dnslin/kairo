import type { CdpClient } from '../cdp/client.js';
import type { KK9Employee } from '../types/index.js';
import { parseEmployee } from '../dom/org-ops.js';
import { callIpcToData } from './rpc.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-org-ops');

interface RawChildDeptsAndMembersResult {
  deptPaths?: Array<{ id: number; name: string }>;
  depts?: Array<{ id: number; name: string }>;
  members?: Array<Record<string, unknown>>;
}

interface RawMemberDetail extends Record<string, unknown> {
  id: number;
  name: string;
  login_name?: string;
  pos?: string;
  region?: string;
  sig?: string;
  phone?: string;
  email?: string;
  icon?: string;
  deptPaths?: Array<{ id: number; name: string }>;
}

export class BridgeOrgOps {
  constructor(private readonly cdp: CdpClient) {}

  /**
   * 通过底层 IPC toData('getChildDeptsAndMembers') 遍历企业全量员工档案
   */
  public async getOrgEmployees(timeoutMs = 30000): Promise<KK9Employee[]> {
    const startTime = Date.now();
    const allEmployees = new Map<string | number, KK9Employee>();
    const visitedDepts = new Set<number>();
    const queue: number[] = [0]; // 从根部门 0 开始 BFS 遍历

    try {
      while (queue.length > 0) {
        if (Date.now() - startTime > timeoutMs) {
          log.warn({ count: allEmployees.size }, '组织架构遍历超时，返回已收集部分');
          break;
        }

        const deptId = queue.shift()!;
        if (visitedDepts.has(deptId)) continue;
        visitedDepts.add(deptId);

        let pageNo = 1;
        let hasMore = true;

        while (hasMore) {
          const res = await callIpcToData<RawChildDeptsAndMembersResult>(
            this.cdp,
            'getChildDeptsAndMembers',
            [
              {
                deptID: deptId,
                pageSize: 100,
                pageNo,
                needDeptPath: true,
              },
            ],
            5000
          );

          if (res.code !== 0 || !res.data) {
            break;
          }

          const { members, depts } = res.data;

          if (Array.isArray(members) && members.length > 0) {
            for (const rawUser of members) {
              const emp = parseEmployee(rawUser);
              if (emp) {
                allEmployees.set(emp.id, emp);
              }
            }
            if (members.length < 100) {
              hasMore = false;
            } else {
              pageNo++;
            }
          } else {
            hasMore = false;
          }

          if (pageNo === 1 && Array.isArray(depts)) {
            for (const subDept of depts) {
              if (subDept && typeof subDept.id === 'number' && !visitedDepts.has(subDept.id)) {
                queue.push(subDept.id);
              }
            }
          }
        }
      }

      // 补充 Vuex store 已缓存的用户
      const storeUsers = await this.cdp.evaluate<Array<Record<string, unknown>>>(`
        (() => {
          const app = document.querySelector('#app')?.__vue__;
          const usersInfo = app?.$store?.state?.session?.usersInfo;
          return usersInfo ? Object.values(usersInfo) : [];
        })()
      `);

      if (Array.isArray(storeUsers)) {
        for (const raw of storeUsers) {
          const emp = parseEmployee(raw);
          if (emp && !allEmployees.has(emp.id)) {
            allEmployees.set(emp.id, emp);
          }
        }
      }

      log.info({ count: allEmployees.size }, '通过 Bridge 抽取全量员工档案完成');
      return Array.from(allEmployees.values());
    } catch (err) {
      log.warn({ err: String(err) }, 'Bridge 抽取组织架构异常');
      return Array.from(allEmployees.values());
    }
  }

  /**
   * 通过底层 IPC toData('getMemberDetail') 单点精确查询员工详细档案
   */
  public async getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    if (userId === null || userId === undefined) return null;
    const target = typeof userId === 'number' ? userId : parseInt(String(userId).trim(), 10) || String(userId).trim();

    try {
      // 1. 优先调用 getMemberDetail
      const res = await callIpcToData<RawMemberDetail>(
        this.cdp,
        'getMemberDetail',
        [target],
        3000
      );

      if (res.code === 0 && res.data) {
        const emp = parseEmployee(res.data);
        if (emp) {
          if (Array.isArray(res.data.deptPaths)) {
            emp.deptPaths = res.data.deptPaths;
          }
          return emp;
        }
      }

      // 2. 降级尝试 getUserByUserId
      const userRes = await callIpcToData<RawMemberDetail[]>(
        this.cdp,
        'getUserByUserId',
        [target],
        3000
      );

      if (userRes.code === 0 && Array.isArray(userRes.data) && userRes.data.length > 0) {
        const emp = parseEmployee(userRes.data[0]);
        if (emp) return emp;
      }

      return null;
    } catch (err) {
      log.warn({ userId, err: String(err) }, 'Bridge 查询员工档案失败');
      return null;
    }
  }
}
