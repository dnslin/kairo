import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import decodeMp3, { type AudioData as DecodedAudio } from '@audio/decode-mp3';
import decodeWav from '@audio/decode-wav';
import { EdgeTTS } from 'node-edge-tts';
import waveResampler from 'wave-resampler';
import type { CdpClient } from '../cdp/client.js';
import type { KK9VoiceOptions } from '../types/index.js';
import { DriverError } from '../utils/errors.js';

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const KK9_SAMPLE_RATE = 8000;
const AMR_FRAME_SAMPLES = 160;
const AMR_HEADER = Buffer.from('#!AMR\n', 'ascii');

interface Kk9EncodeResult {
  ok: boolean;
  data?: string;
  decodedSamples?: number;
  error?: string;
}

function isWave(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.buffer, bytes.byteOffset + 8, 4).toString('ascii') === 'WAVE'
  );
}

async function synthesizeText(text: string, voice: string, lang: string): Promise<Buffer> {
  let tempDirectory: string | undefined;
  let audio: Buffer | undefined;
  let synthesisError: Error | undefined;

  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kairo-edge-tts-'));
    const audioPath = path.join(tempDirectory, 'speech.mp3');
    const tts = new EdgeTTS({
      voice,
      lang,
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      timeout: 30000,
    });
    await tts.ttsPromise(text, audioPath);
    audio = await readFile(audioPath);
    if (audio.length === 0) {
      throw new Error('Edge TTS 未返回音频数据');
    }
  } catch (error) {
    synthesisError = error instanceof Error ? error : new Error(String(error));
  }

  if (tempDirectory) {
    try {
      await rm(tempDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const synthesisMessage = synthesisError ? `；原始合成错误: ${synthesisError.message}` : '';
      throw new DriverError(
        `清理 Edge TTS 临时文件失败: ${cleanupMessage}${synthesisMessage}`,
        'VOICE_TEMP_CLEANUP_FAILED',
        cleanupError instanceof Error ? cleanupError : undefined
      );
    }
  }

  if (synthesisError) {
    throw new DriverError(
      `Edge TTS 合成失败: ${synthesisError.message}`,
      'VOICE_TTS_FAILED',
      synthesisError
    );
  }
  if (!audio) {
    throw new DriverError('Edge TTS 未产出可读取音频', 'VOICE_TTS_FAILED');
  }
  return audio;
}

