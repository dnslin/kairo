import type { CdpClient } from '../cdp/client.js';
import type { KK9Employee } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('org-ops');

/**
 * 清洗并获取非空字符串，若为空或全空白符则返回 undefined
 */
function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

/**
 * 尝试从多个候选属性键中读取首个非空字符串
 */
function pickFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const cleaned = cleanOptionalString(obj[key]);
    if (cleaned !== undefined) {
      return cleaned;
    }
  }
  return undefined;
}

/**
 * 解析单个原始对象为标准 KK9Employee 实体
 * 包含多格式兼容、空白清洗与防御性降级
 */
export function parseEmployee(raw: unknown): KK9Employee | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;

  // 防护：排除聊天会话对象 (防止误将会话列表当做通讯录)
  if (
    ('sesUUID' in record || 'maxMessageIndex' in record || 'userReadIndex' in record) &&
    !('login_name' in record || 'f_spell' in record || 'deptPaths' in record)
  ) {
    return null;
  }

  // 1. 提取唯一员工 ID
  let id: number | string | null = null;
  const rawId =
    record.id ?? record.userId ?? record.user_id ?? record.uid ?? record.empId ?? record.emp_id;

  if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    id = rawId;
  } else if (typeof rawId === 'string') {
    const trimmed = rawId.trim();
    if (trimmed.length > 0) {
      id = trimmed;
    }
  }

  if (id === null) {
    return null;
  }

  // 2. 提取工号 / 登录名 (多别名支持与回退)
  const loginNameCandidates = [
    'loginName',
    'login_name',
    'job_number',
    'loginCode',
    'login_code',
    'code',
    'account',
    'staffNo',
    'staff_no',
    'workNo',
    'work_no',
  ];
  const rawLoginName = pickFirstString(record, loginNameCandidates);
  const loginName = rawLoginName ?? String(id);

  // 3. 提取真实姓名 (多别名支持与回退)
  const nameCandidates = [
    'name',
    'realName',
    'real_name',
    'userName',
    'user_name',
    'showName',
    'show_name',
    'nickName',
    'nick_name',
  ];
  const rawName = pickFirstString(record, nameCandidates);
  let name: string;
  if (rawName) {
    name = rawName;
  } else if (rawLoginName) {
    name = rawLoginName;
  } else {
    name = `员工_${String(id)}`;
  }

  // 4. 提取可选属性 (岗位、物理工位、个性签名、电话、邮箱、头像等)
  const position = pickFirstString(record, [
    'pos',
    'position',
    'position_desc',
    'title',
    'job',
    'post',
    'department',
    'dept',
  ]);
  const region = pickFirstString(record, ['region', 'location', 'office', 'workplace', 'area']);
  const signature = pickFirstString(record, ['sig', 'signature', 'bio', 'memo']);
  const phone = pickFirstString(record, ['phone', 'mobile', 'tel']);
  const email = pickFirstString(record, ['email', 'mail']);
  const avatarUrl = pickFirstString(record, [
    'avatarUrl',
    'avatar_url',
    'avatar',
    'icon',
    'headUrl',
    'head_url',
    'photo',
  ]);

  const employee: KK9Employee = {
    id,
    loginName,
    name,
    updatedAt: Date.now(),
    raw: record,
  };

  if (position !== undefined) employee.position = position;
  if (region !== undefined) employee.region = region;
  if (signature !== undefined) employee.signature = signature;
  if (phone !== undefined) employee.phone = phone;
  if (email !== undefined) employee.email = email;
  if (avatarUrl !== undefined) employee.avatarUrl = avatarUrl;

  return employee;
}

/**
 * 批量解析原始数组为标准 KK9Employee 列表，自动过滤无效项
 */
export function parseEmployeeList(list: unknown): KK9Employee[] {
  if (!Array.isArray(list)) {
    return [];
  }

  const result: KK9Employee[] = [];
  for (const item of list) {
    const employee = parseEmployee(item);
    if (employee !== null) {
      result.push(employee);
    }
  }

  return result;
}

