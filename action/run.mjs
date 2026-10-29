// Runs floorcheck inside the GitHub Action, then writes the job summary,
// up to ten annotations and the step outputs. Inputs arrive as environment
// variables so nothing from the workflow file is ever pasted into a shell.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketOf } from '../src/report.mjs';

const BIN = fileURLToPath(new URL('../bin/floorcheck.mjs', import.meta.url));
const MAX_ANNOTATIONS = 10;
const IMPACT_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1 };
const env = (name) => (process.env[name] || '').trim();

/** Splits an options string the way a shell would, quotes included. */
export function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const cell = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '\\|').replace(/\n/g, ' ');

function buildArgs() {
  const reportDir = env('FC_REPORT_DIR') || 'floorcheck-report';
  const sarif = env('FC_SARIF') || 'floorcheck.sarif';
  const args = env('FC_URLS').split(/[\s,]+/).filter(Boolean);
  if (env('FC_SITEMAP')) args.push('--sitemap', env('FC_SITEMAP'));
  if (!args.length) {
    process.stdout.write('::error title=floorcheck::Give the action some urls or a sitemap.\n');
    process.exit(2);
  }
  if (env('FC_MAX_PAGES')) args.push('--max-pages', env('FC_MAX_PAGES'));
  if (env('FC_PROJECT')) args.push('--project', env('FC_PROJECT'));
  if (env('FC_FAIL_ON')) args.push('--fail-on', env('FC_FAIL_ON'));
  if (env('FC_LOCALE')) args.push('--locale', env('FC_LOCALE'));
  args.push('--out', reportDir, '--sarif', sarif, ...splitArgs(env('FC_ARGS')));
  return { args, reportDir, sarif };
}

function summaryMarkdown(report) {
  const scanned = report.results.filter((r) => r.ok && !r.lintOnly);
  const notScanned = report.results.filter((r) => !r.ok && !r.lintOnly);
  const failures = scanned.flatMap((r) => r.findings.filter((f) => bucketOf(f) === 'conformance').map((f) => ({ ...f, page: r.url })));
  const review = scanned.reduce((n, r) => n + r.findings.filter((f) => bucketOf(f) === 'review').length, 0);

  const lines = ['## floorcheck: WCAG 2.2 A/AA', ''];
  lines.push(`**${failures.length}** failure${failures.length === 1 ? '' : 's'} on ${scanned.length} page${scanned.length === 1 ? '' : 's'}`
    + `, ${review} to review by hand${notScanned.length ? `, **${notScanned.length} not scanned**` : ''}.`, '');

  if (failures.length) {
    const byRule = new Map();
    for (const f of failures) {
      const g = byRule.get(f.id) || { id: f.id, sc: f.sc, message: f.message, elements: 0, pages: new Set() };
      g.elements++;
      g.pages.add(f.page);
      byRule.set(f.id, g);
    }
    lines.push('| WCAG | Rule | Elements | Pages |', '|---|---|---:|---:|');
    for (const g of [...byRule.values()].sort((a, b) => b.elements - a.elements).slice(0, 15)) {
      lines.push(`| ${cell(g.sc || '')} | \`${cell(g.id)}\` ${cell(g.message)} | ${g.elements} | ${g.pages.size} |`);
    }
    lines.push('');
  }
  if (notScanned.length) {
    lines.push('Not scanned (this is not a pass):', '');
    for (const r of notScanned.slice(0, 20)) lines.push(`- ${r.url}: ${cell(r.error)}`);
    lines.push('');
  }
  lines.push('Automated rules cover part of WCAG. A page with no failures still needs a keyboard and screen reader check.');
  return { markdown: `${lines.join('\n')}\n`, failures, notScanned };
}

function annotate(failures, projectRoot) {
  const ordered = [...failures].sort((a, b) => (IMPACT_RANK[b.impact] || 0) - (IMPACT_RANK[a.impact] || 0));
  const seen = new Set();
  let n = 0;
  for (const f of ordered) {
    const loc = f.sourceLocation?.file && f.sourceLocation.line ? f.sourceLocation : null;
    const key = loc ? `${f.id}|${loc.file}|${loc.line}` : `${f.id}|${f.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const props = [`title=${escapeProp(`floorcheck: ${f.id}${f.sc ? ` (WCAG ${f.sc})` : ''}`)}`];
    if (loc) {
      const file = path.relative(process.cwd(), path.resolve(projectRoot || '.', loc.file)).split(path.sep).join('/');
      props.unshift(`file=${escapeProp(file)}`, `line=${loc.line}`);
    }
    const text = `${f.message}${f.selector ? ` (${f.selector})` : ''} on ${f.page}`;
    process.stdout.write(`::error ${props.join(',')}::${escapeData(text)}\n`);
    if (++n >= MAX_ANNOTATIONS) break;
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const { args, reportDir, sarif } = buildArgs();
  const run = spawnSync(process.execPath, [BIN, ...args], { stdio: 'inherit' });
  const code = run.status ?? 2;

  const json = path.join(reportDir, 'findings.json');
  if (!existsSync(json)) return code;
  const report = JSON.parse(readFileSync(json, 'utf8'));
  const { markdown, failures, notScanned } = summaryMarkdown(report);
  writeFileSync(path.join(reportDir, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  annotate(failures, env('FC_PROJECT') || null);

  setOutput('failures', failures.length);
  setOutput('not-scanned', notScanned.length);
  setOutput('sarif-file', sarif);
  setOutput('report-dir', reportDir);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
