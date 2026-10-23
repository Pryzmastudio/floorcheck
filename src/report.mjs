// Report output. findings.md is for people, findings.json is the full record.
//
// Three buckets never share a section: conformance failures, needs-review
// (axe `incomplete` plus our flags) and advisory. Only the first one says
// anything about WCAG conformance.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const IMPACT_RANK = { minor: 1, moderate: 2, serious: 3, critical: 4 };
export const FAIL_ON = ['critical', 'serious', 'moderate', 'minor', 'none'];

export function bucketOf(f) {
  if (f.class === 'advisory') return 'advisory';
  if (f.contextOnly) return 'context';
  if (f.class === 'lint') return 'lint';
  if (f.bucket === 'incomplete' || f.class === 'flag') return 'review';
  return 'conformance';
}

/** Does this conformance finding fail the run at the given --fail-on level? */
export function failsAt(f, failOn = 'minor') {
  if (failOn === 'none' || bucketOf(f) !== 'conformance') return false;
  return (IMPACT_RANK[f.impact] || 1) >= IMPACT_RANK[failOn];
}

export function summarize(report, failOn = 'minor') {
  const s = { conformance: 0, review: 0, advisory: 0, context: 0, lint: 0, failing: 0, scanned: 0, notScanned: 0 };
  for (const r of report.results) {
    if (r.lintOnly) { s.lint += r.findings.length; continue; }
    if (!r.ok) { s.notScanned++; continue; }
    s.scanned++;
    s.advisory += r.advisoryTotal || 0;
    for (const f of r.findings || []) {
      const b = bucketOf(f);
      if (b !== 'advisory') s[b]++;
      if (failsAt(f, failOn)) s.failing++;
    }
  }
  const parts = [
    `${s.conformance} WCAG A/AA failure${s.conformance === 1 ? '' : 's'}`,
    `${s.review} to review`,
    `${s.advisory} advisory`,
  ];
  if (s.lint) parts.push(`${s.lint} lint`);
  parts.push(`${s.scanned} page${s.scanned === 1 ? '' : 's'} scanned`);
  if (s.notScanned) parts.push(`${s.notScanned} NOT scanned`);
  return { ...s, human: parts.join(' | ') };
}

/** One line per page for the terminal. */
export function pageLine(r) {
  if (!r.ok) return `  -  ${r.url}\n     not scanned: ${r.error}`;
  const conf = r.findings.filter((f) => bucketOf(f) === 'conformance');
  const review = r.findings.filter((f) => bucketOf(f) === 'review').length;
  const rules = [...new Set(conf.map((f) => f.id))];
  const overlay = r.findings.some((f) => f.id === 'accessibility-overlay-detected') ? ' [overlay/toolbar found]' : '';
  const mark = conf.length ? 'x' : 'ok';
  const head = `  ${mark.padEnd(2)} ${r.target?.finalUrl || r.url}${overlay}`;
  const tail = conf.length
    ? `\n     ${conf.length} failure${conf.length === 1 ? '' : 's'}: ${rules.slice(0, 6).join(', ')}${rules.length > 6 ? ', ...' : ''}${review ? ` | ${review} to review` : ''}`
    : (review ? `\n     no automated failures | ${review} to review` : '');
  return head + tail;
}

export async function emitJson(outDir, report) {
  await writeFile(path.join(outDir, 'findings.json'), `${JSON.stringify(report, null, 2)}\n`);
}

const MAX_NODES_SHOWN = 10;

function fmtSource(sl) {
  if (!sl) return null;
  if (Array.isArray(sl.candidates)) {
    return `${sl.candidates.map((c) => `\`${c.file}:${c.line}\``).join(' or ')} (low confidence, via ${sl.via})`;
  }
  return `\`${sl.file}:${sl.line}\` (${sl.confidence}, via ${sl.via})`;
}

const oneLine = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

// Backticks inside inline code would end the code span early.
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

/**
 * One entry per rule, not per element. On a real site a single gradient
 * background can produce a hundred colour-contrast nodes, which would bury
 * everything else. The per-element list stays in findings.json.
 */
function fmtGroup(group, i) {
  const f = group[0];
  const lines = [];
  const scLabel = f.sc
    ? `WCAG ${f.sc}${f.level ? ` (${f.level}${f.wcagVersion ? `, since ${f.wcagVersion}` : ''})` : ''}`
    : 'no success criterion';
  const sev = f.severity ? `${f.severity} · ` : '';
  const count = group.length;

  lines.push(`#### ${i}. ${sev}\`${f.id}\` · ${count} element${count === 1 ? '' : 's'}`, '', f.message, '');
  lines.push(`- **Criterion:** ${scLabel}${f.enClauses?.length ? ` · EN 301 549 ${f.enClauses.join(', ')}` : ''}`);
  lines.push(`- **Source:** ${f.source === 'axe' ? 'axe-core' : 'floorcheck'}${f.impact ? `, impact "${f.impact}"` : ''}`);
  const viewports = [...new Set(group.flatMap((g) => g.viewports || []))];
  if (viewports.length) lines.push(`- **Seen at:** ${viewports.join(', ')}`);
  if (f.detail) lines.push(`- **Details:** ${oneLine(f.detail, 600)}`);
  if (f.helpUrl) lines.push(`- **Reference:** ${f.helpUrl}`);

  const shown = group.slice(0, MAX_NODES_SHOWN);
  if (shown.some((g) => g.selector || g.htmlSnippet || g.sourceLocation)) {
    lines.push(`- **Element${count === 1 ? '' : 's'}${count > MAX_NODES_SHOWN ? ` (first ${MAX_NODES_SHOWN} of ${count})` : ''}:**`, '');
    for (const g of shown) {
      const src = fmtSource(g.sourceLocation);
      lines.push(`  - ${g.selector ? code(g.selector) : '(no selector)'}${src ? ` -> ${src}` : ''}`);
      if (g.htmlSnippet) lines.push(`    ${code(oneLine(g.htmlSnippet, 160))}`);
    }
    if (count > MAX_NODES_SHOWN) lines.push('', `  ...and ${count - MAX_NODES_SHOWN} more in \`findings.json\`.`);
  }
  lines.push('');
  return lines.join('\n');
}

