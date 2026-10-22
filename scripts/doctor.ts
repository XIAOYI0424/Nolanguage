/**
 * `nlg doctor [--json]` — read-only diagnostics for "process running, no UI".
 *
 * Exit code is 0 for `ok` / `not-running` (nothing is broken, it just is not
 * running) and 1 for the three states that need action: orphan server, port
 * conflict, server-without-window.
 */
import { collectDoctorReport, formatDoctor } from '../src/cli/doctor.js';

const json = process.argv.includes('--json');
const report = await collectDoctorReport();
console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
process.exitCode = report.diagnosis === 'ok' || report.diagnosis === 'not-running' ? 0 : 1;