/**
 * 组织架构与通讯录数据抽取操作类
 */
export class OrgOps {
  constructor(private readonly cdp: CdpClient) {}

  /**
   * 从 KK9 客户端抽取企业全量员工档案名录
   * 包含组织架构树自动展开（BFS Traversal），支持将全公司所有部门及数千名员工全量抽取
   */
  public async getEmployees(timeoutMs = 30000): Promise<KK9Employee[]> {
    const script = `
      (async () => {
        try {
          const userMap = new Map();

          function addUser(u) {
            if (!u || typeof u !== 'object') return;
            const id = u.id ?? u.userId ?? u.uid;
            if (id !== undefined && id !== null && String(id).trim().length > 0) {
              // 排除聊天会话对象
              if (u.sesUUID && !u.login_name && !u.f_spell) return;
              const key = String(id);
              if (!userMap.has(key) || (!userMap.get(key).login_name && u.login_name)) {
                userMap.set(key, u);
              }
            }
          }

          function addUsers(arr) {
            if (Array.isArray(arr)) {
              for (const item of arr) addUser(item);
            } else if (arr && typeof arr === 'object') {
              for (const item of Object.values(arr)) addUser(item);
            }
          }

          // 1. 尝试从 Vue 组件中获取 contact 实例并执行组织架构树 BFS 遍历展开
          const allVueComponents = Array.from(document.querySelectorAll('*'))
            .map(el => el.__vue__)
            .filter(Boolean);

          const contactComp = allVueComponents.find(
            c => c.$options?.name === 'contact' || c.$options?._componentTag === 'contact'
          );

          if (contactComp && typeof contactComp.onClickOrg === 'function') {
            const visitedDepts = new Set();
            const queue = [];

            // 1. 初始化通用根部门与当前已有部门列表
            queue.push({ id: 0, name: '组织架构' });
            if (Array.isArray(contactComp.deptInfo?.depts)) {
              for (const d of contactComp.deptInfo.depts) {
                if (d && d.id) queue.push(d);
              }
            }
            // 收集已有缓存部门
            if (contactComp.orgDepartCache && typeof contactComp.orgDepartCache === 'object') {
              for (const cache of Object.values(contactComp.orgDepartCache)) {
                if (cache?.data?.depts && Array.isArray(cache.data.depts)) {
                  for (const d of cache.data.depts) {
                    if (d && d.id && !visitedDepts.has(d.id)) queue.push(d);
                  }
                }
                if (cache?.data?.members) addUsers(cache.data.members);
                if (cache?.data?.leader) addUsers(cache.data.leader);
              }
            }

            // 限制最大遍历深度/部门数，防止死循环
            let count = 0;
            const MAX_DEPTS = 500;

            while (queue.length > 0 && count < MAX_DEPTS) {
              count++;
              const currentDept = queue.shift();
              if (!currentDept || visitedDepts.has(currentDept.id)) continue;
              visitedDepts.add(currentDept.id);

              try {
                await contactComp.onClickOrg(currentDept);
                if (contactComp.deptInfo?.members) addUsers(contactComp.deptInfo.members);
                if (contactComp.deptInfo?.leader) addUsers(contactComp.deptInfo.leader);

                const subDepts = contactComp.deptInfo?.depts;
                if (Array.isArray(subDepts)) {
                  for (const sub of subDepts) {
                    if (sub && sub.id && !visitedDepts.has(sub.id)) {
                      queue.push(sub);
                    }
                  }
                }
              } catch {
                // 忽略单个部门展开失败
              }
            }
          }

          // 2. 收集 Vuex 状态树中的用户与当前登录人档案
          const appVm = document.querySelector('#app')?.__vue__ ||
                        document.querySelector('.main-page')?.__vue__ ||
                        window.__vue__;
          const store = appVm?.$store || window.$store || window.store;

          if (store && store.state) {
            if (store.state.session?.usersInfo) addUsers(store.state.session.usersInfo);
            if (store.state.basicInfo?.userDetail) addUser(store.state.basicInfo.userDetail);
            if (store.state.favContact?.data) addUsers(store.state.favContact.data);
            if (store.state.activeDialog?.members) addUsers(store.state.activeDialog.members);
            if (store.state.activeDialog?.allMembers) addUsers(store.state.activeDialog.allMembers);
          }

          // 3. 收集全局通讯录对象
          const globalList = window.orgTree || window.addressBook || window.userList || window.contactList || window.contacts;
          if (globalList) addUsers(globalList);

          return Array.from(userMap.values());
        } catch (err) {
          return [];
        }
      })()
    `;

    try {
      const rawData = await this.cdp.evaluate<unknown[]>(script, timeoutMs);
      const employees = parseEmployeeList(rawData);
      log.info({ count: employees.length }, '组织架构全量员工档案抽取完成');
      return employees;
    } catch (err) {
      log.warn({ err }, '从 KK9 客户端抽取组织架构员工档案失败');
      return [];
    }
  }

