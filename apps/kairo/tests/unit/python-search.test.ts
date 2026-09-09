import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../../../../config/bots/default/skills/erp-search/scripts/search.py', import.meta.url)
);
const apiKey = 'local-python-boundary-key';
const datasetId = 'erp-fixed';
const servers: Server[] = [];

interface Result {
  kind: string;
  httpStatus: number | null;
  apiCode: number | null;
  raw: unknown;
  chunks?: unknown[];
  total?: number;
  error?: { reason: string; message: string };
  retryable?: boolean;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close(error => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function service(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function reply(payload: unknown, status = 200) {
  return service((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
}

function run(apiUrl: string, query = '采购订单如何审核？', args: string[] = []) {
  return new Promise<{ result: Result; stdout: string; stderr: string; exitCode: number | null }>(
    (resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        RAGFLOW_API_URL: apiUrl,
        RAGFLOW_API_KEY: apiKey,
        RAGFLOW_DATASET_ID: datasetId,
      };
      for (const name of [
        'PATH',
        'Path',
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'TEMP',
        'TMP',
        'HOME',
      ]) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      // 真实子进程可能卡在操作系统网络层，安全终止上限不是行为断言或固定等待。
      const child = spawn('python', ['-I', '-B', script, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        timeout: 10000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        stdout += text;
      });
      child.stderr.on('data', (text: string) => {
        stderr += text;
      });
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('close', exitCode => {
        try {
          resolve({ result: JSON.parse(stdout) as Result, stdout, stderr, exitCode });
        } catch {
          reject(new Error(`Python 未输出有效 JSON（退出码 ${exitCode}）：${stderr}`));
        }
      });
      child.stdin.end(query, 'utf8');
    }
  );
}

const chunk = {
  id: 'chunk-1',
  content: '在采购订单页面提交审核。',
  document_id: 'document-1',
  document_keyword: '采购操作手册',
  dataset_id: datasetId,
  positions: [[2, 10, 20, 30, 40]],
  similarity: 0.82,
  vector_similarity: 0.76,
  term_similarity: 0.91,
};

function success(chunks: unknown[] = [chunk], total: unknown = chunks.length) {
  return { code: 0, data: { chunks, total } };
}

describe('Python 检索真实 HTTP 边界', () => {
  it('固定 URL、凭证和 Dataset，stdin 中的选项与 shell 文本只作为问题', async () => {
    const requests: unknown[] = [];
    const apiUrl = await service((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (text: string) => {
        body += text;
      });
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(body),
        });
        response.end(JSON.stringify(success()));
      });
    });
    const query = '审核 --dataset-ids other; $(echo injected)\n保留原文';
    const output = await run(`${apiUrl}/`, query);
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/api/v1/retrieval',
        authorization: `Bearer ${apiKey}`,
        body: { question: query, dataset_ids: [datasetId] },
      },
    ]);
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe('');
    expect(output.result).toEqual({
      kind: 'found',
      httpStatus: 200,
      apiCode: 0,
      raw: success(),
      total: 1,
      chunks: [
        {
          chunkId: 'chunk-1',
          content: chunk.content,
          documentId: 'document-1',
          documentName: chunk.document_keyword,
          datasetId,
          positions: chunk.positions,
          similarity: 0.82,
          vectorSimilarity: 0.76,
          termSimilarity: 0.91,
        },
      ],
    });
  });

  it('只有合法空 chunks 返回 empty，CLI 参数不会触发请求', async () => {
    let requests = 0;
    const apiUrl = await service((_request, response) => {
      requests += 1;
      response.end(JSON.stringify(success([])));
    });
    const empty = await run(apiUrl);
    expect(empty.result).toEqual({
      kind: 'empty',
      httpStatus: 200,
      apiCode: 0,
      raw: success([]),
      chunks: [],
      total: 0,
    });
    const rejected = await run(apiUrl, '查询', ['--dataset-ids', 'other']);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.result).toMatchObject({
      kind: 'parameter_error',
      httpStatus: null,
      retryable: false,
    });
    expect(requests).toBe(1);
  });

  it.each([
    { code: 0 },
    { code: 0, data: [] },
    { code: 0, data: { chunks: [], total: '0' } },
    { code: 0, data: { chunks: [], total: -1 } },
    { code: 0, data: { chunks: [], total: true } },
    success([null]),
    ...[
      'id',
      'content',
      'document_id',
      'document_keyword',
      'dataset_id',
      'positions',
      'similarity',
    ].map(field => {
      const malformed: Record<string, unknown> = { ...chunk };
      delete malformed[field];
      return success([malformed]);
    }),
    success([{ ...chunk, content: '' }]),
    success([{ ...chunk, id: '' }]),
    success([{ ...chunk, content: ['不能拼接'] }]),
    success([{ ...chunk, document_keyword: 7 }]),
    success([{ ...chunk, positions: [[1, '2']] }]),
    success([{ ...chunk, positions: [1, 2] }]),
    success([{ ...chunk, similarity: true }]),
    success([{ ...chunk, vector_similarity: null }]),
    success([{ ...chunk, term_similarity: '0.8' }]),
  ])('畸形元数据保留 raw 并失败，不当作空结果：%j', async payload => {
    const output = await run(await reply(payload));
    expect(output.exitCode).toBe(1);
    expect(output.result).toMatchObject({
      kind: 'format_error',
      httpStatus: 200,
      apiCode: 0,
      raw: payload,
      retryable: false,
    });
  });

  it.each([
    { code: 102, message: `You don't own the dataset ${datasetId}.`, kind: 'auth_error' },
    { code: 102, message: '`question` is required.', kind: 'parameter_error' },
    { code: 102, message: '未知参数或服务错误', kind: 'service_error' },
    { code: 999, message: '内部处理失败', kind: 'service_error' },
  ])('HTTP 200 业务错误按可靠诊断分类而非仅 code：%j', async ({ code, message, kind }) => {
    const payload = { code, message };
    const output = await run(await reply(payload));
    expect(output.exitCode).toBe(1);
    expect(output.result).toMatchObject({
      kind,
      httpStatus: 200,
      apiCode: code,
      raw: payload,
      retryable: false,
      error: { message },
    });
  });

  it.each([
    [401, 'auth_error', false],
    [403, 'auth_error', false],
    [400, 'parameter_error', false],
    [422, 'parameter_error', false],
    [429, 'service_error', true],
    [503, 'service_error', true],
  ] as const)('HTTP %i 保留状态与业务诊断', async (status, kind, retryable) => {
    const payload = { code: 102, message: '接口诊断', detail: { trace: 'trace-1' } };
    const output = await run(await reply(payload, status));
    expect(output.result).toMatchObject({
      kind,
      httpStatus: status,
      apiCode: 102,
      raw: payload,
      retryable,
    });
    expect(output.exitCode).toBe(1);
  });

  it('非 JSON 与非有限 JSON 数字保留原文而非输出非法 JSON', async () => {
    for (const body of ['<html>网关错误</html>', '{"code":0,"data":{"chunks":[],"total":NaN}}']) {
      const apiUrl = await service((_request, response) => {
        response.end(body);
      });
      const output = await run(apiUrl);
      expect(output.result).toMatchObject({ kind: 'format_error', raw: body, retryable: false });
    }
  });

  it('断线归网络故障，不在 Python 内重试，也不泄露异常', async () => {
    let requests = 0;
    const apiUrl = await service(request => {
      requests += 1;
      request.socket.destroy();
    });
    const output = await run(apiUrl);
    expect(output.result).toMatchObject({
      kind: 'service_error',
      httpStatus: null,
      apiCode: null,
      retryable: true,
      error: { reason: 'network' },
    });
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toBe('');
    expect(requests).toBe(1);
  });

  it('截断认证响应保留 HTTP 状态，不变成可重试网络错误', async () => {
    const apiUrl = await service((_request, response) => {
      response.writeHead(401, { 'content-length': '100', connection: 'close' });
      response.end('short');
    });
    const output = await run(apiUrl);
    expect(output.result).toMatchObject({ kind: 'auth_error', httpStatus: 401, retryable: false });
  });

  it('非法业务码不覆盖已经收到的临时 HTTP 状态', async () => {
    const output = await run(await reply({ code: 1.5, message: '临时故障' }, 503));
    expect(output.result).toMatchObject({
      kind: 'service_error',
      httpStatus: 503,
      apiCode: null,
      retryable: true,
      raw: { code: 1.5 },
    });
  });

  it('网络故障保留安全异常类型而不是丢掉所有内部诊断', async () => {
    const output = await run(
      await service(request => {
        request.socket.destroy();
      })
    );
    expect(output.result.raw).toMatchObject({ exceptionType: 'RemoteDisconnected' });
  });

  it('拒绝带凭证重定向至另一个目标', async () => {
    let leakedRequests = 0;
    const target = await service((_request, response) => {
      leakedRequests += 1;
      response.end(JSON.stringify(success()));
    });
    const apiUrl = await service((_request, response) => {
      response.writeHead(302, { location: `${target}/stolen` });
      response.end(JSON.stringify({ code: 302, message: '跳转诊断' }));
    });
    const output = await run(apiUrl);
    expect(output.result).toMatchObject({
      kind: 'service_error',
      httpStatus: 302,
      retryable: false,
    });
    expect(leakedRequests).toBe(0);
  });

  it('精确移除上游回显凭证，同时保留其他诊断和结构', async () => {
    const payload = {
      code: 999,
      message: `错误 ${apiKey}，保留诊断`,
      detail: { [apiKey]: `Bearer ${apiKey}`, trace: 'trace-2' },
    };
    const output = await run(await reply(payload));
    expect(output.stdout).not.toContain(apiKey);
    expect(output.stderr).toBe('');
    expect(output.result).toMatchObject({
      kind: 'service_error',
      error: { message: '错误 [REDACTED]，保留诊断' },
      raw: { detail: { trace: 'trace-2' } },
    });
  });
});