function groupByRule(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.source}::${f.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.values()].sort((a, b) => {
    const sv = (SEV_ORDER[a[0].severity] ?? 4) - (SEV_ORDER[b[0].severity] ?? 4);
    if (sv !== 0) return sv;
    if (b.length !== a.length) return b.length - a.length;
    return String(a[0].sc).localeCompare(String(b[0].sc), undefined, { numeric: true });
  });
}

function section(title, note, findings) {
  if (!findings.length) return `### ${title}\n\nNone found.\n`;
  const groups = groupByRule(findings);
  const head = `${findings.length} finding${findings.length === 1 ? '' : 's'} across ${groups.length} rule${groups.length === 1 ? '' : 's'}.`;
  return [`### ${title}`, '', note, '', head, '', ...groups.map((g, i) => fmtGroup(g, i + 1))].join('\n');
}

export async function emitMarkdown(outDir, report, { advisory = false } = {}) {
  const { manifest, results } = report;
  const sum = summarize(report, manifest.run.failOn);
  const cov = manifest.engine.axeCoverage;
  const out = [];

  out.push('# Accessibility scan', '', `**${sum.human}**`, '');
  out.push(`> An automated scan finds only part of the problems. axe-core ${manifest.engine.axeCore} has rules for`);
  out.push(`> ${cov.criteria} of the WCAG 2.2 A/AA success criteria, and even for those it cannot judge everything.`);
  out.push('> A page with no failures here still needs keyboard and screen reader testing before anyone');
  out.push('> calls it accessible. Start with https://www.w3.org/WAI/test-evaluate/');
  out.push('');

  out.push('## Run', '', '| Field | Value |', '|---|---|');
  out.push(`| floorcheck | ${manifest.version} |`);
  out.push(`| Mode | ${manifest.run.mode} |`);
  out.push(`| axe-core | ${manifest.engine.axeCore} |`);
  out.push(`| Browser | ${manifest.browser.version} (${manifest.browser.tier}) |`);
  out.push(`| Viewports | ${manifest.run.viewports.join(', ')} |`);
  if (manifest.run.exclude?.length) out.push(`| Excluded | ${manifest.run.exclude.map(code).join(', ')} |`);
  out.push(`| Started | ${manifest.run.startedAt} |`);
  if (manifest.run.project) out.push(`| Source mapping | ${manifest.run.sourceMapping} |`);
  if (manifest.run.lint) out.push(`| jsx-a11y | ${manifest.run.lint} |`);
  out.push('');

  for (const r of results) {
    if (r.lintOnly) {
      out.push(`## Source lint (${r.url})`, '');
      if (r.lintConfigHint) {
        out.push('> A lint rule that fails the build catches these for good. Enable the full jsx-a11y set:', '');
        out.push('```js', r.lintConfigHint, '```', '');
      }
      out.push(section('Lint findings', 'Static analysis: a likely problem at a place in the code, not a confirmed failure in the browser.', r.findings));
      continue;
    }
    if (!r.ok) {
      out.push(`## ${r.url}`, '', `**Not scanned:** ${r.error}`, '');
      if (r.notScanned) out.push('Pass `--allow-error-pages` to scan it anyway.', '');
      continue;
    }

    const t = r.target;
    out.push(`## ${t.finalUrl || r.url}`, '', '| Field | Value |', '|---|---|');
    if (t.finalUrl && t.finalUrl !== t.requestedUrl) out.push(`| Requested | ${t.requestedUrl} |`);
    out.push(`| HTTP | ${t.httpStatus ?? 'n/a'} |`);
    out.push(`| Title | ${t.title ? oneLine(t.title, 120).replace(/\|/g, '\\|') : '(none)'} |`);
    out.push(`| html[lang] | ${t.htmlLang || '(missing)'} |`);
    if (r.screenshots?.length) out.push(`| Screenshots | ${r.screenshots.join(', ')} |`);
    out.push('');

    const by = { conformance: [], review: [], advisory: [], context: [] };
    for (const f of r.findings) by[bucketOf(f)]?.push(f);

    if (by.context.length) out.push(section('Context', 'Facts about the page that change how the results should be read. Not failures.', by.context));
    out.push(section('WCAG A/AA failures', 'Failures the tools can decide on their own. Only this section speaks to conformance.', by.conformance));
    out.push(section('Needs review', 'axe could not decide, or one of our checks found a likely problem. Check each one by hand before reporting it.', by.review));
    if (advisory || manifest.run.mode === 'full') {
      out.push(section('Advisory', 'Best practices and AAA. Worth fixing, but not WCAG A/AA failures.', by.advisory));
    } else {
      out.push(`### Advisory\n\n${r.advisoryTotal || 0} advisory finding(s) hidden. Run with \`--advisory\` to list them.\n`);
    }
  }

  await writeFile(path.join(outDir, 'findings.md'), out.join('\n'));
}
