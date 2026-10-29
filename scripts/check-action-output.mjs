// CI check for the GitHub Action: the scan of the negative control must leave
// a SARIF file whose results point at the fixture, a summary and the outputs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const sarif = JSON.parse(readFileSync(process.env.SARIF, 'utf8'));
const results = sarif.runs[0].results;
assert.ok(results.length >= 5, `expected at least 5 SARIF results, got ${results.length}`);
for (const r of results) {
  assert.equal(r.locations[0].physicalLocation.artifactLocation.uri, 'test/fixtures/negative-control.html');
}
assert.ok(Number(process.env.FAILURES) >= 10, `expected at least 10 failures, got ${process.env.FAILURES}`);
const summary = readFileSync(path.join(process.env.REPORT_DIR, 'summary.md'), 'utf8');
assert.match(summary, /floorcheck: WCAG 2\.2 A\/AA/);
console.log(`action ok: ${results.length} SARIF results, ${process.env.FAILURES} failures`);
