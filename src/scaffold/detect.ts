/**
 * Finding the projects inside a directory.
 *
 * "Import an existing project" is not a wizard: the files already exist, so the
 * only question is which directory is the root. This walks one level down, reads
 * the marker files, and says what it found — the UI then just calls `openFolder`.
 *
 * The marker table is data, not language knowledge: a marker names a language id
 * that a manifest may or may not be installed for, and the dialog shows the id
 * either way. A project whose language is not installed is still openable — it is
 * a directory of files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectCandidate {
  /** Absolute directory. */
  dir: string;
  /** Language id this marker implies (`python`, `rust`, …). */
  language: string;
  /** The file that made this directory a candidate. */
  marker: string;
  /** Display name: from the manifest file when it declares one, else the folder. */
  name: string;
  /** Extra evidence worth showing (`Cargo.lock`, `.git`, `go.sum`). */
  hints: string[];
}

interface Marker {
  file: string;
  language: string;
  /** Pull a display name out of the marker file, when it has one. */
  name?: (text: string) => string | undefined;
}

/** Order matters: the first marker that matches wins. */
const MARKERS: Marker[] = [
  { file: 'Cargo.toml', language: 'rust', name: (t) => /^name\s*=\s*"([^"]+)"/m.exec(t)?.[1] },
  { file: 'package.json', language: 'javascript', name: (t) => /"name"\s*:\s*"([^"]+)"/.exec(t)?.[1] },
  { file: 'pyproject.toml', language: 'python', name: (t) => /^name\s*=\s*"([^"]+)"/m.exec(t)?.[1] },
  { file: 'setup.py', language: 'python' },
  { file: 'go.mod', language: 'go', name: (t) => /^module\s+(\S+)/m.exec(t)?.[1] },
  { file: 'pom.xml', language: 'java', name: (t) => /<artifactId>([^<]+)<\/artifactId>/.exec(t)?.[1] },
  { file: 'CMakeLists.txt', language: 'cpp' },
  { file: 'main.py', language: 'python' },
  { file: 'main.rs', language: 'rust' },
  { file: 'main.go', language: 'go' },
];

/** Directories that are never a project root of their own. */
const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', 'out', 'bin', 'obj']);

const HINTS = ['Cargo.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'go.sum', 'pom.xml', '.git'];

function readCandidate(dir: string): ProjectCandidate | undefined {
  for (const marker of MARKERS) {
    const full = join(dir, marker.file);
    if (!existsSync(full)) continue;
    let text = '';
    try {
      // Markers are small; a 64 KB read is enough for a name and cheap for a scan.
      text = readFileSync(full, 'utf8').slice(0, 64 * 1024);
    } catch {
      /* unreadable marker still makes the directory a candidate */
    }
    const name = marker.name?.(text) ?? dir.split(/[\\/]/).pop() ?? dir;
    return {
      dir,
      language: marker.language,
      marker: marker.file,
      name,
      hints: HINTS.filter((h) => existsSync(join(dir, h))),
    };
  }
  return undefined;
}

/**
 * Candidates at `root` and one level below it.
 *
 * One level, not recursive: a deep scan of a home directory is slow and the
 * answer is almost always a sibling folder. The dialog lets the user type a
 * different root when the answer is deeper.
 */
export function detectProjects(root: string, opts: { limit?: number } = {}): ProjectCandidate[] {
  const limit = opts.limit ?? 40;
  const out: ProjectCandidate[] = [];
  const self = existsSync(root) && statSync(root).isDirectory() ? readCandidate(root) : undefined;
  if (self) out.push(self);
  if (!existsSync(root)) return out;

  let children: string[] = [];
  try {
    children = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return out;
  }
  for (const child of children) {
    if (out.length >= limit) break;
    const found = readCandidate(join(root, child));
    if (found) out.push(found);
  }
  return out;
}
