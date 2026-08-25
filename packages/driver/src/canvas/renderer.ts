/**
 * @kkbot/driver Canvas 2D 视觉卡片渲染引擎与脚本生成器
 *
 * 核心特性：
 * 1. 0 原生编译依赖 (无 node-canvas C++ 绑定)，生成在 Electron/CDP 渲染进程直接执行的自包含脚本
 * 2. 2x Retina 超采样抗锯齿文字与矢量几何渲染
 * 3. 现代化视觉质感：主题色渐变顶栏、高光微质感、精致圆角裁剪与药丸标签 (Pill Tag)
 * 4. 栅格布局与自适应高度：动态计算键值对字段行高、文本折行排版、模拟交互按钮与底部提示
 */

import type { CdpClient } from '../cdp/client.js';
import type {
  CardData,
  CardLayoutResult,
  CardTheme,
  CardThemeType,
  RenderCanvasOptions,
  ResolvedCardTheme,
} from '../types/index.js';
import { DriverError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('canvas-renderer');

/**
 * 默认渲染配置选项
 */
export const DEFAULT_RENDER_OPTIONS: Required<RenderCanvasOptions> = {
  dpr: 2,
  width: 460,
  padding: 18,
  borderRadius: 12,
  fontFamily: '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif',
  headerHeight: 68,
  backgroundColor: '#FFFFFF',
  borderColor: '#E5E6EB',
  shadow: true,
};

/**
 * 内置五大语义主题预设调色板
 */
export const CARD_THEMES: Record<CardThemeType, ResolvedCardTheme> = {
  primary: {
    type: 'primary',
    gradientStart: '#165DFF',
    gradientEnd: '#0E42D2',
    accentColor: '#165DFF',
    tagBg: 'rgba(255, 255, 255, 0.2)',
    tagColor: '#FFFFFF',
    textColor: '#FFFFFF',
    borderColor: '#165DFF',
  },
  success: {
    type: 'success',
    gradientStart: '#00B42A',
    gradientEnd: '#00881E',
    accentColor: '#00B42A',
    tagBg: 'rgba(255, 255, 255, 0.2)',
    tagColor: '#FFFFFF',
    textColor: '#FFFFFF',
    borderColor: '#00B42A',
  },
  warning: {
    type: 'warning',
    gradientStart: '#FF7D00',
    gradientEnd: '#D25F00',
    accentColor: '#FF7D00',
    tagBg: 'rgba(255, 255, 255, 0.2)',
    tagColor: '#FFFFFF',
    textColor: '#FFFFFF',
    borderColor: '#FF7D00',
  },
  danger: {
    type: 'danger',
    gradientStart: '#F53F3F',
    gradientEnd: '#CB2727',
    accentColor: '#F53F3F',
    tagBg: 'rgba(255, 255, 255, 0.2)',
    tagColor: '#FFFFFF',
    textColor: '#FFFFFF',
    borderColor: '#F53F3F',
  },
  info: {
    type: 'info',
    gradientStart: '#4E5969',
    gradientEnd: '#272E3B',
    accentColor: '#4E5969',
    tagBg: 'rgba(255, 255, 255, 0.2)',
    tagColor: '#FFFFFF',
    textColor: '#FFFFFF',
    borderColor: '#4E5969',
  },
};

/**
 * 解析卡片主题配色
 */
export function resolveCardTheme(theme?: CardTheme): ResolvedCardTheme {
  if (!theme) {
    return CARD_THEMES.primary;
  }

  if (typeof theme === 'string') {
    if (theme in CARD_THEMES) {
      return CARD_THEMES[theme];
    }
    return CARD_THEMES.primary;
  }

  if (typeof theme === 'object' && theme !== null) {
    return {
      type: 'custom',
      gradientStart: theme.gradientStart || '#165DFF',
      gradientEnd: theme.gradientEnd || '#0E42D2',
      accentColor: theme.accentColor || theme.gradientStart || '#165DFF',
      tagBg: theme.tagBg || 'rgba(255, 255, 255, 0.2)',
      tagColor: theme.tagColor || '#FFFFFF',
      textColor: theme.textColor || '#FFFFFF',
      borderColor: theme.borderColor || theme.accentColor || '#165DFF',
    };
  }

  return CARD_THEMES.primary;
}

/**
 * 纯 TypeScript 卡片布局尺寸预估与计算
 */
export function calculateCardLayout(
  card: CardData,
  options?: RenderCanvasOptions
): CardLayoutResult {
  const mergedOpts = { ...DEFAULT_RENDER_OPTIONS, ...options };
  const { width, dpr, headerHeight: baseHeaderHeight } = mergedOpts;

  // 1. 计算头部高度
  let headerHeight = baseHeaderHeight;
  if (card.header.subtitle || card.header.icon) {
    headerHeight = Math.max(headerHeight, 70);
  } else {
    headerHeight = Math.max(headerHeight, 56);
  }

  // 2. 计算字段区域高度
  let fieldsHeight = 0;
  const fields = card.fields || [];
  if (fields.length > 0) {
    fieldsHeight += 16; // 顶部间距
    let i = 0;
    while (i < fields.length) {
      const field = fields[i];
      if (!field) {
        i++;
        continue;
      }
      const isSpan2 = field.span === 2 || field.span === 'full';
      if (!isSpan2 && i + 1 < fields.length) {
        const nextField = fields[i + 1];
        const nextIsSpan2 = nextField ? nextField.span === 2 || nextField.span === 'full' : false;
        if (!nextIsSpan2) {
          // 双列并排
          fieldsHeight += 24;
          i += 2;
          continue;
        }
      }

      // 单行全宽，估算长文本折行
      const textLen = (field.label?.length || 0) + (field.value?.length || 0);
      const estLines = Math.max(1, Math.ceil(textLen / 28));
      fieldsHeight += Math.max(24, estLines * 18 + 4);
      i += 1;
    }
    fieldsHeight += 12; // 底部间距
  }

  // 3. 计算按钮区域高度
  let actionsHeight = 0;
  const actions = card.actions || [];
  if (actions.length > 0) {
    actionsHeight += 16; // 分割线与间距
    if (actions.length === 1 || actions.length === 2) {
      actionsHeight += 38 + 12;
    } else {
      const rows = Math.ceil(actions.length / 2);
      actionsHeight += rows * (38 + 10) + 6;
    }
  }

  // 4. 计算页脚区域高度
  let footerHeight = 0;
  if (card.footer) {
    footerHeight = 32;
  }

  const bottomPadding = 12;
  const height = headerHeight + fieldsHeight + actionsHeight + footerHeight + bottomPadding;

  return {
    width,
    height,
    dpr,
    headerHeight,
    fieldsHeight,
    actionsHeight,
    footerHeight,
  };
}

/**
 * 校验卡片数据完整性
 */
function validateCardData(card: CardData): void {
  if (!card || typeof card !== 'object') {
    throw new DriverError('Canvas 卡片数据非法: card 不能为空', 'INVALID_CARD_DATA');
  }
  if (!card.header || typeof card.header !== 'object' || !card.header.title) {
    throw new DriverError(
      'Canvas 卡片数据非法: card.header 及其 title 不能为空',
      'INVALID_CARD_HEADER'
    );
  }
}

/**
 * 生成自包含的 2D Canvas 绘制执行脚本 (供 CDP 渲染进程 evaluate 直接执行)
 */
export function buildCanvasCardScript(card: CardData, options?: RenderCanvasOptions): string {
  validateCardData(card);

  const mergedOpts = { ...DEFAULT_RENDER_OPTIONS, ...options };
  const resolvedTheme = resolveCardTheme(card.theme);

  // 将配置与卡片数据序列化为安全 JSON
  const serializedCard = JSON.stringify(card);
  const serializedOptions = JSON.stringify(mergedOpts);
  const serializedTheme = JSON.stringify(resolvedTheme);

  return `(() => {
    const card = ${serializedCard};
    const options = ${serializedOptions};
    const theme = ${serializedTheme};

    const dpr = Number(options.dpr) || 2;
    const width = Number(options.width) || 460;
    const padding = Number(options.padding) || 18;
    const borderRadius = Number(options.borderRadius) || 12;
    const fontFamily = options.fontFamily || '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif';

    // 1. 创建测量用 Canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法初始化 2D Canvas 渲染上下文');
    }

    // 语义化调色板字典与常量
    const SEMANTIC_COLORS = {
      danger: '#F53F3F',
      warning: '#FF7D00',
      success: '#00B42A',
      primary: '#165DFF',
      info: '#165DFF',
      highlight: '#165DFF',
      muted: '#86909C',
      default: '#1D2129',
    };

    const TAG_THEMES = {
      danger: { bg: 'rgba(245, 63, 63, 0.45)', color: '#FFD2D2' },
      warning: { bg: 'rgba(255, 125, 0, 0.45)', color: '#FFE2B3' },
      success: { bg: 'rgba(0, 180, 42, 0.45)', color: '#D6FFD8' },
    };

    const BUTTON_GRADIENTS = {
      primary: ['#165DFF', '#0E42D2'],
      success: ['#00B42A', '#009A22'],
      danger: ['#F53F3F', '#D82727'],
      warning: ['#FF7D00', '#D25F00'],
    };

    // 圆角矩形绘制通用辅助函数 (支持原生 roundRect 与 arcTo 回退)
    function drawRoundRect(targetCtx, x, y, w, h, radii) {
      if (typeof radii === 'number') {
        radii = [radii, radii, radii, radii];
      } else if (!Array.isArray(radii)) {
        radii = [12, 12, 12, 12];
      }
      const [topLeft, topRight, bottomRight, bottomLeft] = radii;

      if (typeof targetCtx.roundRect === 'function') {
        targetCtx.beginPath();
        targetCtx.roundRect(x, y, w, h, radii);
        return;
      }

      targetCtx.beginPath();
      targetCtx.moveTo(x + topLeft, y);
      targetCtx.lineTo(x + w - topRight, y);
      targetCtx.arcTo(x + w, y, x + w, y + topRight, topRight);
      targetCtx.lineTo(x + w, y + h - bottomRight);
      targetCtx.arcTo(x + w, y + h, x + w - bottomRight, y + h, bottomRight);
      targetCtx.lineTo(x + bottomLeft, y + h);
      targetCtx.arcTo(x, y + h, x, y + h - bottomLeft, bottomLeft);
      targetCtx.lineTo(x, y + topLeft);
      targetCtx.arcTo(x, y, x + topLeft, y, topLeft);
      targetCtx.closePath();
    }

    // 文本折行测量工具函数
    function wrapText(targetCtx, text, maxWidth) {
      if (typeof text !== 'string') text = String(text ?? '');
      const chars = text.split('');
      const lines = [];
      let currentLine = '';

      for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        if (char === '\\n') {
          lines.push(currentLine);
          currentLine = '';
          continue;
        }
        const testLine = currentLine + char;
        const metrics = targetCtx.measureText(testLine);
        if (metrics.width > maxWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = char;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine.length > 0) {
        lines.push(currentLine);
      }
      return lines.length > 0 ? lines : [''];
    }

    // 解析字段的颜色与加粗状态
    function getFieldStyle(field) {
      const isDanger = field.danger || field.variant === 'danger';
      const isWarning = field.variant === 'warning';
      const isSuccess = field.variant === 'success';
      const isHighlight = field.highlight || field.variant === 'highlight' || field.variant === 'info';
      const isMuted = field.variant === 'muted';
      const isBold = isDanger || isWarning || isSuccess || isHighlight;

      let color = SEMANTIC_COLORS.default;
      if (isDanger) color = SEMANTIC_COLORS.danger;
      else if (isWarning) color = SEMANTIC_COLORS.warning;
      else if (isSuccess) color = SEMANTIC_COLORS.success;
      else if (isHighlight) color = SEMANTIC_COLORS.primary;
      else if (isMuted) color = SEMANTIC_COLORS.muted;

      return { color, isBold };
    }

    // 2. 动态测量各模块高度
    const contentWidth = width - padding * 2;
    const hasSubtitle = Boolean(card.header.subtitle || card.header.icon);
    const headerHeight = hasSubtitle ? Math.max(Number(options.headerHeight) || 68, 70) : Math.max(Number(options.headerHeight) || 68, 56);

    let fieldsHeight = 0;
    const fields = Array.isArray(card.fields) ? card.fields : [];
    const fieldRowLayouts = [];

    if (fields.length > 0) {
      fieldsHeight += 16;
      let i = 0;
      while (i < fields.length) {
        const field1 = fields[i];
        const isField1Span2 = field1.span === 2 || field1.span === 'full';

        if (!isField1Span2 && i + 1 < fields.length) {
          const field2 = fields[i + 1];
          const isField2Span2 = field2.span === 2 || field2.span === 'full';
          if (!isField2Span2) {
            // 双列排布
            fieldRowLayouts.push({ type: 'double', fields: [field1, field2], rowHeight: 24 });
            fieldsHeight += 24;
            i += 2;
            continue;
          }
        }

        // 单列排布 (根据 value 折行测量高度)
        ctx.font = '12px ' + fontFamily;
        const labelText = field1.label ? field1.label + '：' : '';
        const labelWidth = ctx.measureText(labelText).width;
        const valMaxWidth = Math.max(100, contentWidth - labelWidth - 8);

        const { isBold } = getFieldStyle(field1);
        ctx.font = isBold ? 'bold 12px ' + fontFamily : '500 12px ' + fontFamily;

        const valLines = wrapText(ctx, field1.value || '', valMaxWidth);
        const rowHeight = Math.max(24, valLines.length * 18 + 4);
        fieldRowLayouts.push({ type: 'single', field: field1, labelText, labelWidth, valLines, rowHeight });
        fieldsHeight += rowHeight;
        i += 1;
      }
      fieldsHeight += 12;
    }

    const actions = Array.isArray(card.actions) ? card.actions : [];
    let actionsHeight = 0;
    if (actions.length > 0) {
      actionsHeight += 16; // 顶部间距与分割线
      if (actions.length === 1 || actions.length === 2) {
        actionsHeight += 38 + 12;
      } else {
        const rows = Math.ceil(actions.length / 2);
        actionsHeight += rows * (38 + 10) + 6;
      }
    }

    let footerHeight = 0;
    if (card.footer) {
      footerHeight = 32;
    }

    const bottomPadding = 12;
    const totalHeight = headerHeight + fieldsHeight + actionsHeight + footerHeight + bottomPadding;

    // 3. 设置 Canvas 2x Retina 像素尺寸
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(totalHeight * dpr);
    ctx.scale(dpr, dpr);

    // 4. 绘制卡片主体背景 (纯白背景 + 微质感阴影 + 浅灰边框)
    if (options.shadow !== false) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.06)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;
    }
    drawRoundRect(ctx, 0.5, 0.5, width - 1, totalHeight - 1, borderRadius);
    ctx.fillStyle = options.backgroundColor || '#FFFFFF';
    ctx.fill();

    // 重置阴影
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.lineWidth = 1;
    ctx.strokeStyle = options.borderColor || '#E5E6EB';
    ctx.stroke();

    // 5. 绘制顶部主题渐变横幅
    ctx.save();
    drawRoundRect(ctx, 0, 0, width, headerHeight, [borderRadius, borderRadius, 0, 0]);
    ctx.clip();

    const bannerGrad = ctx.createLinearGradient(0, 0, width, headerHeight);
    bannerGrad.addColorStop(0, theme.gradientStart || '#165DFF');
    bannerGrad.addColorStop(1, theme.gradientEnd || '#0E42D2');
    ctx.fillStyle = bannerGrad;
    ctx.fillRect(0, 0, width, headerHeight);

    // 微质感顶部微高光
    const highlightGrad = ctx.createLinearGradient(0, 0, 0, headerHeight);
    highlightGrad.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
    highlightGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = highlightGrad;
    ctx.fillRect(0, 0, width, headerHeight);

    ctx.restore();

     // 6. 绘制头部文字与状态标签
     // 副标题/图标
     let titleY = 36;
     if (hasSubtitle) {
       ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
       ctx.font = 'bold 11px ' + fontFamily;
       const subtitleText = (card.header.icon ? card.header.icon + '  ' : '') + (card.header.subtitle || '');
       ctx.fillText(subtitleText, padding, 25);
       titleY = 50;
     }

     // 主标题
     ctx.fillStyle = theme.textColor || '#FFFFFF';
     ctx.font = 'bold 16px ' + fontFamily;

     let availableTitleWidth = width - padding * 2;
     // 若有 Tag 药丸标签，预留右侧宽度
     if (card.header.tag && card.header.tag.text) {
       const tagText = card.header.tag.text;
       ctx.font = 'bold 11px ' + fontFamily;
       const tagTextWidth = ctx.measureText(tagText).width;
       const tagW = tagTextWidth + 16;
       const tagH = 22;
       const tagX = width - padding - tagW;
       const tagY = hasSubtitle ? 16 : (headerHeight - tagH) / 2;

       // 绘制 Tag 药丸
       drawRoundRect(ctx, tagX, tagY, tagW, tagH, 11);
       const tagVariant = card.header.tag.variant;
       const tagTheme = (tagVariant && tagVariant in TAG_THEMES) ? TAG_THEMES[tagVariant] : null;

       const tagBg = card.header.tag.bgColor || tagTheme?.bg || theme.tagBg || 'rgba(255, 255, 255, 0.2)';
       const tagColor = card.header.tag.color || tagTheme?.color || theme.tagColor || '#FFFFFF';

       ctx.fillStyle = tagBg;
       ctx.fill();

       ctx.lineWidth = 1;
       ctx.strokeStyle = card.header.tag.borderColor || 'rgba(255, 255, 255, 0.35)';
       ctx.stroke();

       ctx.fillStyle = tagColor;
       ctx.font = 'bold 11px ' + fontFamily;
       ctx.fillText(tagText, tagX + 8, tagY + 15);

       availableTitleWidth -= (tagW + 12);
     }

     // 绘制主标题文本 (超长截断处理)
     ctx.fillStyle = theme.textColor || '#FFFFFF';
     ctx.font = 'bold 16px ' + fontFamily;
     let titleStr = card.header.title;
     if (ctx.measureText(titleStr).width > availableTitleWidth) {
       while (titleStr.length > 1 && ctx.measureText(titleStr + '…').width > availableTitleWidth) {
         titleStr = titleStr.slice(0, -1);
       }
       titleStr += '…';
     }
     ctx.fillText(titleStr, padding, titleY);

     // 绘制单列字段复用辅助函数
     function drawFieldItem(targetField, targetX, targetWidth, targetY) {
       ctx.fillStyle = SEMANTIC_COLORS.muted;
       ctx.font = '12px ' + fontFamily;
       const label = targetField.label ? targetField.label + '：' : '';
       ctx.fillText(label, targetX, targetY + 12);

       const { color, isBold } = getFieldStyle(targetField);
       ctx.fillStyle = color;
       ctx.font = isBold ? 'bold 12px ' + fontFamily : '500 12px ' + fontFamily;
       const valueStr = targetField.value || '';
       const valW = ctx.measureText(valueStr).width;
       ctx.fillText(valueStr, targetX + targetWidth - valW, targetY + 12);
     }

     // 7. 绘制结构化属性字段
     let currentY = headerHeight + 16;
     for (const row of fieldRowLayouts) {
       if (row.type === 'single') {
         const { field, labelText, labelWidth, valLines, rowHeight } = row;
         // 绘制标签
         ctx.fillStyle = SEMANTIC_COLORS.muted;
         ctx.font = '12px ' + fontFamily;
         ctx.fillText(labelText, padding, currentY + 12);

         const { color, isBold } = getFieldStyle(field);
         ctx.fillStyle = color;
         ctx.font = isBold ? 'bold 12px ' + fontFamily : '500 12px ' + fontFamily;

         if (valLines.length === 1) {
           // 单行时靠右对齐展示
           const valW = ctx.measureText(valLines[0]).width;
           ctx.fillText(valLines[0], width - padding - valW, currentY + 12);
         } else {
           // 多行时靠左紧随标签后展示
           let lineY = currentY + 12;
           for (const line of valLines) {
             ctx.fillText(line, padding + labelWidth + 4, lineY);
             lineY += 18;
           }
         }
         currentY += rowHeight;
       } else if (row.type === 'double') {
         // 双列字段复用 drawFieldItem
         const [field1, field2] = row.fields;
         const colWidth = (contentWidth - 16) / 2;

         drawFieldItem(field1, padding, colWidth, currentY);
         drawFieldItem(field2, padding + colWidth + 16, colWidth, currentY);

         currentY += row.rowHeight;
       }
     }

     // 8. 绘制分割线与模拟操作按钮
     if (actions.length > 0) {
       // 细分割线
       ctx.strokeStyle = '#F2F3F5';
       ctx.lineWidth = 1;
       ctx.beginPath();
       ctx.moveTo(padding, currentY + 4);
       ctx.lineTo(width - padding, currentY + 4);
       ctx.stroke();

       currentY += 16;

       const btnH = 38;
       const btnRadius = 6;

       if (actions.length === 1) {
         // 单个全宽按钮
         drawActionButton(ctx, padding, currentY, contentWidth, btnH, btnRadius, actions[0]);
         currentY += btnH + 12;
       } else if (actions.length === 2) {
         // 两个并排按钮
         const btnW = (contentWidth - 12) / 2;
         drawActionButton(ctx, padding, currentY, btnW, btnH, btnRadius, actions[0]);
         drawActionButton(ctx, padding + btnW + 12, currentY, btnW, btnH, btnRadius, actions[1]);
         currentY += btnH + 12;
       } else {
         // 多按钮栅格排布
         const btnW = (contentWidth - 12) / 2;
         for (let idx = 0; idx < actions.length; idx++) {
           const rowIdx = Math.floor(idx / 2);
           const colIdx = idx % 2;
           const bx = padding + colIdx * (btnW + 12);
           const by = currentY + rowIdx * (btnH + 10);
           drawActionButton(ctx, bx, by, btnW, btnH, btnRadius, actions[idx]);
         }
         currentY += Math.ceil(actions.length / 2) * (btnH + 10) + 4;
       }
     }

     // 辅助函数：绘制单个按钮
     function drawActionButton(targetCtx, x, y, w, h, radius, action) {
       drawRoundRect(targetCtx, x, y, w, h, radius);

       const variant = action.variant || 'primary';
       if (action.bgColor) {
         targetCtx.fillStyle = action.bgColor;
         targetCtx.fill();
       } else if (variant === 'secondary' || variant === 'default') {
         targetCtx.fillStyle = '#F2F3F5';
         targetCtx.fill();
         targetCtx.lineWidth = 1;
         targetCtx.strokeStyle = '#E5E6EB';
         targetCtx.stroke();
       } else if (variant === 'outline') {
         targetCtx.fillStyle = '#FFFFFF';
         targetCtx.fill();
         targetCtx.lineWidth = 1;
         targetCtx.strokeStyle = action.color || SEMANTIC_COLORS.primary;
         targetCtx.stroke();
       } else {
         // 渐变按钮 (primary / success / danger / warning)
         const [gStart, gEnd] = BUTTON_GRADIENTS[variant] || BUTTON_GRADIENTS.primary;
         const bgGrad = targetCtx.createLinearGradient(x, y, x, y + h);
         bgGrad.addColorStop(0, gStart);
         bgGrad.addColorStop(1, gEnd);
         targetCtx.fillStyle = bgGrad;
         targetCtx.fill();
       }

       // 按钮文字
       let btnLabel = (action.icon ? action.icon + '  ' : '') + (action.text || '');
       if (action.replyCommand) {
         btnLabel += ' (' + action.replyCommand + ')';
       }

       let textColor = '#FFFFFF';
       if (action.color) {
         textColor = action.color;
       } else if (variant === 'secondary' || variant === 'default') {
         textColor = SEMANTIC_COLORS.default;
       } else if (variant === 'outline') {
         textColor = SEMANTIC_COLORS.primary;
       }

       targetCtx.fillStyle = textColor;
       targetCtx.font = 'bold 12.5px ' + fontFamily;
       const textW = targetCtx.measureText(btnLabel).width;
       targetCtx.fillText(btnLabel, x + (w - textW) / 2, y + (h + 8) / 2);
     }

     // 9. 绘制底部提示栏 / 页脚
     if (card.footer) {
       let footerText = '';
       let footerIcon = '';
       let footerAlign = 'center';

       if (typeof card.footer === 'string') {
         footerText = card.footer;
       } else if (typeof card.footer === 'object' && card.footer !== null) {
         footerText = card.footer.text || '';
         footerIcon = card.footer.icon ? card.footer.icon + ' ' : '';
         footerAlign = card.footer.align || 'center';
       }

       const fullFooter = footerIcon + footerText;
       ctx.fillStyle = SEMANTIC_COLORS.muted;
       ctx.font = '11px ' + fontFamily;

       const fWidth = ctx.measureText(fullFooter).width;
       let fx = (width - fWidth) / 2;
       if (footerAlign === 'left') {
         fx = padding;
       } else if (footerAlign === 'right') {
         fx = width - padding - fWidth;
       }

       ctx.fillText(fullFooter, fx, currentY + 16);
     }

     // 10. 导出高清 Base64 PNG
    return canvas.toDataURL('image/png');
  })()`;
}

/**
 * 通过 CDP 运行时远程执行 Canvas 卡片渲染，并返回 Base64 编码的图片数据
 */
export async function renderCardToBase64(
  cdp: CdpClient,
  card: CardData,
  options?: RenderCanvasOptions
): Promise<string> {
  const script = buildCanvasCardScript(card, options);
  log.debug({ title: card.header?.title }, '开始在 CDP 渲染进程中执行 Canvas 卡片绘制脚本...');

  try {
    const dataUrl = await cdp.evaluate<string>(script);
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new DriverError(
        'CDP 执行 Canvas 绘制脚本未返回有效的图片 DataURL',
        'CANVAS_EVAL_FAILED'
      );
    }
    return dataUrl;
  } catch (err) {
    throw new DriverError(
      `执行 Canvas 卡片绘制失败: ${err instanceof Error ? err.message : String(err)}`,
      'CANVAS_RENDER_ERROR',
      err instanceof Error ? err : undefined
    );
  }
}
