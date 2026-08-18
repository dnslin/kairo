# CONFIG MODULE

## OVERVIEW

YAML 配置加载 + 环境变量替换 + chokidar 热重载。4 个文件，所有配置类型定义集中在 schema.ts。

## KEY FILES

| File         | Lines | Purpose                                  |
| ------------ | ----- | ---------------------------------------- |
| `schema.ts`  | 116   | 所有配置接口定义 (AppConfig 为根类型)    |
| `loader.ts`  | 64    | YAML 解析 + `${ENV_VAR}` 替换 + 单例缓存 |
| `watcher.ts` | 35    | chokidar 文件监听器，选择器热重载        |
| `index.ts`   | 19    | Re-exports (14 types + 3 functions)      |

## WHERE TO LOOK

| Task         | Location                                          |
| ------------ | ------------------------------------------------- |
| 配置类型定义 | `schema.ts` - 12 个子配置接口                     |
| 加载配置     | `loader.ts:33` - `loadConfig(path?)`              |
| 获取单例     | `loader.ts:53` - `getConfig()`                    |
| 强制重载     | `loader.ts:60` - `reloadConfig()`                 |
| 热重载选择器 | `watcher.ts:8` - `watchSelectors(path, callback)` |
| 环境变量替换 | `loader.ts:9` - `resolveEnvVariables()`           |

## CONFIG HIERARCHY

## ENV VAR SUBSTITUTION

`config.yaml` 支持 `${ENV_VAR}` 语法：

递归处理所有嵌套值（字符串、数组、对象）。

## HOT-RELOAD

仅选择器支持热重载。其他配置变更需重启。

## DEPENDENCIES

**External**: `js-yaml`, `chokidar`, `node:fs`, `node:path`  
**Internal**: `utils/logger.js`

## ANTI-PATTERNS

- **不要直接读取 config.yaml** - 使用 `getConfig()` 单例
- **不要绕过环境变量替换** - 敏感信息必须用 `${VAR}` 语法
- **不要假设热重载影响所有配置** - 仅 selectors 支持
- **不要使用 Zod** - 项目使用纯 TS 接口
