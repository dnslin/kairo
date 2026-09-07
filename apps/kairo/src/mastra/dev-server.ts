import { Mastra } from '@mastra/core/mastra';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { RequestContext } from '@mastra/core/request-context';
import type { Context, Next } from 'hono';
import { Client } from 'pg';
import { z } from 'zod';
import { createMastraStorage } from './storage.js';

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

export async function createStudioMastra(
  environment: NodeJS.ProcessEnv = process.env
): Promise<Mastra> {
  const parsed = studioEnvironment.safeParse(environment);
  if (!parsed.success) {
    throw new Error(
      `Studio 仅允许显式开发配置，请检查：${parsed.error.issues.map(issue => issue.path.join('.')).join('、')}`
    );
  }
  const config = parsed.data;
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

  // 按 PostgresStore 实际生成的 Pool 配置解析，不能用原始 URL 近似比较。
  // 构造 Client 只解析配置，不调用 connect；正式比对库不会建立连接。
  const referenceStorage = createMastraStorage(config.DATABASE_URL);
  let productionDatabase: string | undefined;
  try {
    productionDatabase = new Client(referenceStorage.pool.options).database;
  } finally {
    await referenceStorage.close();
  }

  const storage = createMastraStorage(config.KAIRO_STUDIO_DATABASE_URL);
  try {
    const developmentDatabase = new Client(storage.pool.options).database;
    if (!developmentDatabase || developmentDatabase === productionDatabase) {
      throw new Error('Studio 必须使用与正式环境不同库名的独立数据库');
    }
    // 校验和使用同一个自有连接池，避免检查后再次解析产生不同目标。
    return new Mastra({
      storage,
      server: {
        host: '127.0.0.1',
        port: 4111,
        // 依据：https://mastra.ai/docs/server/request-context#reserved-keys
        middleware: [
          async (context: StudioContext, next: Next): Promise<void> => {
            const requestContext = context.get('requestContext');
            requestContext.set(MASTRA_RESOURCE_ID_KEY, config.KAIRO_STUDIO_EMPLOYEE_ID);
            requestContext.set('employeeId', config.KAIRO_STUDIO_EMPLOYEE_ID);
            requestContext.set('datasetId', config.KAIRO_STUDIO_DATASET_ID);
            await next();
          },
        ],
      },
    });
  } catch (error) {
    await storage.close();
    throw error;
  }
}
