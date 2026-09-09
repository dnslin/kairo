import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parseDocument } from 'yaml';
import { botConfigSchema } from './schema.js';
import type { BotConfig } from './schema.js';

export const defaultBotDirectory = fileURLToPath(
  new URL('../../../../config/bots/default/', import.meta.url)
);

export interface LoadedBotConfig {
  config: BotConfig;
  configDigest: string;
}

// 正式入口固定使用默认目录；目录参数只供程序内调用和隔离测试，不提供 CLI 或环境覆盖。
export async function loadBotConfig(
  directory = defaultBotDirectory,
  availableTools: readonly string[] = []
): Promise<LoadedBotConfig> {
  const source = await readFile(join(directory, 'bot.yaml'));
  const lineCounter = new LineCounter();
  const document = parseDocument(source.toString('utf8'), {
    prettyErrors: false,
    lineCounter,
    stringKeys: true,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) {
    const locations = problems.map(problem => {
      const { line, col } = lineCounter.linePos(problem.pos[0]);
      return `${problem.code}（${line}:${col}）`;
    });
    // YAML 原始错误可能包含误写的凭证；保留类别和行列，不附带源文本。
    throw new Error(`Bot 配置 YAML 无效：${locations.join('、')}`);
  }
  let input: unknown;
  try {
    input = document.toJS();
  } catch {
    throw new Error('Bot 配置 YAML 无法转换，请检查别名引用');
  }
  const parsed = botConfigSchema.safeParse(input);
  if (!parsed.success) {
    const paths = parsed.error.issues.map(
      issue => `${issue.path.join('.') || '根配置'}（${issue.code}）`
    );
    throw new Error(`Bot 配置校验失败：${paths.join('、')}；只允许已定义的非凭证字段`);
  }
  const config = parsed.data;
  for (const [index, name] of config.tools.entries()) {
    if (!availableTools.includes(name)) {
      throw new Error(`Bot 配置 tools.${index} 引用未注册或未批准的 Tool`);
    }
  }

  const hash = createHash('sha256');
  const files = new Set<string>();
  async function hashDirectory(relativeDirectory: string): Promise<void> {
    const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await hashDirectory(relativePath);
      } else {
        const content =
          relativePath === 'bot.yaml' ? source : await readFile(join(directory, relativePath));
        files.add(relativePath);
        // 相对路径和内容长度分隔各文件，摘要与部署绝对路径无关。
        hash
          .update(relativePath)
          .update('\0')
          .update(String(content.length))
          .update('\0')
          .update(content);
      }
    }
  }
  await hashDirectory('');
  for (const [index, name] of config.skills.entries()) {
    if (!files.has(`skills/${name}/SKILL.md`)) {
      throw new Error(`Bot 配置 skills.${index} 缺少受控目录中的 SKILL.md`);
    }
  }
  return { config, configDigest: hash.digest('hex') };
}
