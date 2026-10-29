#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BootstrapError } from '../src/browser.mjs';
import { emitJson, emitMarkdown, FAIL_ON, pageLine, summarize } from '../src/report.mjs';
import { toSarif } from '../src/sarif.mjs';
import { packageVersion, scan } from '../src/scan.mjs';
import { selfTest } from '../src/self-test.mjs';
import { urlsFromSitemap } from '../src/sitemap.mjs';

const HELP = `floorcheck - WCAG 2.2 A/AA scan with axe-core, plus the checks axe does not have

Usage
  floorcheck <url...> [options]
  floorcheck --sitemap https://example.com/sitemap.xml [options]

Pages
  --sitemap URL          read page URLs from a sitemap or sitemap index
  --urls-file FILE       read page URLs from a file, one per line
  --max-pages N          limit for --sitemap and --urls-file (default 50)
  --all-origins          with --sitemap, keep URLs on other sites too

Scan
  --mode quick|full      quick: 1280px and 320px, failures only (default)
                         full: adds 390px, focus checks, advisory list, screenshots
  --viewports WxH,...    custom viewports, e.g. 1440x900,375x667
  --concurrency N        pages scanned at the same time (default 2)
  --timeout MS           page load timeout (default 45000)
  --wait MS              extra wait after load (default 400)
  --wait-for SELECTOR    wait until this element exists, for pages built by JavaScript
  --header "Name: v"     add a request header, repeatable. Sent only to the scanned site,
                         e.g. --header "Cookie: session=..." for pages behind a login
  --exclude SELECTOR     leave a region out, repeatable, e.g. a third-party chat widget
  --locale CODE          language of the axe messages: en (default), pl, de, fr, es, ...
                         or auto to follow the page's own language
  --allow-error-pages    scan pages that look like errors, bot checks or maintenance
  --no-extra-checks      axe-core only

Output
  --out DIR              where findings.md and findings.json go (default ./floorcheck-report)
  --no-report            do not write report files
  --json                 print the full JSON report to stdout
  --sarif FILE           also write SARIF 2.1.0 for GitHub code scanning. Only failures that
                         --project can place at a file and line go in
  --advisory             list best-practice and AAA findings as well
  --fail-on LEVEL        lowest impact that fails the run: critical, serious, moderate,
                         minor (default) or none
  --project DIR          point findings at likely file:line in your source code,
                         and run jsx-a11y if the project has ESLint and the plugin

Other
  --self-test            scan the built-in test page and confirm every check works
  --headed               show the browser window
  -v, --version
  -h, --help

Exit codes
  0  every page scanned, no failures at or above --fail-on
  1  failures found
  2  usage error, no browser, or at least one page could not be scanned.
     A page that was not scanned is never reported as clean.
`;

function fail(msg) {
  process.stderr.write(`floorcheck: ${msg}\n\nRun floorcheck --help for options.\n`);
  process.exit(2);
}

function positiveInt(name, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${name} needs a whole number, got "${value}"`);
  return n;
}

function parseViewports(spec) {
  if (!spec) return null;
  return spec.split(',').map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s.trim());
    if (!m) fail(`bad viewport "${s}", expected WIDTHxHEIGHT such as 1280x800`);
    return { w: Number(m[1]), h: Number(m[2]) };
  });
}

function parseHeaders(list = []) {
  const headers = {};
  for (const h of list) {
    const i = h.indexOf(':');
    if (i < 1) fail(`bad header "${h}", expected "Name: value"`);
    headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  return headers;
}

function normalizeUrl(u) {
  if (/^(https?|file):\/\//i.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return `https://${u}`;
  fail(`"${u}" does not look like a URL`);
}

