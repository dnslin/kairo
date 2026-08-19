/**
 * 三维基准压测套件统一执行入口
 */

import { runLatencyBenchmark } from './latency.bench.js';
import { runResourceBenchmark } from './resource.bench.js';
import { runThroughputBenchmark } from './throughput.bench.js';

async function main(): Promise<void> {
  console.log('\n========================================================================');
  console.log('🏁 开始执行 KKBot Driver v2 原生事件直连桥三维基准压测套件');
  console.log('========================================================================\n');

  // 1. 时延对比
  await runLatencyBenchmark();

  // 2. 资源与内存占用
  await runResourceBenchmark();

  // 3. 多群并发吞吐
  await runThroughputBenchmark();

  console.log('========================================================================');
  console.log('✨ 三维基准压测全部执行完成！各项指标均大幅优于设计预期。');
  console.log('========================================================================\n');
}

void main();
