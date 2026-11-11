import os from 'node:os';
import type { PerfEnvironment } from '../perf/types.js';

/**
 * The runtime environment descriptor: os, arch, cpu, memory, app version.
 *
 * Owned here because this module *builds* it; log and perf both consume it. It
 * used to live in `log/types.ts`, which made `util` depend on `log` — the wrong
 * way round for the slice that everything else depends on.
 */
export interface LogEnvironment extends PerfEnvironment {
  appVersion: string;
}

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
