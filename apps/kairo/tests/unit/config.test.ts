import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { loadBotConfig } from '../../src/config/load.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { botConfigSchema } from '../../src/config/schema.js';
import { startKairo } from '../../src/index.js';
import { ApplicationTestDriver } from '../helpers/application-driver.js';

function validConfig() {
  return {
    model: { id: 'provider/model', url: 'https://model.example/v1' },
    datasetId: 'erp-dataset',
    employeeAllowlist: ['3585'],
    tools: [],
    skills: [],
    agent: { maxSteps: 20 },
    batching: { quietMs: 5000, maxWaitMs: 60000, maxMessages: 10, maxChars: 30000 },
    concurrency: { global: 3, perSessionQueue: 3 },
    timeouts: {
      queueMs: 600000,
      executionMs: 240000,
      progressMs: 10000,
      sendQueryMs: 30000,
      generalKnowledgeWaitMs: 600000,
      contextIdleMs: 7200000,
    },
  };
}

describe('T15 Bot 配置结构', () => {
  it('接受单模型、单 Dataset、明确员工名单与显式空能力列表', () => {
    const config = validConfig();
    expect(botConfigSchema.parse(config)).toEqual(config);
  });

  it.each(['model', 'datasetId', 'employeeAllowlist', 'tools', 'skills', 'agent'])(
    '缺少 %s 时拒绝，不隐式补出正式配置',
    key => {
      const config: Record<string, unknown> = validConfig();
      delete config[key];
      expect(botConfigSchema.safeParse(config).success).toBe(false);
    }
  );

  it('拒绝第二模型、第二 Dataset 和空员工名单', () => {
    for (const patch of [
      { model: [validConfig().model, validConfig().model] },
      { model: { ...validConfig().model, fallback: 'provider/other' } },
      { datasetId: ['erp', 'other'] },
      { employeeAllowlist: [] },
    ]) {
      expect(botConfigSchema.safeParse({ ...validConfig(), ...patch }).success).toBe(false);
    }
  });

  it('运行限制必须是正整数，不能使用负数、零、小数或字符串', () => {
    const config = validConfig();
    for (const group of ['agent', 'batching', 'concurrency', 'timeouts'] as const) {
      for (const key of Object.keys(config[group])) {
        for (const value of [-1, 0, 1.5, '3']) {
          const input = { ...config, [group]: { ...config[group], [key]: value } };
          expect(botConfigSchema.safeParse(input).success, `${group}.${key}=${value}`).toBe(false);
        }
      }
    }
  });

  it('拒绝矛盾的时间参数和超过阶段一边界的输入上限', () => {
    const config = validConfig();
    for (const patch of [
      { batching: { ...config.batching, quietMs: 60001 } },
      { timeouts: { ...config.timeouts, progressMs: 240000 } },
      { batching: { ...config.batching, maxChars: 30001 } },
      { batching: { ...config.batching, maxMessages: 11 } },
    ]) {
      expect(botConfigSchema.safeParse({ ...config, ...patch }).success).toBe(false);
    }
  });

  it('拒绝重复引用、目录外 Skill 和包含凭证的模型地址', () => {
    for (const patch of [
      { skills: ['erp', 'erp'] },
      { tools: ['search', 'search'] },
      { employeeAllowlist: ['3585', '3585'] },
      { skills: ['../unapproved'] },
      { model: { id: 'provider/model', url: 'https://user:secret@model.example/v1' } },
    ]) {
      expect(botConfigSchema.safeParse({ ...validConfig(), ...patch }).success).toBe(false);
    }
  });

  it.each(['password', 'apiKey', 'API_KEY', 'Authorization', 'databaseUrl'])(
    '拒绝在根配置或模型中误写 %s 凭证字段',
    key => {
      const config = validConfig();
      expect(botConfigSchema.safeParse({ ...config, [key]: '测试凭证' }).success).toBe(false);
      expect(
        botConfigSchema.safeParse({ ...config, model: { ...config.model, [key]: '测试凭证' } })
          .success
      ).toBe(false);
    }
  );
});

