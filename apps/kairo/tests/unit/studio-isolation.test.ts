import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { createStudioMastra, loadStudioConfig } from '../../src/mastra/dev-server.js';

const development = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://production:secret@localhost/company',
  KAIRO_PRODUCTION_DATASET_ID: 'company-documents',
  KAIRO_PRODUCTION_EMPLOYEE_IDS: 'employee-1,employee-2',
  KAIRO_STUDIO_DATABASE_URL: 'postgresql://developer:secret@127.0.0.1/kairo_studio',
  KAIRO_STUDIO_DATASET_ID: 'test-documents',
  KAIRO_STUDIO_EMPLOYEE_ID: 'test-employee',
};

describe('T13 Studio 启动门禁', () => {
  it('只接受显式开发模式，生产变量和 Studio 开关不能绕过', () => {
    expect(() =>
      loadStudioConfig({ ...development, NODE_ENV: 'production', MASTRA_STUDIO: 'true' })
    ).toThrow();
    expect(() => loadStudioConfig({ ...development, NODE_ENV: undefined })).toThrow();
  });

  it('更换账号、主机别名或连接参数仍不能使用正式数据库', () => {
    expect(() =>
      loadStudioConfig({
        ...development,
        KAIRO_STUDIO_DATABASE_URL:
          'postgresql://developer:secret@127.0.0.1/company?sslmode=disable',
      })
    ).toThrow();
    expect(() =>
      loadStudioConfig({
        ...development,
        KAIRO_STUDIO_DATABASE_URL: 'postgresql://developer:secret@localhost/%63ompany',
      })
    ).toThrow();
  });

  it('正式 Dataset 或正式员工不能作为开发范围', () => {
    expect(() =>
      loadStudioConfig({
        ...development,
        KAIRO_STUDIO_DATASET_ID: development.KAIRO_PRODUCTION_DATASET_ID,
      })
    ).toThrow();
    expect(() =>
      loadStudioConfig({ ...development, KAIRO_STUDIO_EMPLOYEE_ID: 'employee-2' })
    ).toThrow();
  });

  it('缺少开发配置或正式比对值时拒绝启动，不回退正式配置', () => {
    for (const key of [
      'DATABASE_URL',
      'KAIRO_PRODUCTION_DATASET_ID',
      'KAIRO_PRODUCTION_EMPLOYEE_IDS',
      'KAIRO_STUDIO_DATABASE_URL',
      'KAIRO_STUDIO_DATASET_ID',
      'KAIRO_STUDIO_EMPLOYEE_ID',
    ]) {
      expect(() => loadStudioConfig({ ...development, [key]: undefined }), key).toThrow();
    }
  });

  it('客户端伪造员工和 Dataset 时，下游仍只收到固定测试范围', async () => {
    const studio = createStudioMastra(development);
    try {
      const app = new Hono<{ Variables: { requestContext: RequestContext } }>();
      app.use(async (context, next) => {
        const body = await context.req.json<{ requestContext: Record<string, string> }>();
        context.set('requestContext', new RequestContext(Object.entries(body.requestContext)));
        await next();
      });
      const middleware = studio.getServer()?.middleware;
      if (!Array.isArray(middleware)) throw new Error('Studio 请求中间件不可用');
      for (const handler of middleware) {
        if (typeof handler !== 'function') throw new Error('Studio 中间件不是可执行函数');
        app.use(handler);
      }
      app.post('/scope', context => {
        const scope = context.get('requestContext');
        return context.json({
          resourceId: scope.get(MASTRA_RESOURCE_ID_KEY),
          employeeId: scope.get('employeeId'),
          datasetId: scope.get('datasetId'),
        });
      });
      const response = await app.request('/scope', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestContext: {
            [MASTRA_RESOURCE_ID_KEY]: 'employee-1',
            employeeId: 'employee-1',
            datasetId: 'company-documents',
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resourceId: 'test-employee',
        employeeId: 'test-employee',
        datasetId: 'test-documents',
      });
    } finally {
      await studio.shutdown();
    }
  });
});
