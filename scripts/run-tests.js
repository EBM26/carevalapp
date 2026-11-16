// Run the scoring tests in Node: `npm test` or `node scripts/run-tests.js`
// The browser test suite never needs the network; fail loudly if anything tries.
globalThis.fetch = async (url) => { throw new Error(`Unexpected network request in tests: ${url}`); };

const { runAll } = await import('../public/tests.js');

const results = await runAll();
let group = null;
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`\n${group}`); }
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? '' : `\n      ${r.error}`}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
