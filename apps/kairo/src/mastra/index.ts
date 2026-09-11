import type { BotConfig } from '../config/schema.js';
import type { BotCustomization } from '../modules/bot-customization/instructions.js';
import { MastraOperabilityLogger } from '../modules/operability/logger.js';
import type { AppLogger } from '../modules/operability/logger.js';
import { createKairoAgent } from './agent.js';
import type { KairoAgent } from './agent.js';
import { createMastraRuntime } from './runtime.js';
import type { MastraRuntime } from './runtime.js';

export interface KairoMastra extends MastraRuntime {
  agent: KairoAgent;
}

/** 只装配可调用 Agent；不开放执行路由，不连接 IM 或启动业务调度。 */
export function createKairoMastra(options: {
  config: BotConfig;
  customization: BotCustomization;
  databaseUrl: string;
  logger: AppLogger;
}): KairoMastra {
  const runtime = createMastraRuntime(options.databaseUrl);
  const { agent, memory } = createKairoAgent(
    options.config,
    options.customization,
    runtime.storage
  );
  runtime.mastra.setLogger({ logger: new MastraOperabilityLogger(options.logger) });
  // 官方注册接口：https://mastra.ai/reference/core/mastra-class
  runtime.mastra.addAgent(agent);
  let closing: Promise<void> | undefined;
  return {
    ...runtime,
    agent,
    close(): Promise<void> {
      closing ??= (async (): Promise<void> => {
        const errors: unknown[] = [];
        try {
          await memory.settled();
        } catch (error) {
          errors.push(error);
        }
        try {
          await runtime.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Agent 记忆与运行时关闭失败');
      })();
      return closing;
    },
  };
}
