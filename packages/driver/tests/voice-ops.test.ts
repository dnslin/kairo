import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { prepareVoice } from '../src/bridge/voice-ops.js';

const ttsMock = vi.hoisted(() => ({
  audio: new Uint8Array(),
  constructorOptions: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ text: string; audioPath: string }>,
  error: undefined as Error | undefined,
}));

vi.mock('node-edge-tts', () => ({
  EdgeTTS: class {
    constructor(options: Record<string, unknown>) {
      ttsMock.constructorOptions.push(options);
    }

    async ttsPromise(text: string, audioPath: string): Promise<void> {
      ttsMock.calls.push({ text, audioPath });
      await writeFile(audioPath, ttsMock.audio);
      if (ttsMock.error) throw ttsMock.error;
    }
  },
}));

const AMR_HEADER = Buffer.from('#!AMR\n', 'ascii');
const AMR_FRAME = Buffer.from('IyFBTVIKLA4ajszcQMium6nIdhHVkehAIOju', 'base64').subarray(
  AMR_HEADER.length
);

interface CapturedEncodeRequest {
  pcm: Float32Array;
}

function createEncodingCdp(
  onEncode?: (request: CapturedEncodeRequest) => void,
  resultOverride?: { ok: false; error: string }
): CdpClient {
  const amr = {
    Mode: { MR795: 5 },
    encode(pcm: Float32Array): Buffer {
      if (resultOverride) throw new Error(resultOverride.error);
      onEncode?.({ pcm });
      const frameCount = pcm.length / 160 - 1;
      return Buffer.concat([AMR_HEADER, ...Array.from({ length: frameCount }, () => AMR_FRAME)]);
    },
    decode(encoded: Uint8Array): Float32Array {
      return new Float32Array(((encoded.length - AMR_HEADER.length) / AMR_FRAME.length) * 160);
    },
  };
  return {
    evaluate: vi.fn((script: string) =>
      Promise.resolve(
        runInNewContext(script, {
          window: {
            process: { resourcesPath: '/kk9/resources' },
            require(name: string) {
              if (name === 'path') return path;
              if (name === 'buffer') return { Buffer };
              if (name.endsWith('amrnb')) return amr;
              throw new Error(`测试不支持模块 ${name}`);
            },
          },
        }) as unknown
      )
    ),
  } as unknown as CdpClient;
}

function createPcm16Wav(options: {
  sampleRate: number;
  channels: number;
  frameCount: number;
  sampleAt: (frame: number, channel: number) => number;
}): Buffer {
  const dataSize = options.frameCount * options.channels * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(options.channels, 22);
  wav.writeUInt32LE(options.sampleRate, 24);
  wav.writeUInt32LE(options.sampleRate * options.channels * 2, 28);
  wav.writeUInt16LE(options.channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let frame = 0; frame < options.frameCount; frame += 1) {
    for (let channel = 0; channel < options.channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, options.sampleAt(frame, channel)));
      wav.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), offset);
      offset += 2;
    }
  }
  return wav;
}

const tempDirs: string[] = [];

async function createTempFile(name: string, data: Uint8Array): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-voice-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, name);
  await writeFile(filePath, data);
  return filePath;
}

afterEach(async () => {
  const ttsDirectories = ttsMock.calls.map(call => path.dirname(call.audioPath));
  ttsMock.audio = new Uint8Array();
  ttsMock.constructorOptions = [];
  ttsMock.calls = [];
  ttsMock.error = undefined;
  await Promise.all([
    ...tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
    ...ttsDirectories.map(directory => rm(directory, { recursive: true, force: true })),
  ]);
});

