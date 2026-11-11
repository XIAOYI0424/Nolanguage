/**
 * `nlg lang …` — source-checkout face of `src/commands/lang.ts`.
 *
 * The command itself lives in `src/commands/lang.ts` because the packaged exe
 * exposes the same verbs (`Nolanguage.exe lang …`); this file only supplies the
 * process boundary, so `nlg lang add …` and `Nolanguage.exe lang add …` cannot
 * drift apart.
 *
 * Usage is unchanged: `nlg lang <verb> [args]` (`nlg run lang` works too).
 */
import { runLang } from '../src/commands/lang.js';

process.exitCode = await runLang(process.argv.slice(2));
