import os from 'node:os';
import type { LogEnvironment } from '../log/types.js';

/** Build the runtime environment descriptor shared by perf + log records. */
export function detectEnvironment(appVersion: string): LogEnvironment {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim(),
    cpuCores: cpus.length,
    memoryTotal: os.totalmem(),
    runtimeVersion: process.version,
    appVersion,
  };
}
