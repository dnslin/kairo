import { describe, expect, it } from 'vitest';
import { ThinkingTagCleaner } from '../src/guardrails/thinking-tag-cleaner.js';

describe('ThinkingTagCleaner', () => {
  describe('静态全文清洗 (clean)', () => {
    it('应当直接透传无 <think> 标签的普通文本', () => {
      const input = '您好，我是 KK9 助手，很高兴为您服务！';
      const result = ThinkingTagCleaner.clean(input);

      expect(result.cleanedText).toBe(input);
      expect(result.thinkingText).toBe('');
      expect(result.hasThinking).toBe(false);
    });

    it('应当精确剥离标准闭合的 <think>...</think> 标签', () => {
      const input = '<think>\n用户在询问 KK9 登录方式，需要给出标准指南。\n</think>您好，请使用企业微信或手机验证码登录 KK9 客户端。';
      const result = ThinkingTagCleaner.clean(input);

      expect(result.cleanedText).toBe('您好，请使用企业微信或手机验证码登录 KK9 客户端。');
      expect(result.thinkingText.trim()).toBe('用户在询问 KK9 登录方式，需要给出标准指南。');
      expect(result.hasThinking).toBe(true);
    });

    it('应当处理多个 <think> 标签块', () => {
      const input = '<think>思考第一步</think>第一阶段结果<think>思考第二步</think>最终解答';
      const result = ThinkingTagCleaner.clean(input);

      expect(result.cleanedText).toBe('第一阶段结果最终解答');
      expect(result.thinkingText).toBe('思考第一步\n思考第二步');
      expect(result.hasThinking).toBe(true);
    });

    it('应当处理未闭合的 <think> 标签 (截断场景)', () => {
      const input = '<think>思考进行中但模型被截断';
      const result = ThinkingTagCleaner.clean(input);

      expect(result.cleanedText).toBe('');
      expect(result.thinkingText).toBe('思考进行中但模型被截断');
      expect(result.hasThinking).toBe(true);
    });

    it('应当忽略大小写或属性变体的 <THINK> 标签', () => {
      const input = '<THINK>大写思考过程</THINK>正文回复';
      const result = ThinkingTagCleaner.clean(input);

      expect(result.cleanedText).toBe('正文回复');
      expect(result.thinkingText).toBe('大写思考过程');
      expect(result.hasThinking).toBe(true);
    });
  });

  describe('流式 Chunk 增量清洗 (feed & flush)', () => {
    it('单 chunk 完整标签场景', () => {
      const cleaner = new ThinkingTagCleaner();
      const res = cleaner.feed('<think>思考内容</think>正文内容');
      const final = cleaner.flush();

      expect(res.cleanedChunk).toBe('正文内容');
      expect(res.thinkingChunk).toBe('思考内容');
      expect(cleaner.getAccumulatedThinking()).toBe('思考内容');
      expect(cleaner.getAccumulatedCleaned() + final.cleanedChunk).toBe('正文内容');
    });

    it('跨 Chunk 分割 <think> 开始标签', () => {
      const cleaner = new ThinkingTagCleaner();
      const chunks = ['<th', 'ink>正在', '分析员工', '数据</think>员工', '数据如下'];
      const cleaned: string[] = [];
      const thinking: string[] = [];

      for (const chunk of chunks) {
        const out = cleaner.feed(chunk);
        if (out.cleanedChunk) cleaned.push(out.cleanedChunk);
        if (out.thinkingChunk) thinking.push(out.thinkingChunk);
      }
      const flushed = cleaner.flush();
      if (flushed.cleanedChunk) cleaned.push(flushed.cleanedChunk);
      if (flushed.thinkingChunk) thinking.push(flushed.thinkingChunk);

      expect(cleaned.join('')).toBe('员工数据如下');
      expect(thinking.join('')).toBe('正在分析员工数据');
    });

    it('跨 Chunk 分割 </think> 结束标签', () => {
      const cleaner = new ThinkingTagCleaner();
      const chunks = ['<think>深度思考</th', 'ink>最终', '方案呈现'];
      const cleaned: string[] = [];
      const thinking: string[] = [];

      for (const chunk of chunks) {
        const out = cleaner.feed(chunk);
        if (out.cleanedChunk) cleaned.push(out.cleanedChunk);
        if (out.thinkingChunk) thinking.push(out.thinkingChunk);
      }
      const flushed = cleaner.flush();
      if (flushed.cleanedChunk) cleaned.push(flushed.cleanedChunk);
      if (flushed.thinkingChunk) thinking.push(flushed.thinkingChunk);

      expect(cleaned.join('')).toBe('最终方案呈现');
      expect(thinking.join('')).toBe('深度思考');
    });

    it('伪标签回退机制 (遇到 <thin 后续不是 k> 时应正确退回正文)', () => {
      const cleaner = new ThinkingTagCleaner();
      const chunks = ['这是一段包含 <thin', 'gs> 单词的', '普通文本'];
      const cleaned: string[] = [];

      for (const chunk of chunks) {
        const out = cleaner.feed(chunk);
        if (out.cleanedChunk) cleaned.push(out.cleanedChunk);
      }
      const flushed = cleaner.flush();
      if (flushed.cleanedChunk) cleaned.push(flushed.cleanedChunk);

      expect(cleaned.join('')).toBe('这是一段包含 <things> 单词的普通文本');
      expect(cleaner.getAccumulatedThinking()).toBe('');
    });

    it('遇到普通包含 think 的单词如 <thinkness> 不应误判为标签', () => {
      const cleaner = new ThinkingTagCleaner();
      const chunks = ['这是一段包含 <think', 'ness> 的', '文本'];
      const cleaned: string[] = [];

      for (const chunk of chunks) {
        const out = cleaner.feed(chunk);
        if (out.cleanedChunk) cleaned.push(out.cleanedChunk);
      }
      const flushed = cleaner.flush();
      if (flushed.cleanedChunk) cleaned.push(flushed.cleanedChunk);

      expect(cleaned.join('')).toBe('这是一段包含 <thinkness> 的文本');
      expect(cleaner.getAccumulatedThinking()).toBe('');
    });

    it('流式 processChunk 简明 API', () => {
      const cleaner = new ThinkingTagCleaner();
      const r1 = cleaner.processChunk('<think>隐藏思考');
      const r2 = cleaner.processChunk('继续思考</think>可见正文');
      const r3 = cleaner.flush().cleanedChunk;

      expect(r1).toBe('');
      expect(r2).toBe('可见正文');
      expect(r3).toBe('');
    });

    it('支持多次 reset 复用实例', () => {
      const cleaner = new ThinkingTagCleaner();
      cleaner.feed('<think>思考 1</think>正文 1');
      cleaner.flush();

      cleaner.reset();
      cleaner.feed('<think>思考 2</think>正文 2');
      cleaner.flush();

      expect(cleaner.getAccumulatedCleaned()).toBe('正文 2');
      expect(cleaner.getAccumulatedThinking()).toBe('思考 2');
    });
  });
});
