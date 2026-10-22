/**
 * Pure checks for `nlg doctor`'s classification and formatting.
 *
 * The collector itself touches processes and the network; the part that can
 * silently lie — "which of the five states is this?" — is pure and is what
 * this suite pins down.
 */
import { diagnose, formatDoctor, type DoctorReport } from '../src/cli/doctor.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function report(over: Partial<DoctorReport> = {}): DoctorReport {
  return {
    diagnosis: 'ok',
    app: { version: '0.7.0', exePath: 'D:/Nolanguage/Nolanguage.exe', exeSize: 96 * 1024 * 1024, sha256: 'abc' },
    session: {
      serverPid: 1,
      serverAlive: true,
      browserPid: 2,
      browserAlive: true,
      profile: 'C:/Users/x/AppData/Local/Nolanguage/webview',
      windowPids: [2],
      visible: [2],
    },
    health: { status: 'ok', appVersion: '0.7.0', clients: 1 },
    port: { port: 7310, open: true, healthy: true },
    edge: { path: 'C:/Edge/msedge.exe', webview2: '143' },
    git: { available: true, version: '2.55', branch: 'master', commit: 'abc', dirty: false },
    python: '3.13',
    go: 'go1.27',
    hints: [],
    ...over,
  };
}

const health = { status: 'ok' };
check(
  'diagnose: health + visible window = ok',
  diagnose({ health, serverAlive: true, visible: [2], portOpen: true }) === 'ok',
);
check(
  'diagnose: health + no visible window = orphan-server',
  diagnose({ health, serverAlive: true, visible: [], portOpen: true }) === 'orphan-server',
);
check(
  'diagnose: port open without health = port-conflict',
  diagnose({ health: undefined, serverAlive: false, visible: [], portOpen: true }) === 'port-conflict',
);
check(
  'diagnose: nothing listening = not-running',
  diagnose({ health: undefined, serverAlive: false, visible: [], portOpen: false }) === 'not-running',
);
check(
  'diagnose: server alive but no port/health = window-missing',
  diagnose({ health: undefined, serverAlive: true, visible: [], portOpen: false }) === 'window-missing',
);

const okText = formatDoctor(report());
check('format: ok report names the diagnosis', /diagnosis\s+ok/.test(okText), okText.split('\n')[1]);
check('format: ok report includes version and exe path', /0\.7\.0/.test(okText) && /Nolanguage\.exe/.test(okText));
check('format: ok report includes the session pids', /server 1 \(alive\)/.test(okText) && /browser 2 \(alive\)/.test(okText));

const orphanText = formatDoctor(
  report({
    diagnosis: 'orphan-server',
    session: { ...report().session, visible: [], windowPids: [2] },
    hints: ['end it from Task Manager'],
  }),
);
check('format: orphan report says orphan', /orphan/.test(orphanText), orphanText.split('\n')[1]);
check('format: hints are printed', /end it from Task Manager/.test(orphanText));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
