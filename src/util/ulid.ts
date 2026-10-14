const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE = ENCODING.length; // 32

/**
 * Generate a time-ordered 26-char ULID: 10 chars of timestamp (Crockford-ish
 * base32) + 16 chars of randomness. Monotonic enough for log ordering.
 */
export function ulid(time: number = Date.now()): string {
  let timeStr = '';
  let t = Math.floor(time);
  for (let i = 0; i < 10; i++) {
    timeStr = ENCODING[t % BASE] + timeStr;
    t = Math.floor(t / BASE);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += ENCODING[Math.floor(Math.random() * BASE)];
  }
  return timeStr + rand;
}
