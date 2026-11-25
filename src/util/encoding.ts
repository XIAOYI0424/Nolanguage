/**
 * Decode child-process output on Chinese Windows without corrupting UTF-8.
 *
 * A process started on Windows may write GBK (cmd.exe, javac, pip on a legacy
 * console) while another writes UTF-8 (Node, modern Python). `Buffer.toString`
 * cannot do both: `toString('utf8')` turns GBK into U+FFFD and `toString('latin1')`
 * mangles UTF-8. The decoder here tries strict UTF-8 first and falls back to GBK.
 *
 * # Why a stateful decoder
 *
 * A multi-byte UTF-8 character can be split across two stdout chunks. A stateless
 * strict decode of the first chunk fails, and a stateless fallback would turn a
 * perfectly good character into GBK garbage. `OutputDecoder` therefore keeps at
 * most three trailing bytes when they are a valid *incomplete* UTF-8 prefix and
 * prepends them to the next chunk. The protocol frames (LSP JSON-RPC, DAP) keep
 * their own UTF-8 parsing — this decoder is only for human-readable output.
 */
const MAX_PENDING = 3;

function strictUtf8(buf: Buffer): string | undefined {
  if (!buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return undefined;
  }
}

function gbk(): InstanceType<typeof TextDecoder> | undefined {
  try {
    return new TextDecoder('gbk');
  } catch {
    return undefined; // small-ICU build: keep the old lossy behaviour
  }
}

function decodeGbk(buf: Buffer): string {
  const decoder = gbk();
  return decoder ? decoder.decode(buf) : buf.toString('utf8');
}

function isContinuation(b: number): boolean {
  return b >= 0x80 && b <= 0xbf;
}

/** True when `tail` is a valid *partial* UTF-8 sequence awaiting more bytes. */
function isUtf8Prefix(tail: Buffer): boolean {
  const n = tail.length;
  if (!n || n > MAX_PENDING) return false;
  const a = tail[0];
  if (a >= 0xc2 && a <= 0xdf) return n === 1;
  if (a >= 0xe0 && a <= 0xef) {
    if (n === 1) return true;
    if (n !== 2 || !isContinuation(tail[1])) return false;
    if (a === 0xe0 && tail[1] < 0xa0) return false;
    if (a === 0xed && tail[1] > 0x9f) return false;
    return true;
  }
  if (a >= 0xf0 && a <= 0xf4) {
    if (n === 1) return true;
    if (!isContinuation(tail[1])) return false;
    if (n === 2) return true;
    if (!isContinuation(tail[2])) return false;
    if (a === 0xf0 && tail[1] < 0x90) return false;
    if (a === 0xf4 && tail[1] > 0x8f) return false;
    return true;
  }
  return false;
}

/** One-shot decode, for `execFile` results that already contain the whole output. */
export function decodeOutput(buf: Buffer): string {
  return strictUtf8(buf) ?? decodeGbk(buf);
}

/** Streaming decode, for stdout/stderr `data` events. */
export class OutputDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): string {
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const whole = strictUtf8(data);
    if (whole !== undefined) return whole;

    // Longest strict UTF-8 prefix (possibly the empty prefix). If what remains
    // is an incomplete sequence, hold it; otherwise the bytes really are GBK
    // (or corrupt) — decode all.
    let prefix = -1;
    for (let n = data.length - 1; n >= 0; n--) {
      if (strictUtf8(data.subarray(0, n)) !== undefined) { prefix = n; break; }
    }
    const tail = data.subarray(Math.max(0, prefix));
    if (prefix >= 0 && isUtf8Prefix(tail)) {
      this.pending = Buffer.from(tail);
      return prefix ? strictUtf8(data.subarray(0, prefix)) ?? '' : '';
    }
    return decodeGbk(data);
  }

  /** Call once when the stream closes so a dangling partial sequence is not lost. */
  flush(): string {
    if (!this.pending.length) return '';
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return decodeGbk(rest);
  }
}
