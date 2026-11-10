'use strict';

/**
 * Sample target for the observatory (JavaScript).
 *
 * Contains the things the tool has to survive: nesting, a busy loop, an await
 * gap (no samples while idle — the page must not invent work), a secret in an
 * object, and a global so a watch expression has something to look at.
 *
 * Run it plainly: `node app.js [rounds]`.
 */

const state = {
  id: 7,
  api_token: 'sk-live-should-never-leave-the-process',
  items: [],
};

// A JS frame's locals are not reachable from outside, so watches evaluate in
// **global scope**. This line is what makes `order.items.length` work.
globalThis.order = state;

function step(n) {
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.sqrt(i);
  return total;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function work(rounds) {
  let acc = 0;
  for (let r = 0; r < rounds; r++) {
    acc += step(8_000_000);
    await sleep(10); // the gap where the sampler has nothing to report
  }
  return acc;
}

async function main() {
  const rounds = Number(process.argv[2] || 40);
  state.items.push({ name: 'a', price: 1.5 }, { name: 'b', price: 2.5 });
  const total = await work(rounds);
  console.log('total', Math.round(total), 'items', state.items.length, 'token-prefix', state.api_token.slice(0, 3));
}

main();
