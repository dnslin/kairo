import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadBotConfig } from '../../src/config/load.js';
import { describe, expect, it } from 'vitest';
import { botConfigSchema } from '../../src/config/schema.js';
import { startKairo } from '../../src/index.js';

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
      await expect(loadBotConfig(directory)).rejects.toThrow(/tools/);
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
      await expect(
        startKairo({ configDirectory: directory, databaseUrl: '', port: 0 })
      ).rejects.toThrow(/Bot 配置校验失败/);
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
