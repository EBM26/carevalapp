// Run the scoring tests in Node: `npm test` or `node scripts/run-tests.js`
import { runAll } from '../public/tests.js';

const results = runAll();
let group = null;
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`\n${group}`); }
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? '' : `\n      ${r.error}`}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