async function decodeAudio(bytes: Uint8Array): Promise<DecodedAudio> {
  try {
    return isWave(bytes) ? decodeWav(bytes) : await decodeMp3(bytes);
  } catch (error) {
    throw new DriverError(
      `音频解码失败，仅支持 WAV 或 MP3: ${error instanceof Error ? error.message : String(error)}`,
      'VOICE_DECODE_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}

function downmixToMono(audio: DecodedAudio): Float32Array {
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new DriverError('音频采样率无效', 'VOICE_DECODE_FAILED');
  }
  if (!Array.isArray(audio.channelData) || audio.channelData.length === 0) {
    throw new DriverError('音频不包含可用声道', 'VOICE_DECODE_FAILED');
  }

  const frameCount = Math.min(...audio.channelData.map(channel => channel.length));
  if (!Number.isFinite(frameCount) || frameCount <= 0) {
    throw new DriverError('音频不包含可用采样', 'VOICE_DECODE_FAILED');
  }
  if (audio.channelData.length === 1) {
    return audio.channelData[0]!.subarray(0, frameCount);
  }

  const mono = new Float32Array(frameCount);
  for (const channel of audio.channelData) {
    for (let index = 0; index < frameCount; index += 1) {
      mono[index] = mono[index]! + channel[index]! / audio.channelData.length;
    }
  }
  return mono;
}

function toKk9Pcm(audio: DecodedAudio): {
  pcmBase64: string;
  sourceSampleCount: number;
} {
  const mono = downmixToMono(audio);
  const samples =
    audio.sampleRate === KK9_SAMPLE_RATE
      ? mono
      : waveResampler.resample(mono, audio.sampleRate, KK9_SAMPLE_RATE, {
          method: 'sinc',
          LPF: true,
          LPFType: 'FIR',
        });
  const sourceSampleCount = samples.length;
  if (sourceSampleCount === 0) {
    throw new DriverError('重采样后没有可编码的音频采样', 'VOICE_DECODE_FAILED');
  }

  const frameCount = Math.ceil(sourceSampleCount / AMR_FRAME_SAMPLES);
  // KK9 内置编码器使用严格小于边界，额外补一帧才能编码最后一帧有效采样。
  const pcm = new Int16Array((frameCount + 1) * AMR_FRAME_SAMPLES);
  for (let index = 0; index < sourceSampleCount; index += 1) {
    const sample = Number(samples[index]);
    if (!Number.isFinite(sample)) {
      throw new DriverError('音频包含非有限采样值', 'VOICE_DECODE_FAILED');
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm[index] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }

  return {
    pcmBase64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
    sourceSampleCount,
  };
}

async function encodeWithKk9(
  cdp: CdpClient,
  pcmBase64: string,
  sourceSampleCount: number
): Promise<{ data: string; decodedSamples: number }> {
  const resultScript = `
    (() => {
      try {
        const pcmBase64 = ${JSON.stringify(pcmBase64)};
        const sourceSampleCount = ${sourceSampleCount};
        const requireFn = typeof window.require === 'function' ? window.require : null;
        if (!requireFn) {
          return { ok: false, error: 'KK9 渲染进程未开放 Node require' };
        }
        const pathModule = requireFn('path');
        const BufferClass = requireFn('buffer').Buffer;
        const processObject = window.process || (typeof process !== 'undefined' ? process : null);
        if (!processObject?.resourcesPath) {
          return { ok: false, error: '无法定位 KK9 resourcesPath' };
        }
        const encoderPath = pathModule.join(
          processObject.resourcesPath,
          'app.asar',
          'dist',
          'electron',
          'lib',
          'amrnb'
        );
        const amr = requireFn(encoderPath);
        if (!amr || typeof amr.encode !== 'function' || typeof amr.decode !== 'function') {
          return { ok: false, error: 'KK9 内置 amrnb 编解码器不可用' };
        }

        const pcmBytes = BufferClass.from(pcmBase64, 'base64');
        if (pcmBytes.length === 0 || pcmBytes.length % 2 !== 0) {
          return { ok: false, error: '待编码 PCM 数据无效' };
        }
        const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
        const pcm = new Float32Array(pcmBytes.length / 2);
        for (let index = 0; index < pcm.length; index += 1) {
          pcm[index] = view.getInt16(index * 2, true) / 32768;
        }

        const encoded = amr.encode(pcm, ${KK9_SAMPLE_RATE}, amr.Mode.MR795);
        if (!encoded || encoded.length <= 6) {
          return { ok: false, error: 'KK9 内置 amrnb 编码器未产出数据' };
        }
        const encodedBuffer = BufferClass.from(
          encoded.buffer,
          encoded.byteOffset,
          encoded.byteLength
        );
        if (encodedBuffer.subarray(0, 6).toString('ascii') !== '#!AMR\\n') {
          return { ok: false, error: 'KK9 内置编码器产物不是 AMR-NB' };
        }
        const decoded = amr.decode(encoded);
        if (!decoded || decoded.length < sourceSampleCount || decoded.length >= sourceSampleCount + 160) {
          return { ok: false, error: 'AMR-NB 回解采样数与输入不一致' };
        }
        return {
          ok: true,
          data: encodedBuffer.toString('base64'),
          decodedSamples: decoded.length
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  `;

  let result: Kk9EncodeResult;
  try {
    result = await cdp.evaluate<Kk9EncodeResult>(resultScript, 30000);
  } catch (error) {
    throw new DriverError(
      `调用 KK9 内置 AMR-NB 编码器失败: ${error instanceof Error ? error.message : String(error)}`,
      'VOICE_ENCODE_FAILED',
      error instanceof Error ? error : undefined
    );
  }
  if (!result?.ok || !result.data || !Number.isInteger(result.decodedSamples)) {
    throw new DriverError(
      `KK9 AMR-NB 编码失败: ${result?.error || '未获得有效编码结果'}`,
      'VOICE_ENCODE_FAILED'
    );
  }

  const encoded = Buffer.from(result.data, 'base64');
  if (
    encoded.length <= AMR_HEADER.length ||
    !encoded.subarray(0, AMR_HEADER.length).equals(AMR_HEADER)
  ) {
    throw new DriverError('KK9 AMR-NB 编码结果缺少合法文件头', 'VOICE_ENCODE_FAILED');
  }
  return { data: result.data, decodedSamples: result.decodedSamples! };
}

/**
 * 将文本或本地音频准备为 KK9 contentType 2 所需的 AMR-NB/Base64 内容。
 * Edge TTS 临时文件会在读取后立即清理，返回结果只保留可发送内容。
 */
export async function prepareVoice(
  cdp: CdpClient,
  options: KK9VoiceOptions
): Promise<{ duration: number; data: string; filepath?: string }> {
  let source: Buffer;
  let filepath: string | undefined;
  if ((typeof options.text === 'string') === (typeof options.filePath === 'string')) {
    throw new DriverError('语音输入必须且只能提供 text 或 filePath', 'VOICE_INPUT_INVALID');
  }

  if (typeof options.text === 'string') {
    const text = options.text.trim();
    const voice = options.voice?.trim() || DEFAULT_VOICE;
    if (!text) {
      throw new DriverError('语音文本不能为空', 'VOICE_INPUT_INVALID');
    }
    const lang = /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0];
    if (!lang) {
      throw new DriverError(`Edge TTS 音色名称无法推导语言 [${voice}]`, 'VOICE_INPUT_INVALID');
    }
    source = await synthesizeText(text, voice, lang);
  } else {
    const requestedPath = options.filePath?.trim();
    if (!requestedPath) {
      throw new DriverError('语音文件路径不能为空', 'VOICE_INPUT_INVALID');
    }
    filepath = path.resolve(requestedPath);
    try {
      source = await readFile(filepath);
    } catch (error) {
      throw new DriverError(
        `读取语音文件失败 [${filepath}]: ${error instanceof Error ? error.message : String(error)}`,
        'VOICE_FILE_READ_FAILED',
        error instanceof Error ? error : undefined
      );
    }
  }

  const decoded = await decodeAudio(source);
  const { pcmBase64, sourceSampleCount } = toKk9Pcm(decoded);
  const encoded = await encodeWithKk9(cdp, pcmBase64, sourceSampleCount);
  const duration = Math.max(1, Math.ceil(encoded.decodedSamples / KK9_SAMPLE_RATE));
  return filepath ? { duration, data: encoded.data, filepath } : { duration, data: encoded.data };
}
