/**
 * Test-output formats the engine can turn into a case tree.
 *
 * A language plugin declares `run.testFormat` in its manifest; this table maps
 * that id to the parser that understands it. Keeping the mapping beside the
 * parsers (and not in the test handler) is what stops "add a language" from
 * turning into "edit the panel": the handler asks for a parser by the declared
 * id and has no opinion about which languages exist.
 *
 * A language with a test mode but no declared (or unknown) format still runs its
 * tests; it just streams plain output instead of per-case events.
 */
import { createGoTestParser, type IncrementalTestParser } from './testParser.js';

/** Ids are the format family whose output the test step prints. */
export const TEST_FORMATS: Record<string, () => IncrementalTestParser> = {
  go: createGoTestParser,
};

/** Build the parser a manifest asked for, or `undefined` when there is none. */
export function testParserFor(format: unknown): IncrementalTestParser | undefined {
  if (typeof format !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(TEST_FORMATS, format)) return undefined;
  return TEST_FORMATS[format]();
}
