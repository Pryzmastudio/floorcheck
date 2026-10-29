#!/usr/bin/env node
// Runs floorcheck against the W3C ACT Rules test cases and writes an EARL
// (JSON-LD) report, the format the ACT Rules Community Group uses to list
// implementations: https://www.w3.org/WAI/standards-guidelines/act/implementations/
//
//   node scripts/act-report.mjs [--out act/floorcheck-earl.json] [--testcases <url|file>] [--concurrency 4]
//
// Procedures reported:
//   - every axe-core rule that axe itself maps to an ACT rule (axe's actIds),
//     run exactly as floorcheck runs axe;
//   - floorcheck's own focus check (focus-no-visible-change), mapped to ACT
//     rule oj04fd. It only ever says cantTell or passed: it compares the
//     element's own painted style, so it cannot prove a failure on its own.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { engineInfo, launchBrowser } from '../src/browser.mjs';
import { injectAxe } from '../src/axe.mjs';
import { packageVersion } from '../src/scan.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'act/floorcheck-earl.json' },
    testcases: { type: 'string', default: 'https://www.w3.org/WAI/content-assets/wcag-act-rules/testcases.json' },
    concurrency: { type: 'string', default: '4' },
  },
});

const SC_IDS = JSON.parse(await readFile(path.join(here, 'wcag-sc.json'), 'utf8'));

async function loadTestcases(src) {
  if (/^https?:/.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`could not download test cases: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(src, 'utf8'));
}

const axe = require('axe-core');
const axeRules = axe._audit.rules.filter((r) => r.actIds?.length);
const axeByAct = new Map();
for (const r of axeRules) {
  for (const id of r.actIds) {
    if (!axeByAct.has(id)) axeByAct.set(id, []);
    axeByAct.get(id).push(r);
  }
}

function criteriaOf(tags) {
  const out = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
    if (m && SC_IDS[`${m[1]}.${m[2]}.${m[3]}`]) out.push(SC_IDS[`${m[1]}.${m[2]}.${m[3]}`]);
  }
  return out;
}

const OWN = {
  'focus-no-visible-change': { actIds: ['oj04fd'], isPartOf: [SC_IDS['2.4.7']] },
};
const ownByAct = new Map();
for (const [name, p] of Object.entries(OWN)) for (const id of p.actIds) ownByAct.set(id, name);

const data = await loadTestcases(args.testcases);
const cases = data.testcases.filter((t) => axeByAct.has(t.ruleId) || ownByAct.has(t.ruleId));
const injected = await readFile(path.join(here, '..', 'src', 'injected-checks.js'), 'utf8');

const engine = engineInfo();
const { browser } = await launchBrowser(engine.chromium);
const assertions = [];
let untested = 0;
let next = 0;

const outcomeFor = (res, ruleId) => {
  if (res.violations.includes(ruleId)) return 'earl:failed';
  if (res.incomplete.includes(ruleId)) return 'earl:cantTell';
  if (res.passes.includes(ruleId)) return 'earl:passed';
  return 'earl:inapplicable';
};

async function runCase(tc) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // A test case that never settles must not stall the whole run: closing the
  // context makes every pending call fail, and the case is reported untested.
  const watchdog = setTimeout(() => {
    process.stderr.write(`  timeout ${tc.ruleId} ${tc.testcaseId}\n`);
    context.close().catch(() => {});
  }, 60000);
  await injectAxe(context, engine.axePath);
  const page = await context.newPage();
  // Some test cases redirect themselves (meta refresh). A real browser would
  // leave, so holding it on the page would test something no user ever sees.
  // Such cases are left untested instead of getting an invented result.
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
  try {
    await page.goto(tc.url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(250);
    if (navigations > 1 || page.url() !== tc.url) throw new Error('the page redirected itself');

    // Plain XML is not a web page: none of the HTML rules apply to it.
    const contentType = await page.evaluate(() => document.contentType);
    const isMarkup = /html|svg/.test(contentType);

    const rules = (axeByAct.get(tc.ruleId) || []).map((r) => r.id);
    if (rules.length && !isMarkup) {
      for (const r of axeByAct.get(tc.ruleId)) {
        const meta = axe.getRules().find((x) => x.ruleId === r.id);
        assertions.push(assertion(tc, r.id, criteriaOf(meta?.tags || []), 'earl:inapplicable'));
      }
    } else if (rules.length) {
      const res = await page.evaluate(async (ids) => {
        const r = await window.axe.run(document, { runOnly: { type: 'rule', values: ids }, iframes: true });
        const ids2 = (list) => list.map((x) => x.id);
        return { violations: ids2(r.violations), incomplete: ids2(r.incomplete), passes: ids2(r.passes) };
      }, rules);
      for (const r of axeByAct.get(tc.ruleId)) {
        const meta = axe.getRules().find((x) => x.ruleId === r.id);
        assertions.push(assertion(tc, r.id, criteriaOf(meta?.tags || []), outcomeFor(res, r.id)));
      }
    }

    const own = ownByAct.get(tc.ruleId);
    if (own && !isMarkup) {
      assertions.push(assertion(tc, own, OWN[own].isPartOf, 'earl:inapplicable'));
    } else if (own === 'focus-no-visible-change') {
      await page.evaluate(injected);
      const r = await page.evaluate(() => {
        const out = window.__floorcheck.run({ isPrimary: true, includeFlags: true, focusLimit: 60, viewportWidth: 1280 });
        const sel = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
        const focusable = [...document.querySelectorAll(sel)].filter((el) => {
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return !el.disabled && el.tabIndex >= 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }).length;
        return { flagged: out.checks.some((c) => c.id === 'focus-no-visible-change'), focusable };
      });
      const outcome = r.flagged ? 'earl:cantTell' : (r.focusable ? 'earl:passed' : 'earl:inapplicable');
      assertions.push(assertion(tc, own, OWN[own].isPartOf, outcome));
    }
  } catch (err) {
    untested++;
    process.stderr.write(`  untested ${tc.ruleId} ${tc.testcaseId}: ${String(err.message).split('\n')[0]}\n`);
  } finally {
    clearTimeout(watchdog);
    await context.close().catch(() => {});
  }
}

function assertion(tc, title, isPartOf, outcome) {
  return {
    '@type': 'Assertion',
    mode: 'earl:automatic',
    subject: { '@type': 'TestSubject', source: tc.url },
    test: { '@type': 'TestCase', title, isPartOf },
    result: { '@type': 'TestResult', outcome },
  };
}

async function worker() {
  while (next < cases.length) {
    const tc = cases[next++];
    await runCase(tc);
    if (next % 50 === 0) process.stderr.write(`  ${next}/${cases.length}\n`);
  }
}

process.stderr.write(`running ${cases.length} ACT test cases\n`);
await Promise.all(Array.from({ length: Number(args.concurrency) || 4 }, worker));
await browser.close();

const version = await packageVersion();
const report = {
  '@context': 'https://act-rules.github.io/earl-context.json',
  '@graph': [
    {
      '@type': 'Assertor',
      name: 'floorcheck',
      vendor: 'Vayle',
      homepage: 'https://github.com/Pryzmastudio/floorcheck',
      release: { revision: version },
      description: `floorcheck ${version} with axe-core ${engine.versions['axe-core']}`,
    },
    ...assertions,
  ],
};
await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`wrote ${assertions.length} assertions to ${args.out} (${untested} test cases could not be run)\n`);
