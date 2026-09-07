import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

export async function startHealthServer(port = 4110): Promise<HealthServer> {
  const server = createServer((request, response) => {
    // 存活不代表业务就绪；依赖状态和 ready 由 T17 接入。
    if (request.method === 'GET' && request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'alive' }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
