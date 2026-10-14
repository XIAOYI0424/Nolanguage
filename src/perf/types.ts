export type PerfResourceScope =
  | 'kernel' | 'extension' | 'language-server'
  | 'execution' | 'user-code' | 'ai';

export interface PerfResource {
  scope: PerfResourceScope;
  languageId?: string;
  extensionId?: string;
  processId?: number;
}

export interface PerfScope {
  workspaceId?: string;
  fileUri?: string;
  line?: number;
  symbol?: string;
  stack?: string;
}

export interface PerfCorrelation {
  gitCommit?: string;
  configHash?: string;
  sessionId?: string;
  benchmarkId?: string;
  traceId?: string;
}

export interface PerfEnvironment {
  os: string;
  arch: string;
  cpuModel?: string;
  cpuCores?: number;
  memoryTotal?: number;
  runtimeVersion?: string;
}

export interface PerfEnvelope {
  id: string;
  traceId?: string;
  parentId?: string;
  timestamp: number;
  duration?: number;
  resource: PerfResource;
  scope: PerfScope;
  correlation: PerfCorrelation;
  environment: PerfEnvironment;
}

export type PerfEvent = PerfEnvelope & {
  type: 'event';
  category: string;
  name: string;
  status: 'ok' | 'error' | 'running';
};
export type PerfSample = PerfEnvelope & {
  type: 'sample';
  profileType: string;
  value: number;
  stack: string;
};
export type PerfMetric = PerfEnvelope & {
  type: 'metric';
  name: string;
  value: number;
  unit: string;
};

export type PerfRecord = PerfEvent | PerfSample | PerfMetric;
