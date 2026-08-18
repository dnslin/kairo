import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTORS, resolveSelectors } from '../src/dom/selectors.js';

describe('SelectorsConfig 测试', () => {
  it('默认配置应包含所有核心选择器', () => {
    expect(DEFAULT_SELECTORS.sessionList).toBeTruthy();
    expect(DEFAULT_SELECTORS.messageItem).toBeTruthy();
    expect(DEFAULT_SELECTORS.inputBox).toBeTruthy();
    expect(DEFAULT_SELECTORS.sendButton).toBeTruthy();
    expect(DEFAULT_SELECTORS.virtualScroller).toBe('.vue-recycle-scroller');
  });

  it('自定义选择器应正确覆盖默认项，同时保留其余默认项', () => {
    const custom = resolveSelectors({
      inputBox: '#custom-input',
    });
    expect(custom.inputBox).toBe('#custom-input');
    expect(custom.sendButton).toBe(DEFAULT_SELECTORS.sendButton);
  });
});
