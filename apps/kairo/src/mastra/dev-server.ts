import { Mastra } from '@mastra/core/mastra';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { RequestContext } from '@mastra/core/request-context';
import type { Context, Next } from 'hono';
import { Client } from 'pg';
import { z } from 'zod';
import { createMastraStorage } from './storage.js';

export interface StudioConfig {
  databaseUrl: string;
  datasetId: string;
  employeeId: string;
}

type StudioContext = Context<{ Variables: { requestContext: RequestContext } }>;

const requiredText = z.string().trim().min(1);
const studioEnvironment = z.object({
  NODE_ENV: z.literal('development'),
  DATABASE_URL: requiredText,
  KAIRO_PRODUCTION_DATASET_ID: requiredText,
  KAIRO_PRODUCTION_EMPLOYEE_IDS: requiredText,
  KAIRO_STUDIO_DATABASE_URL: requiredText,
  KAIRO_STUDIO_DATASET_ID: requiredText,
  KAIRO_STUDIO_EMPLOYEE_ID: requiredText,
});

export function loadStudioConfig(environment: NodeJS.ProcessEnv = process.env): StudioConfig {
  const parsed = studioEnvironment.safeParse(environment);
  if (!parsed.success) {
    throw new Error(
      `Studio 仅允许显式开发配置，请检查：${parsed.error.issues.map(issue => issue.path.join('.')).join('、')}`
    );
  }
  const config = parsed.data;
  // 使用 pg 自己的连接参数解析，覆盖 URL 编码、账号默认值和 query 参数。
  // 开发库必须使用不同库名，避免 localhost/DNS 别名和不同账号绕过比较。
  const productionDatabase = new Client({ connectionString: config.DATABASE_URL }).database;
  const developmentDatabase = new Client({ connectionString: config.KAIRO_STUDIO_DATABASE_URL })
    .database;
  if (!developmentDatabase || developmentDatabase === productionDatabase) {
    throw new Error('Studio 必须使用与正式环境不同库名的独立数据库');
  }
  if (config.KAIRO_STUDIO_DATASET_ID === config.KAIRO_PRODUCTION_DATASET_ID) {
    throw new Error('Studio 不能使用正式 Dataset');
  }
  const productionEmployees = config.KAIRO_PRODUCTION_EMPLOYEE_IDS.split(',')
    .map(id => id.trim())
    .filter(Boolean);
  if (
    productionEmployees.length === 0 ||
    productionEmployees.includes(config.KAIRO_STUDIO_EMPLOYEE_ID)
  ) {
    throw new Error('Studio 必须使用不在正式员工列表中的测试身份');
  }
  return {
    databaseUrl: config.KAIRO_STUDIO_DATABASE_URL,
    datasetId: config.KAIRO_STUDIO_DATASET_ID,
    employeeId: config.KAIRO_STUDIO_EMPLOYEE_ID,
  };
}

export function createStudioMastra(environment: NodeJS.ProcessEnv = process.env): Mastra {
  const config = loadStudioConfig(environment);
  return new Mastra({
    storage: createMastraStorage(config.databaseUrl),
    server: {
      host: '127.0.0.1',
      port: 4111,
      // 由 Mastra 默认服务处理 SIGINT/SIGTERM，并调用 shutdown 关闭存储。
      // 依据：https://mastra.ai/docs/server/request-context#reserved-keys
      middleware: [
        async (context: StudioContext, next: Next): Promise<void> => {
          const requestContext = context.get('requestContext');
          requestContext.set(MASTRA_RESOURCE_ID_KEY, config.employeeId);
          requestContext.set('employeeId', config.employeeId);
          requestContext.set('datasetId', config.datasetId);
          await next();
        },
      ],
    },
  });
}
