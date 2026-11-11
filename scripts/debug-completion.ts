import { Kernel } from '../src/kernel/Kernel.js';
import { LogLevel } from '../src/log/LogLevel.js';
import { WorkspaceService } from '../src/panel/WorkspaceService.js';

const kernel = new Kernel({ appVersion: 'debug', logSilent: true, logLevel: LogLevel.TRACE });
await kernel.start();
const ws = new WorkspaceService(kernel, {});
await ws.init({ python: 'print("init")\n' });

// Replicate the verify-ide sequence exactly.
const t = (label: string): void => console.log(`[${new Date().toISOString().slice(11, 23)}] ${label}`);

t('diagnose #1 (undefined name)');
const d1 = await ws.diagnose('python', ['import os', '', 'def f():', '    return undefined_name'].join('\n'));
console.log('  →', d1.items.length, 'items');

t('diagnose #2 (syntax error)');
const d2 = await ws.diagnose('python', 'def broken(:\n    pass');
console.log('  →', d2.items.length, 'items', d2.items.map((i) => i.severity).join(','));

t('complete');
const items = await ws.complete('python', 'def greet():\n    pass\n\ngr', 3, 2);
console.log('  →', items.length, 'items', items.slice(0, 5).map((i) => i.label).join(','));

t('hover');
const h = await ws.hover('python', 'print("hi")', 0, 2);
console.log('  →', h ? 'ok' : 'null');

await ws.close();
await kernel.stop();
