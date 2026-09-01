# Canvas 2D 视觉卡片渲染引擎设计与实现规范

> **文档性质**：技术规格与实现归档（从 `@kkbot/driver` 核心剥离，用于在新独立模块中实现）  
> **设计目标**：无原生编译依赖（0 `node-canvas` / C++ 绑定），在 Electron / CDP 浏览器渲染进程中直接执行 2D Canvas 绘制并导出高清 Base64 PNG。

---

## 1. 核心架构与数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        业务上层 (Bot / App / Agent)                     │
│        createAlertCard / createReportCard / createDecisionCard          │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ CardData 数据模型
┌────────────────────────────────────▼────────────────────────────────────┐
│              卡片脚本编译器 (buildCanvasCardScript)                       │
│  - 纯函数计算布局尺寸 (calculateCardLayout)                             │
│  - 解析主题调色板 (resolveCardTheme)                                     │
│  - 生成自包含可执行 JS 脚本 (包含 2x Retina 超采样、文本折行、几何圆角) │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ JavaScript 绘制代码
┌────────────────────────────────────▼────────────────────────────────────┐
│                     CDP 运行时 (CdpClient.evaluate)                      │
│            document.createElement('canvas') -> ctx.toDataURL()          │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Base64 Image DataURL
┌────────────────────────────────────▼────────────────────────────────────┐
│                    IM 消息驱动器 (Driver.sendImage)                     │
│               本地剪贴板写入 / 文件暂存 -> 发送上屏 -> 垃圾回收          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 强类型系统定义 (`types/card.ts`)

```typescript
export type CardThemeType = 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface CardThemeCustom {
  gradientStart: string;
  gradientEnd: string;
  accentColor?: string;
  tagBg?: string;
  tagColor?: string;
  textColor?: string;
  borderColor?: string;
}

export type CardTheme = CardThemeType | CardThemeCustom;
export type CardTagVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface CardTag {
  text: string;
  variant?: CardTagVariant;
  color?: string;
  bgColor?: string;
  borderColor?: string;
}

export interface CardHeader {
  title: string;
  subtitle?: string;
  icon?: string;
  tag?: CardTag;
  extra?: string;
}

export type CardFieldVariant = 'default' | 'muted' | 'highlight' | 'danger' | 'warning' | 'success' | 'info';
export type CardFieldSpan = 1 | 2 | 'half' | 'full';

export interface CardField {
  label: string;
  value: string;
  variant?: CardFieldVariant;
  danger?: boolean;
  highlight?: boolean;
  span?: CardFieldSpan;
}

export type CardActionVariant = 'primary' | 'success' | 'warning' | 'danger' | 'secondary' | 'default' | 'outline';

export interface CardAction {
  text: string;
  variant?: CardActionVariant;
  icon?: string;
  replyCommand?: string;
  color?: string;
  bgColor?: string;
}

export interface CardFooter {
  text: string;
  icon?: string;
  timestamp?: string | number;
  align?: 'left' | 'center' | 'right';
}

export interface CardData {
  theme?: CardTheme;
  header: CardHeader;
  fields?: CardField[];
  actions?: CardAction[];
  footer?: CardFooter | string;
  metadata?: Record<string, unknown>;
}

export interface RenderCanvasOptions {
  dpr?: number;
  width?: number;
  padding?: number;
  borderRadius?: number;
  fontFamily?: string;
  headerHeight?: number;
  backgroundColor?: string;
  borderColor?: string;
  shadow?: boolean;
}
```

---

## 3. 核心算法与绘制引擎实现

### 3.1 预设调色板与主题解析
```typescript
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
```

### 3.2 布局高度与文本折行动态计算
1. **头部高度**：有副标题/图标时至少 70px，单标题时 56px。
2. **两列双排与长文本折行**：
   - 连续两个 `span: 1` 字段自动并排为双列网格，行高 24px。
   - `span: 2` 单列全宽字段，根据标签宽度与文本字符长度调用 `wrapText` 动态折行，行高计算为 `Math.max(24, valLines.length * 18 + 4)`。
3. **按钮栅格**：1 个全宽、2 个并排、3 个以上自动按 2 列多行栅格布局。
4. **2x Retina 超采样**：
   ```javascript
   canvas.width = Math.round(width * dpr);
   canvas.height = Math.round(totalHeight * dpr);
   ctx.scale(dpr, dpr);
   ```

---

## 4. 业务卡片模板库实现

### 4.1 监控告警卡片 (`createAlertCard`)
- 自动根据 `severity`（critical/high/medium/low/info）映射主题色（danger/warning/info）。
- 指标超标（`exceeded !== false`）自动标红。
- 自动格式化时间戳并注入排查操作按钮。

### 4.2 汇总巡检报告卡片 (`createReportCard`)
- 根据 `status`（success/warning/failure/running）选择配色。
- 将编号、耗时（`duration`）和核心指标（`metrics`）两列网格化排布。

### 4.3 多选决策卡片 (`createDecisionCard`)
- 为推荐选项注入高亮标识（`⭐ 选项 1 [推荐]`）。
- 自动根据 `options` 生成对应的模拟操作按钮和快捷指令（`回复 1 / 2`）。
