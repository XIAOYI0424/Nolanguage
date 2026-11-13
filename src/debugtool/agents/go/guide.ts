/**
 * What `ndebug app.go` says when it cannot attach.
 *
 * Go is the one supported language where the answer is "not by running your
 * file". There is no `sitecustomize`, no `--require`, and no supported way to
 * inject a hook into a Go process from outside. Rather than attaching and
 * showing an empty page — or refusing with "unsupported" — the tool explains the
 * two things that actually work and the exact commands.
 *
 * This lives in its own module because it is copy, and copy that tells someone
 * what to do next is worth testing like code: it must name a working command,
 * and it must not promise features the pprof path cannot deliver.
 */
import { basename } from 'node:path';

export interface GoGuideOptions {
  /** Port to suggest in the example. */
  port?: number;
}

/** The message printed when someone runs `ndebug app.go`. */
export function goAttachGuide(script: string, opts: GoGuideOptions = {}): string {
  const port = opts.port ?? 6060;
  const name = basename(script);
  return [
    `ndebug: cannot attach to ${name} by itself.`,
    '',
    'Go has no runtime hook that can be installed from outside the process, so the',
    'observatory needs a pprof endpoint to poll. Two ways to get one:',
    '',
    `  1. ${name} already serves pprof (any net/http server with the import below):`,
    '',
    `       ndebug --attach http://127.0.0.1:${port}`,
    '',
    '  2. It does not — add these two lines and run it as usual:',
    '',
    '       import _ "net/http/pprof"',
    `       go http.ListenAndServe("127.0.0.1:${port}", nil)`,
    '',
    `     then: ndebug --attach http://127.0.0.1:${port}`,
    '',
    'What --attach gives you: every goroutine\'s stack at --hz, folded into hot',
    'stacks and stalls. What it cannot give you: locals and watches — a pprof',
    'endpoint reports stacks, not values. For those, use a real debugger (dlv).',
  ].join('\n');
}