describe('prepareVoice 语音输入与 KK9 AMR-NB 转换', () => {
  it('将 16kHz 单声道 PCM WAV 重采样为 8kHz 并编码为原生 AMR payload', async () => {
    const wav = createPcm16Wav({
      sampleRate: 16000,
      channels: 1,
      frameCount: 16000,
      sampleAt: frame => Math.sin((2 * Math.PI * 440 * frame) / 16000) * 0.25,
    });
    const filePath = await createTempFile('one-second.wav', wav);
    let captured: CapturedEncodeRequest | undefined;
    const cdp = createEncodingCdp(request => {
      captured = request;
    });

    const payload = await prepareVoice(cdp, { filePath });

    expect(payload.duration).toBe(1);
    expect(Buffer.from(payload.data, 'base64').subarray(0, 6)).toEqual(AMR_HEADER);
    expect(payload.filepath).toBe(path.resolve(filePath));
    expect(captured?.pcm).toHaveLength(8160);
    expect(Array.from(captured?.pcm.subarray(8000) ?? [])).toEqual(new Array(160).fill(0));
    expect(Math.max(...Array.from(captured?.pcm.subarray(0, 8000) ?? []))).toBeGreaterThan(0.1);
  });

  it('在重采样前将多声道音频按声道平均为单声道', async () => {
    const wav = createPcm16Wav({
      sampleRate: 8000,
      channels: 2,
      frameCount: 1600,
      sampleAt: (_frame, channel) => (channel === 0 ? 0.25 : -0.25),
    });
    const filePath = await createTempFile('stereo.wav', wav);
    let captured: CapturedEncodeRequest | undefined;

    await prepareVoice(
      createEncodingCdp(request => {
        captured = request;
      }),
      { filePath }
    );

    expect(captured?.pcm).toHaveLength(1760);
    expect(Array.from(captured?.pcm.subarray(0, 1600) ?? []).every(sample => sample === 0)).toBe(
      true
    );
  });

  it('文本输入使用指定 Edge TTS 音色并在转换后清理临时文件', async () => {
    // 由 Edge TTS 实际生成“测试”二字，测试期间离线读取，不访问网络。
    ttsMock.audio = await readFile(new URL('./fixtures/voice.mp3', import.meta.url));
    let captured: CapturedEncodeRequest | undefined;

    const payload = await prepareVoice(
      createEncodingCdp(request => {
        captured = request;
      }),
      { text: '提醒 <研发&财务>', voice: 'zh-CN-YunxiNeural' }
    );

    expect(ttsMock.constructorOptions).toEqual([
      {
        voice: 'zh-CN-YunxiNeural',
        lang: 'zh-CN',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 30000,
      },
    ]);
    expect(ttsMock.calls).toHaveLength(1);
    expect(ttsMock.calls[0]?.text).toBe('提醒 <研发&财务>');
    await expect(access(ttsMock.calls[0]!.audioPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.dirname(ttsMock.calls[0]!.audioPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(Array.from(captured?.pcm ?? []).some(sample => Math.abs(sample) > 0.01)).toBe(true);
    expect(Buffer.from(payload.data, 'base64').subarray(0, 6)).toEqual(AMR_HEADER);
    expect(payload.filepath).toBeUndefined();
  });

  it('拒绝空文本、空音频和不存在的本地文件', async () => {
    const cdp = createEncodingCdp();
    // @ts-expect-error 验证 JavaScript 调用方同时提供两种输入时不会触发 TTS。
    await expect(prepareVoice(cdp, { text: '测试', filePath: 'voice.wav' })).rejects.toMatchObject({
      code: 'VOICE_INPUT_INVALID',
    });
    expect(ttsMock.calls).toHaveLength(0);
    await expect(prepareVoice(cdp, { text: '   ' })).rejects.toMatchObject({
      code: 'VOICE_INPUT_INVALID',
    });

    await expect(
      prepareVoice(cdp, { text: '测试', voice: 'invalid-voice-name' })
    ).rejects.toMatchObject({ code: 'VOICE_INPUT_INVALID' });

    const emptyFile = await createTempFile('empty.wav', Buffer.alloc(0));
    await expect(prepareVoice(cdp, { filePath: emptyFile })).rejects.toMatchObject({
      code: 'VOICE_DECODE_FAILED',
    });

    await expect(
      prepareVoice(cdp, { filePath: path.join(path.dirname(emptyFile), 'missing.wav') })
    ).rejects.toMatchObject({ code: 'VOICE_FILE_READ_FAILED' });
  });

  it('不把不支持的音频字节或编码器异常伪装为 AMR', async () => {
    const invalidFile = await createTempFile('not-audio.mp3', Buffer.from('这不是音频'));
    await expect(
      prepareVoice(createEncodingCdp(), { filePath: invalidFile })
    ).rejects.toMatchObject({ code: 'VOICE_DECODE_FAILED' });

    const wavFile = await createTempFile(
      'valid.wav',
      createPcm16Wav({
        sampleRate: 8000,
        channels: 1,
        frameCount: 800,
        sampleAt: () => 0.1,
      })
    );
    await expect(
      prepareVoice(
        createEncodingCdp(undefined, { ok: false, error: 'KK9 内置 amrnb 编码器不可用' }),
        { filePath: wavFile }
      )
    ).rejects.toMatchObject({ code: 'VOICE_ENCODE_FAILED' });
  });

  it('传播 Edge TTS 失败并清理已经写入的临时文件', async () => {
    ttsMock.audio = Buffer.from('partial audio');
    ttsMock.error = new Error('TTS 连接中断');
    await expect(prepareVoice(createEncodingCdp(), { text: '测试' })).rejects.toMatchObject({
      code: 'VOICE_TTS_FAILED',
    });
    expect(ttsMock.calls).toHaveLength(1);
    await expect(access(ttsMock.calls[0]!.audioPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.dirname(ttsMock.calls[0]!.audioPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    ttsMock.error = undefined;
    ttsMock.audio = new Uint8Array();
    await expect(prepareVoice(createEncodingCdp(), { text: '再次测试' })).rejects.toMatchObject({
      code: 'VOICE_TTS_FAILED',
    });
    expect(ttsMock.calls).toHaveLength(2);
    await expect(access(path.dirname(ttsMock.calls[1]!.audioPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
