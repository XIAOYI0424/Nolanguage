/**
 * One directory the registry scans.
 *
 * Vocabulary, not behaviour: `layers` builds the scan order, `pluginRoots`
 * produces the candidates and `Registry` consumes both. It lives in a file with
 * no imports so all three can point down at it instead of at each other — that
 * mutual import was a three-file cycle.
 */
export interface RegistryRoot {
  dir: string;
  kind: 'builtin' | 'user';
  removable: boolean;
}
