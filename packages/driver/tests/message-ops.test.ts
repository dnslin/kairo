import { describe, expect, it } from 'vitest';
import { MessageOps } from '../src/dom/message-ops.js';

describe('MessageOps 指纹计算与一致性测试', () => {
  it('相同输入应生成完全相同的 SHA-256 指纹', () => {
    const fp1 = MessageOps.generateFingerprint('session_123', '张三', '10:00', '你好');
    const fp2 = MessageOps.generateFingerprint('session_123', '张三', '10:00', '你好');
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64);
  });

  it('不同字段组合使用空字符隔离，不应产生哈希碰撞', () => {
    // 假设无分隔符，'session_1' + '2张三' 与 'session_12' + '张三' 可能碰撞
    const fpA = MessageOps.generateFingerprint('session_1', '2张三', '10:00', '你好');
    const fpB = MessageOps.generateFingerprint('session_12', '张三', '10:00', '你好');
    expect(fpA).not.toBe(fpB);
  });

  it('时间或内容微小变动指纹应彻底改变', () => {
    const fp1 = MessageOps.generateFingerprint('session_1', '张三', '10:00', '你好');
    const fp2 = MessageOps.generateFingerprint('session_1', '张三', '10:01', '你好');
    expect(fp1).not.toBe(fp2);
  });
});
