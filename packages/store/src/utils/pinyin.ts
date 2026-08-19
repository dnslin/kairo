import { pinyin } from 'pinyin-pro';

/**
 * 生成中文姓名或字符串的拼音首字母缩写
 *
 * 规则：
 * 1. 提取每个汉字的拼音首字母（如 "张三丰" -> "zsf"）
 * 2. 保留英文字母与数字并转为小写（如 "Alice" -> "alice", "王5" -> "w5"）
 * 3. 过滤空格与标点符号（如 "  张  三  " -> "zs", "李·四" -> "ls"）
 * 4. 防御空字符串或非字符串输入，返回空字符串
 *
 * @param name 姓名或文本字符串
 * @returns 拼音首字母缩写字符串（纯小写字母与数字）
 */
export function getPinyinAbbr(name: string): string {
  if (!name || typeof name !== 'string') {
    return '';
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const rawAbbr = pinyin(trimmed, {
      pattern: 'first',
      toneType: 'none',
      type: 'array',
      v: true,
      surname: 'head',
    });

    return rawAbbr
      .join('')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  } catch {
    // 降级兜底：提取已有英文字母与数字
    return trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
}