  /**
   * 按 UID 精确单点查询员工档案
   */
  public async getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    if (userId === null || userId === undefined) {
      return null;
    }

    const trimmedTarget = String(userId).trim();
    if (trimmedTarget.length === 0) {
      return null;
    }

    const script = `
      (() => {
        try {
          const target = ${JSON.stringify(trimmedTarget)};
          const targetNum = Number(target);

          function matchUser(u) {
            if (!u || typeof u !== 'object') return false;
            if (u.sesUUID && !u.login_name && !u.f_spell) return false;
            return String(u.id) === target ||
                   String(u.userId) === target ||
                   String(u.uid) === target ||
                   String(u.login_name) === target ||
                   String(u.loginName) === target ||
                   (Number.isFinite(targetNum) && (u.id === targetNum || u.userId === targetNum || u.uid === targetNum));
          }

          const appVm = document.querySelector('#app')?.__vue__ ||
                        document.querySelector('.main-page')?.__vue__ ||
                        window.__vue__;
          const store = appVm?.$store || window.$store || window.store;

          // 1. 优先查 Vuex usersInfo
          if (store?.state?.session?.usersInfo) {
            const usersInfo = store.state.session.usersInfo;
            if (usersInfo[target] && matchUser(usersInfo[target])) return usersInfo[target];
            if (Number.isFinite(targetNum) && usersInfo[targetNum] && matchUser(usersInfo[targetNum])) return usersInfo[targetNum];
            const found = Object.values(usersInfo).find(matchUser);
            if (found) return found;
          }

          // 2. 检查当前登录人
          if (store?.state?.basicInfo?.userDetail && matchUser(store.state.basicInfo.userDetail)) {
            return store.state.basicInfo.userDetail;
          }

          // 3. 检查部门与联系人缓存
          const allVueComponents = Array.from(document.querySelectorAll('*'))
            .map(el => el.__vue__)
            .filter(Boolean);

          for (const comp of allVueComponents) {
            if (comp.orgDepartCache && typeof comp.orgDepartCache === 'object') {
              for (const cacheItem of Object.values(comp.orgDepartCache)) {
                const m = (cacheItem?.data?.members || []).find(matchUser);
                if (m) return m;
                const l = (cacheItem?.data?.leader || []).find(matchUser);
                if (l) return l;
              }
            }
            if (comp.deptInfo?.members) {
              const m = comp.deptInfo.members.find(matchUser);
              if (m) return m;
            }
          }

          return null;
        } catch (err) {
          return null;
        }
      })()
    `;

    try {
      const rawData = await this.cdp.evaluate<Record<string, unknown> | null>(script);
      if (!rawData) {
        return null;
      }
      return parseEmployee(rawData);
    } catch (err) {
      log.warn({ err, userId }, '单点查询用户档案失败');
      return null;
    }
  }
}
