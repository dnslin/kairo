import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultBotDirectory, loadBotConfig } from '../../src/config/load.js';
import { loadBotCustomization } from '../../src/modules/bot-customization/instructions.js';
import { startKairo } from '../../src/index.js';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'kairo-customization-'));
  try {
    await cp(defaultBotDirectory, directory, { recursive: true });
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function agentFor(directory = defaultBotDirectory) {
  const { config } = await loadBotConfig(directory);
  return new Agent({
    id: 't16-contract',
    name: 'T16 合同',
    model: new MastraLanguageModelV2Mock({}),
    ...(await loadBotCustomization(config, directory)),
  });
}

describe('T16 原生 filesystem Skill 合同', () => {
  it('发现用户真实技能，并通过原生接口读取正文', async () => {
    const agent = await agentFor();
    const skills = await agent.listSkills();
    expect(skills.map(skill => skill.name)).toEqual(['reader-sim']);
    expect(skills[0]?.description).toContain('first-time reader persona');
    const skill = await agent.getSkill('reader-sim');
    expect(skill?.instructions).toContain('Transportation');
    expect(skill?.instructions).toContain('Anchor claims to the text');
  });

  it.each([
    ['缺少 description', '---\nname: reader-sim\n---\n测试技能正文'],
    ['name 与目录不符', '---\nname: other-skill\ndescription: 测试技能\n---\n测试技能正文'],
  ])('已启用 Skill %s 时，在数据库和监听初始化前拒绝启动', async (_scenario, source) => {
    await fixture(async directory => {
      await writeFile(join(directory, 'skills', 'reader-sim', 'SKILL.md'), source);
      // 空连接用于证明失败先于数据库初始化，而非启动后碰巧遇到其他错误。
      await expect(
        startKairo({ configDirectory: directory, databaseUrl: '', port: 0 })
      ).rejects.toThrow(/reader-sim/);
    });
  });

  it('在原生解析之前拒绝 JavaScript 元数据，不执行其中的测试标记', async () => {
    await fixture(async directory => {
      const marker = `KAIRO_T16_${randomUUID().replaceAll('-', '')}`;
      try {
        await writeFile(
          join(directory, 'skills', 'reader-sim', 'SKILL.md'),
          `---javascript\n(process.env[${JSON.stringify(marker)}] = '已执行', { name: 'reader-sim', description: '无害执行门禁测试' })\n---\n测试正文`
        );
        const result: unknown = await startKairo({
          configDirectory: directory,
          databaseUrl: '',
          port: 0,
        }).catch((error: unknown) => error);
        expect(process.env[marker]).toBeUndefined();
        expect(result).toBeInstanceOf(Error);
        expect(result).toHaveProperty('message', expect.stringContaining('SKILL.md'));
      } finally {
        delete process.env[marker];
      }
    });
  });

  it('接受带 UTF-8 BOM 和 CRLF 的标准 YAML 技能', async () => {
    await fixture(async directory => {
      const file = join(directory, 'skills', 'reader-sim', 'SKILL.md');
      const source = await readFile(file, 'utf8');
      await writeFile(file, `\uFEFF${source.replace(/\r?\n/g, '\r\n')}`);
      const agent = await agentFor(directory);
      expect((await agent.getSkill('reader-sim'))?.instructions).toContain('Transportation');
    });
  });

  it('未启用目录不能通过名称或绝对路径加载', async () => {
    await fixture(async directory => {
      const disabled = join(directory, 'skills', 'disabled');
      await mkdir(disabled, { recursive: true });
      await writeFile(
        join(disabled, 'SKILL.md'),
        '---\nname: disabled\ndescription: 未批准能力\n---\n未批准资料'
      );
      const agent = await agentFor(directory);
      expect((await agent.listSkills()).map(skill => skill.name)).toEqual(['reader-sim']);
      expect(await agent.getSkill('disabled')).toBeNull();
      expect(await agent.getSkill(disabled)).toBeNull();
      expect(await agent.getSkill(join(disabled, 'SKILL.md'))).toBeNull();
    });
  });

  it('原生读取工具拒绝越界资源，搜索不暴露未启用内容', async () => {
    await fixture(async directory => {
      const disabled = join(directory, 'skills', 'disabled');
      await mkdir(disabled, { recursive: true });
      await writeFile(
        join(disabled, 'SKILL.md'),
        '---\nname: disabled\ndescription: 未批准能力\n---\n隐蔽测试资料'
      );
      const agent = await agentFor(directory);
      const tools = await agent.getToolsForExecution({});
      await expect(
        tools.skill_read!.execute!(
          { skillName: 'reader-sim', path: '../disabled/SKILL.md' },
          { toolCallId: 'escape', messages: [] }
        )
      ).rejects.toThrow();
      const result: unknown = await tools.skill_search!.execute!(
        { query: '隐蔽测试资料' },
        { toolCallId: 'search', messages: [] }
      );
      expect(JSON.stringify(result)).not.toContain('隐蔽测试资料');
    });
  });

  it('禁用全部 Skill 后不向 Agent 提供技能或资源工具', async () => {
    const { config } = await loadBotConfig();
    config.skills = [];
    const agent = new Agent({
      id: 't16-no-skills',
      name: '无技能合同',
      model: new MastraLanguageModelV2Mock({}),
      ...(await loadBotCustomization(config)),
    });
    expect(await agent.listSkills()).toEqual([]);
    expect(await agent.getSkill('reader-sim')).toBeNull();
    expect(await agent.getToolsForExecution({})).toEqual({});
  });

  it('脚本只作为资源可发现，不产生 Workspace、Sandbox 或执行工具', async () => {
    await fixture(async directory => {
      const scripts = join(directory, 'skills', 'reader-sim', 'scripts');
      await mkdir(scripts);
      await writeFile(join(scripts, 'probe.js'), 'throw new Error("脚本不应执行");');
      const agent = await agentFor(directory);
      const tools = await agent.getToolsForExecution({});
      const content: unknown = await tools.skill_read!.execute!(
        { skillName: 'reader-sim', path: 'scripts/probe.js' },
        { toolCallId: 'read-script', messages: [] }
      );
      expect(JSON.stringify(content)).toContain('脚本不应执行');
      expect(await agent.getWorkspace()).toBeUndefined();
      expect(Object.keys(await agent.getToolsForExecution({})).sort()).toEqual([
        'skill',
        'skill_read',
        'skill_search',
      ]);
    });
  });

  it('缺少人格或规则文件时明确失败，不静默使用默认文本', async () => {
    await fixture(async directory => {
      const { config } = await loadBotConfig(directory);
      await rm(join(directory, 'SOUL.md'));
      await expect(loadBotCustomization(config, directory)).rejects.toThrow(/SOUL\.md/);
      await writeFile(join(directory, 'SOUL.md'), '测试人格');
      await rm(join(directory, 'AGENTS.md'));
      await expect(loadBotCustomization(config, directory)).rejects.toThrow(/AGENTS\.md/);
    });
  });
});

describe('T16 Skill 启动失败的完整日志', () => {
  let directory: string;
  let applicationDirectory: string;
  let skillFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kairo-skill-startup-'));
    applicationDirectory = join(directory, 'apps', 'kairo');
    const configDirectory = join(directory, 'config', 'bots', 'default');
    await mkdir(applicationDirectory, { recursive: true });
    await cp(defaultBotDirectory, configDirectory, { recursive: true });
    skillFile = join(configDirectory, 'skills', 'reader-sim', 'SKILL.md');
    await writeFile(join(applicationDirectory, 'package.json'), '{"type":"module"}');
    const applicationSource = fileURLToPath(new URL('../../', import.meta.url));
    const repository = fileURLToPath(new URL('../../../../', import.meta.url));
    // 复用现有启动回归的隔离方式，保留 pnpm 相对链接并编译当前源码。
    await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'junction');
    await symlink(
      join(applicationSource, 'node_modules'),
      join(applicationDirectory, 'node_modules'),
      'junction'
    );
    const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    await promisify(execFile)(
      process.execPath,
      [
        compiler,
        '-p',
        join(applicationSource, 'tsconfig.json'),
        '--outDir',
        join(applicationDirectory, 'dist'),
      ],
      { timeout: 30000 }
    );
  }, 30000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    [
      '未知 YAML 标签',
      '---\nname: reader-sim\ndescription: !invalid t16-secret\n---\n测试正文',
      false,
    ],
    [
      '元数据名称不匹配并触发长正文警告',
      `---\nname: t16-secret\ndescription: 测试技能\n---\n${'测试正文\n'.repeat(501)}`,
      true,
    ],
  ] as const)(
    '%s 拒绝启动且完整输出没有文件内容',
    async (_scenario, source, hasLineWarning) => {
      await writeFile(skillFile, source);
      const result = await new Promise<{ code: string | number; stdout: string; stderr: string }>(
        resolve => {
          execFile(
            process.execPath,
            [join(applicationDirectory, 'dist', 'index.js')],
            { cwd: applicationDirectory, encoding: 'utf8', timeout: 10000 },
            (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
          );
        }
      );
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain('t16-secret');
      expect(result.stderr).toContain(skillFile);
      if (hasLineWarning) expect(result.stderr).toMatch(/\b501\b/);
    },
    15000
  );
});