async function withConfig(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'kairo-config-'));
  try {
    await writeFile(join(directory, 'bot.yaml'), stringify(validConfig()));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('T15 受控配置读取', () => {
  it('实际读取完整配置文件', async () => {
    await withConfig(async directory => {
      expect((await loadBotConfig(directory)).config).toEqual(validConfig());
    });
  });

  it('拒绝尚未实现或未注册的 Tool', async () => {
    await withConfig(async directory => {
      await writeFile(
        join(directory, 'bot.yaml'),
        stringify({ ...validConfig(), tools: ['knowledge-search'] })
      );
      await expect(loadBotConfig(directory, [])).rejects.toThrow(/tools/);
      expect((await loadBotConfig(directory)).config.tools).toEqual(['knowledge-search']);
    });
  });

  it('只接受受控目录中存在且明确启用的 Skill 引用', async () => {
    await withConfig(async directory => {
      await writeFile(
        join(directory, 'bot.yaml'),
        stringify({ ...validConfig(), skills: ['erp'] })
      );
      await expect(loadBotConfig(directory)).rejects.toThrow(/skills/);
      await mkdir(join(directory, 'skills', 'erp'), { recursive: true });
      await writeFile(
        join(directory, 'skills', 'erp', 'SKILL.md'),
        '单元测试临时资源，不作为真实 Skill 验收'
      );
      await mkdir(join(directory, 'skills', 'disabled'), { recursive: true });
      await writeFile(join(directory, 'skills', 'disabled', 'SKILL.md'), '未启用的临时资源');
      expect((await loadBotConfig(directory)).config.skills).toEqual(['erp']);
    });
  });

  it('错误配置先于数据库和端口初始化失败', async () => {
    await withConfig(async directory => {
      await writeFile(join(directory, 'bot.yaml'), 'employeeAllowlist: []\n');
      const driverFactory = vi.fn(() => new ApplicationTestDriver());
      await expect(
        startKairo({ configDirectory: directory, databaseUrl: '', port: 0, driverFactory })
      ).rejects.toMatchObject({
        type: 'configuration',
        cause: expect.objectContaining({ message: expect.stringContaining('Bot 配置校验失败') }),
      });
      expect(driverFactory).not.toHaveBeenCalled();
    });
  });

  it('缺失文件和无效 YAML 明确失败，错误不包含凭证或配置原文', async () => {
    await withConfig(async directory => {
      const secret = '不能进入错误输出的测试凭证';
      for (const source of [
        `model: [${secret}`,
        `${stringify(validConfig())}password: ${secret}\n`,
        `model: !unknown ${secret}\n`,
        `${stringify(validConfig())}datasetId: other\n`,
      ]) {
        await writeFile(join(directory, 'bot.yaml'), source);
        const error: unknown = await loadBotConfig(directory).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain(source);
      }
      await rm(join(directory, 'bot.yaml'));
      await expect(loadBotConfig(directory)).rejects.toThrow(/bot\.yaml/);
    });
  });

  it('摘要跨目录稳定，配置或 Skill 资源改变后变化，已加载结果不热更新', async () => {
    await withConfig(async directory => {
      const first = await loadBotConfig(directory);
      await withConfig(async other => {
        expect((await loadBotConfig(other)).configDigest).toBe(first.configDigest);
      });
      await writeFile(
        join(directory, 'bot.yaml'),
        stringify({ ...validConfig(), employeeAllowlist: ['other'] })
      );
      const second = await loadBotConfig(directory);
      expect(second.configDigest).not.toBe(first.configDigest);
      expect(first.config.employeeAllowlist).toEqual(['3585']);
      expect(second.config.employeeAllowlist).toEqual(['other']);
      await mkdir(join(directory, 'skills', 'erp', 'references'), { recursive: true });
      const resource = join(directory, 'skills', 'erp', 'references', 'guide.txt');
      await writeFile(resource, '内容甲');
      const third = await loadBotConfig(directory);
      await writeFile(resource, '内容乙');
      expect((await loadBotConfig(directory)).configDigest).not.toBe(third.configDigest);
    });
  });
});

describe('T15 启动失败的完整输出', () => {
  let directory: string;
  let applicationDirectory: string;
  let configFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kairo-startup-config-'));
    applicationDirectory = join(directory, 'apps', 'kairo');
    const configDirectory = join(directory, 'config', 'bots', 'default');
    configFile = join(configDirectory, 'bot.yaml');
    await mkdir(applicationDirectory, { recursive: true });
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(applicationDirectory, 'package.json'), '{"type":"module"}');
    const applicationSource = fileURLToPath(new URL('../../', import.meta.url));
    const repository = fileURLToPath(new URL('../../../../', import.meta.url));
    // 保留 pnpm 相对链接布局；只隔离配置与编译产物，不复制依赖或改写正式配置。
    await symlink(join(repository, 'node_modules'), join(directory, 'node_modules'), 'junction');
    await symlink(
      join(applicationSource, 'node_modules'),
      join(applicationDirectory, 'node_modules'),
      'junction'
    );
    await mkdir(join(directory, 'packages'));
    await symlink(
      join(repository, 'packages', 'driver'),
      join(directory, 'packages', 'driver'),
      'junction'
    );
    // 编译当前源码到临时目录，避免回归测试误用旧 dist。
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
      '非法模型 URL',
      (secret: string) => {
        const config = validConfig();
        config.model.url = `http://[${secret}`;
        return stringify(config);
      },
      'configuration',
    ],
    [
      'YAML 复杂键',
      (secret: string) => `${stringify(validConfig())}? [${secret}]\n: ignored\n`,
      'configuration',
    ],
  ] as const)(
    '%s 拒绝启动且完整输出不含测试凭证',
    async (_scenario, source, errorType) => {
      const secret = 'T15_STDERR_TEST_CREDENTIAL';
      await writeFile(configFile, source(secret));
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
      expect(result.stdout + result.stderr).not.toContain(secret);
      const records = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      expect(records, result.stderr).toContainEqual(
        expect.objectContaining({ event: '应用启动失败', errorType })
      );
      expect(result.stdout + result.stderr).not.toContain('stack');
    },
    15000
  );
});
