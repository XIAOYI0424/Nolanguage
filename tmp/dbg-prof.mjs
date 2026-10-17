import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PYTHON_PROFILE_SRC } from '../src/profiler/pythonProfileSource.ts';

const dir = await mkdtemp(join(tmpdir(), 'dbgprof-'));
const wrapper = join(dir, 'profile.py');
const snippet = join(dir, 'snippet.py');
const out = join(dir, 'out.json');
await writeFile(wrapper, PYTHON_PROFILE_SRC, 'utf8');
await writeFile(snippet, 'def hot(n):\n    s=0\n    for i in range(n):\n        s += i*i\n    return s\nprint("result", hot(300000))\n', 'utf8');
const r = spawnSync('python', [wrapper, snippet, out], { encoding: 'utf8' });
console.log('exit=', r.status, 'signal=', r.signal);
console.log('stdout=', JSON.stringify(r.stdout));
console.log('stderr=', JSON.stringify(r.stderr));
try {
  const txt = await readFile(out, 'utf8');
  console.log('out.json=', txt.slice(0, 500));
} catch (e) {
  console.log('no out.json:', e.message);
}
console.log('dir=', dir);
