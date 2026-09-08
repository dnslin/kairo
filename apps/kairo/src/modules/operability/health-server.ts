import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getHealthSnapshot } from './health.js';
import type { HealthDependencies } from './health.js';
import { AppError, getErrorType } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger();

export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

export async function startHealthServer({
  port = 4110,
  host = '127.0.0.1',
  readDependencies,
}: {
  port?: number;
  host?: string;
  readDependencies: () => Promise<HealthDependencies> | HealthDependencies;
}): Promise<HealthServer> {
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new AppError('configuration');
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'alive' }));
      return;
    }
    if (request.url !== '/health/ready' && request.url !== '/health/dependencies') {
      response.writeHead(404);
      response.end();
      return;
    }
    void Promise.resolve()
      .then(readDependencies)
      .then(dependencies => {
        const snapshot = getHealthSnapshot(dependencies);
        const statusCode =
          request.url === '/health/ready' && snapshot.status === 'not_ready' ? 503 : 200;
        response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(snapshot));
      })
      .catch(error => {
        logger.error({
          event: '依赖检查失败',
          errorType: getErrorType(error),
          status: 'not_ready',
        });
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ status: 'not_ready', error: '依赖状态读取失败' }));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: (): Promise<void> => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}
