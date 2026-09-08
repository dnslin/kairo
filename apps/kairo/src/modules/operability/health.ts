export type DependencyName =
  | 'configuration'
  | 'postgres'
  | 'mastra'
  | 'driver'
  | 'ragflow'
  | 'model';
export type DependencyStatus = 'unknown' | 'up' | 'down';
export type HealthDependencies = Record<DependencyName, DependencyStatus>;

export interface HealthSnapshot {
  status: 'not_ready' | 'degraded' | 'ready';
  dependencies: HealthDependencies;
}

export function getHealthSnapshot(dependencies: HealthDependencies): HealthSnapshot {
  const { configuration, postgres, mastra, driver, ragflow, model } = dependencies;
  const coreReady =
    configuration === 'up' && postgres === 'up' && mastra === 'up' && driver === 'up';
  return {
    status: !coreReady ? 'not_ready' : ragflow === 'up' && model === 'up' ? 'ready' : 'degraded',
    dependencies: { configuration, postgres, mastra, driver, ragflow, model },
  };
}