async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        sitemap: { type: 'string' },
        'urls-file': { type: 'string' },
        'max-pages': { type: 'string' },
        'all-origins': { type: 'boolean' },
        mode: { type: 'string' },
        viewports: { type: 'string' },
        concurrency: { type: 'string' },
        timeout: { type: 'string' },
        wait: { type: 'string' },
        'wait-for': { type: 'string' },
        header: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        locale: { type: 'string' },
        'allow-error-pages': { type: 'boolean' },
        'no-extra-checks': { type: 'boolean' },
        out: { type: 'string', short: 'o' },
        'no-report': { type: 'boolean' },
        json: { type: 'boolean' },
        sarif: { type: 'string' },
        advisory: { type: 'boolean' },
        'fail-on': { type: 'string' },
        project: { type: 'string' },
        'self-test': { type: 'boolean' },
        'update-expected': { type: 'boolean' },
        headed: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const o = args.values;

  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(`${await packageVersion()}\n`); return 0; }

  if (o['self-test']) {
    process.stderr.write('floorcheck self-test: scanning the built-in test page...\n');
    const res = await selfTest({ update: o['update-expected'] });
    if (res.updated) { process.stderr.write(`expected.json regenerated with axe-core ${res.axeCore}\n`); return 0; }
    if (res.ok) { process.stderr.write(`self-test passed (axe-core ${res.axeCore}): every planted problem was found.\n`); return 0; }
    process.stderr.write(`self-test FAILED. Do not trust scan results until this passes:\n${res.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }

  const mode = o.mode || 'quick';
  if (!['quick', 'full'].includes(mode)) fail(`--mode must be quick or full, got "${mode}"`);
  const failOn = o['fail-on'] || 'minor';
  if (!FAIL_ON.includes(failOn)) fail(`--fail-on must be one of ${FAIL_ON.join(', ')}`);
  const maxPages = positiveInt('--max-pages', o['max-pages'], 50);

  let urls = args.positionals.map(normalizeUrl);
  if (o['urls-file']) {
    const text = await readFile(o['urls-file'], 'utf8').catch((e) => fail(`cannot read ${o['urls-file']}: ${e.message}`));
    const fromFile = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(normalizeUrl);
    if (fromFile.length > maxPages) process.stderr.write(`using the first ${maxPages} of ${fromFile.length} URLs (raise with --max-pages)\n`);
    urls.push(...fromFile.slice(0, maxPages));
  }
  if (o.sitemap) {
    process.stderr.write(`reading ${o.sitemap} ...\n`);
    let sm;
    try {
      sm = await urlsFromSitemap(normalizeUrl(o.sitemap), { maxPages, sameOrigin: !o['all-origins'] });
    } catch (err) {
      fail(err.message);
    }
    process.stderr.write(`  ${sm.urls.length} page(s)${sm.truncated ? ` (stopped at --max-pages ${maxPages})` : ''}`
      + `${sm.skippedOtherOrigin ? `, ${sm.skippedOtherOrigin} on other sites skipped` : ''}\n`);
    urls.push(...sm.urls);
  }
  urls = [...new Set(urls)];
  if (!urls.length) { process.stderr.write(HELP); return 2; }

  const outDir = o['no-report'] ? null : path.resolve(o.out || 'floorcheck-report');
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    // Keeps reports out of git without touching the project's own .gitignore.
    await writeFile(path.join(outDir, '.gitignore'), '*\n');
  }

  process.stderr.write(`scanning ${urls.length} page${urls.length === 1 ? '' : 's'} (${mode} mode)\n`);
  const report = await scan(urls, {
    mode,
    viewports: parseViewports(o.viewports),
    concurrency: positiveInt('--concurrency', o.concurrency, 2) || 1,
    timeout: positiveInt('--timeout', o.timeout, 45000),
    wait: positiveInt('--wait', o.wait, 400),
    waitFor: o['wait-for'] || null,
    headers: parseHeaders(o.header),
    exclude: o.exclude || [],
    locale: o.locale || 'en',
    allowErrorPages: !!o['allow-error-pages'],
    extraChecks: !o['no-extra-checks'],
    advisory: !!o.advisory,
    outDir,
    project: o.project || null,
    headless: !o.headed,
    failOn,
    onPage: (r) => process.stderr.write(`${pageLine(r)}\n`),
  });

  if (outDir) {
    await emitJson(outDir, report);
    await emitMarkdown(outDir, report, { advisory: !!o.advisory });
  }
  const sum = summarize(report, failOn);
  process.stderr.write(`\n${sum.human}\n`);
  if (outDir) {
    const md = path.join(outDir, 'findings.md');
    const rel = path.relative(process.cwd(), md);
    process.stderr.write(`report: ${rel.startsWith('..') ? md : rel}\n`);
  }
  if (o.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (o.sarif) {
    const sarif = toSarif(report, { projectRoot: o.project ? path.resolve(o.project) : null });
    await writeFile(path.resolve(o.sarif), `${JSON.stringify(sarif, null, 2)}\n`);
    const n = sarif.runs[0].results.length;
    process.stderr.write(`sarif: ${o.sarif} (${n} result${n === 1 ? '' : 's'} placed in your source`
      + `${o.project ? '' : '; add --project so failures can point at file:line'})\n`);
  }

  if (sum.notScanned) {
    process.stderr.write(`\n${sum.notScanned} page(s) were not scanned. That is not a pass.\n`);
    return 2;
  }
  if (sum.failing) {
    if (failOn !== 'minor') process.stderr.write(`${sum.failing} failure(s) at or above "${failOn}".\n`);
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code ?? 0), (err) => {
  if (err instanceof BootstrapError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`floorcheck: unexpected error\n${err.stack}\n`);
  }
  process.exit(2);
});
