import { EventEmitter, once } from 'node:events';
import fs, { type WriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls, { type ConnectionOptions } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EdgeTTS } from 'node-edge-tts';
import type { WebSocket } from 'ws';

class FakeWebSocket extends EventEmitter {
  public readyState = 1;
  public readonly sent: string[] = [];
  public terminateCalls = 0;

  public send(data: string, optionsOrCallback?: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    (done as ((error?: Error) => void) | undefined)?.();
  }

  public terminate(): void {
    this.terminateCalls += 1;
    if (this.readyState === 3) return;
    this.readyState = 2;
    globalThis.queueMicrotask(() => this.closeFromPeer(1006));
  }

  public emitAudio(data: Uint8Array): void {
    this.emit('message', Buffer.concat([Buffer.from('Path:audio\r\n'), data]), true);
  }

  public emitText(message: string): void {
    this.emit('message', Buffer.from(message), false);
  }

  public closeFromPeer(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-edge-tts-test-'));
  tempDirectories.push(directory);
  return directory;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未获得 TCP 端口');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function useFakeConnection(tts: EdgeTTS, socket: FakeWebSocket): WriteStream[] {
  vi.spyOn(tts, '_connectWebSocket').mockResolvedValue(socket as unknown as WebSocket);
  const streams: WriteStream[] = [];
  const createWriteStream = fs.createWriteStream;
  vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
    const stream = createWriteStream(...args);
    streams.push(stream);
    return stream;
  });
  return streams;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('node-edge-tts 依赖边界', () => {
  it('连接握手挂起时按 deadline 终止真实 WebSocket 底层连接', async () => {
    let markAccepted = (_socket: Socket): void => {};
    const accepted = new Promise<Socket>(resolve => {
      markAccepted = resolve;
    });
    let serverSocket: Socket | undefined;
    const server = createServer(socket => {
      serverSocket = socket;
      socket.resume();
      markAccepted(socket);
    });
    const port = await listen(server);
    const connect = tls.connect;
    vi.spyOn(tls, 'connect').mockImplementation((...args) =>
      connect({ ...(args[0] as ConnectionOptions), host: '127.0.0.1', port })
    );
    const outputPath = path.join(await createTempDirectory(), 'handshake-timeout.mp3');

    try {
      // 这里必须使用真实时钟，才能覆盖 ws 与 TCP 握手资源的真实 deadline。
      const tts = new EdgeTTS({ timeout: 100 });
      const connection = tts.ttsPromise('握手超时', outputPath).then(
        () => ({ error: undefined }),
        error => ({ error })
      );
      const socket = await accepted;
      const result = await connection;

      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('Timed out');
      if (!socket.destroyed) await once(socket, 'close');
      expect(socket.destroyed).toBe(true);
    } finally {
      serverSocket?.destroy();
      await closeServer(server);
    }
  });

  it('合成阶段挂起时关闭文件流和 WebSocket 后返回超时错误', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'timeout.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 50 });
    const streams = useFakeConnection(tts, socket);

    await expect(tts.ttsPromise('超时测试', outputPath)).rejects.toThrow('Timed out');

    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
  });

  it('文件流写入错误进入 Promise 拒绝并关闭 WebSocket', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'missing', 'stream-error.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 1000 });
    const streams = useFakeConnection(tts, socket);

    await expect(tts.ttsPromise('文件错误', outputPath)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
  });

  it('异常 close 会结束合成并关闭仍打开的文件流', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'closed.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 1000 });
    const streams = useFakeConnection(tts, socket);

    const pending = tts.ttsPromise('连接断开', outputPath);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.closeFromPeer(1006, 'abnormal');

    await expect(pending).rejects.toThrow(/1006.*abnormal/);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
  });

  it('正常 turn.end 会刷盘并关闭资源，晚到音频不会继续写入', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'complete.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 1000 });
    const streams = useFakeConnection(tts, socket);
    const audio = Buffer.from('complete audio');

    const pending = tts.ttsPromise('正常完成', outputPath);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emitAudio(audio);
    socket.emitText('Path:turn.end');
    await pending;

    expect(await readFile(outputPath)).toEqual(audio);
    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
    socket.emitAudio(Buffer.from('late audio'));

    expect(await readFile(outputPath)).toEqual(audio);
  });
});
