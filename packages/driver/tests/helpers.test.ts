import { describe, expect, it } from 'vitest';
import { findVueSessionItem, VUE_SCROLLER_HELPERS_SCRIPT } from '../src/dom/helpers.js';

describe('DOM Helpers 测试', () => {
  it('VUE_SCROLLER_HELPERS_SCRIPT 应包含有效的辅助函数', () => {
    expect(VUE_SCROLLER_HELPERS_SCRIPT).toContain('function getVueScrollerItems');
    expect(VUE_SCROLLER_HELPERS_SCRIPT).toContain('function findVueSessionItem');
  });

  it('findVueSessionItem 应正确识别 sesUUID、typeName 及名称匹配', () => {
    const mockItems = [
      { sesUUID: 'ses_001', typeName: '技术交流群', name: '技术交流群' },
      { sesUUID: 'ses_002', typeName: '张三', name: '张三' },
      { id: 12345, typeName: '李四 (VIP)', name: '李四（正式）' },
    ];

    // 按 sesUUID 查找
    const match1 = findVueSessionItem(mockItems, 'ses_001');
    expect(match1.index).toBe(0);
    expect(match1.item?.typeName).toBe('技术交流群');

    // 按名称查找
    const match2 = findVueSessionItem(mockItems, '张三');
    expect(match2.index).toBe(1);
    expect(match2.item?.sesUUID).toBe('ses_002');

    // 禁止模糊包含查找
    const match3 = findVueSessionItem(mockItems, '李四');
    expect(match3.index).toBe(-1);
    expect(match3.item).toBeNull();

    // ID 命中优先于更早出现的同名会话
    const shadowedItems = [
      { id: 7, sesUUID: 'shadow', typeName: '1-29467', name: '1-29467' },
      { id: 8, sesUUID: '1-29467', typeName: '真实目标', name: '真实目标' },
    ];
    const idMatch = findVueSessionItem(shadowedItems, '1-29467');
    expect(idMatch.index).toBe(1);
    expect(idMatch.item?.id).toBe(8);

    // 重名且无 ID 命中时拒绝
    const duplicateNames = [
      { id: 7, sesUUID: 'first', typeName: '重复会话', name: '重复会话' },
      { id: 8, sesUUID: 'second', typeName: '重复会话', name: '重复会话' },
    ];
    expect(findVueSessionItem(duplicateNames, '重复会话')).toEqual({ index: -1, item: null });

    // 未找到
    const match4 = findVueSessionItem(mockItems, '王五');
    expect(match4.index).toBe(-1);
    expect(match4.item).toBeNull();

    // 空边界
    expect(findVueSessionItem(null, 'test')).toEqual({ index: -1, item: null });
    expect(findVueSessionItem([], '')).toEqual({ index: -1, item: null });
  });
});
