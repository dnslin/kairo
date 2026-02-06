import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { AppConfig } from './schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('config');

function resolveEnvVariables(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
      const envValue = process.env[envVar];
      if (envValue === undefined) {
        log.warn({ envVar }, 'Environment variable not found, using empty string');
        return '';
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVariables);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveEnvVariables(val);
    }
    return result;
  }
  return value;
}

export function loadConfig(configPath?: string): AppConfig {
  const filePath = configPath ?? resolve(process.cwd(), 'config.yaml');

  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  log.info({ filePath }, 'Loading configuration');

  const content = readFileSync(filePath, 'utf-8');
  const rawConfig = yaml.load(content) as Record<string, unknown>;
  const config = resolveEnvVariables(rawConfig) as AppConfig;

  log.info({ mode: config.mode, cdpUrl: config.cdp.url }, 'Configuration loaded');

  return config;
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function reloadConfig(): AppConfig {
  cachedConfig = loadConfig();
  return cachedConfig;
}
