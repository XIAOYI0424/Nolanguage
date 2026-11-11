/**
 * The engine version, in one place.
 *
 * `/health`, the desktop launcher's version handshake and the install receipt
 * must all agree on this string, otherwise the handshake compares two
 * different spellings of the same build and "reuses" a server that is actually
 * the previous version. Keeping it here (instead of a literal inside
 * `server.ts`) is what makes the handshake meaningful.
 *
 * The `-workspace` suffix marks the engine build that carries the PyCharm
 * shell; packaging metadata (package.json / NSIS / Cargo) tracks the plain
 * `major.minor.patch`. `scripts/verify-handshake.ts` asserts the two never
 * drift apart.
 */
export const APP_VERSION = '0.7.14-workspace';
