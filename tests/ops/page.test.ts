import { describe, it, expect } from 'vitest';
import { getHtmlPage } from '../../src/ops/page.js';

describe('getHtmlPage', () => {
  it('returns valid HTML string with React and Tailwind', () => {
    const html = getHtmlPage();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('https://cdn.tailwindcss.com');
    expect(html).toContain('https://esm.sh/react@18.2.0');
    expect(html).toContain('https://esm.sh/react-dom@18.2.0/client');
    expect(html).toContain('<div id="root"');
  });
});
