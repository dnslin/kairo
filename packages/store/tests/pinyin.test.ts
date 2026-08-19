import { describe, expect, it } from 'vitest';
import { getPinyinAbbr } from '../src/utils/pinyin.js';

describe('拼音首字母生成工具 (getPinyinAbbr)', () => {
  it('应正确生成常见中文姓名的拼音首字母缩写', () => {
    expect(getPinyinAbbr('张三丰')).toBe('zsf');
    expect(getPinyinAbbr('李四')).toBe('ls');
    expect(getPinyinAbbr('诸葛孔明')).toBe('zgkm');
    expect(getPinyinAbbr('欧阳六六')).toBe('oyll');
  });

  it('应正确处理单字姓名与常见复姓/多音字', () => {
    expect(getPinyinAbbr('王')).toBe('w');
    // 单/仇/查 等多音姓氏
    expect(getPinyinAbbr('单田芳')).toMatch(/^(stf|dtf)$/);
  });

  it('应正确处理英文、中英混合与数字', () => {
    expect(getPinyinAbbr('Alice')).toBe('alice');
    expect(getPinyinAbbr('Bob Smith')).toBe('bobsmith');
    expect(getPinyinAbbr('王5')).toBe('w5');
    expect(getPinyinAbbr('开发组_01')).toBe('kfz01');
  });

  it('应正确过滤多余空格与特殊符号', () => {
    expect(getPinyinAbbr('  张  三  ')).toBe('zs');
    expect(getPinyinAbbr('李·四')).toBe('ls');
    expect(getPinyinAbbr('赵-六')).toBe('zl');
  });

  it('空字符串与异常输入应安全返回空字符串', () => {
    expect(getPinyinAbbr('')).toBe('');
    expect(getPinyinAbbr('   ')).toBe('');
    // @ts-expect-error 测试非字符串防御
    expect(getPinyinAbbr(null)).toBe('');
    // @ts-expect-error 测试未定义输入防御
    expect(getPinyinAbbr(undefined)).toBe('');
  });
});
