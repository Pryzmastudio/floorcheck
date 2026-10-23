// axe-core: injection, the conformance/advisory split, and tag parsing.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Only these can count as a WCAG A/AA failure. Everything else is advice.
export const CONFORMANCE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Real findings, but not conformance failures. They get their own section so a
// report never mixes "missing landmark" advice with actual A/AA failures.
export const ADVISORY_TAGS = ['best-practice', 'wcag2aaa', 'wcag21aaa', 'experimental'];

const LEVEL_FROM_TAG = {
  wcag2a: { level: 'A', version: '2.0' },
  wcag2aa: { level: 'AA', version: '2.0' },
  wcag21a: { level: 'A', version: '2.1' },
  wcag21aa: { level: 'AA', version: '2.1' },
  wcag22aa: { level: 'AA', version: '2.2' },
};

export const SEVERITY_FROM_IMPACT = { critical: 'P0', serious: 'P1', moderate: 'P2', minor: 'P3' };

// WCAG 2.2 level AAA criteria. Some A/AA rules also carry an AAA criterion
// tag (scrollable-region-focusable lists 2.1.3), which must not be counted.
const AAA_CRITERIA = new Set([
  '1.2.6', '1.2.7', '1.2.8', '1.2.9', '1.3.6', '1.4.6', '1.4.7', '1.4.8', '1.4.9',
  '2.1.3', '2.2.3', '2.2.4', '2.2.5', '2.2.6', '2.3.2', '2.3.3', '2.4.8', '2.4.9',
  '2.4.10', '2.4.12', '2.4.13', '2.5.5', '2.5.6', '3.1.3', '3.1.4', '3.1.5', '3.1.6',
  '3.2.5', '3.3.5', '3.3.6', '3.3.9',
]);

/** How many A/AA rules and A/AA success criteria the installed axe-core covers. */
export function axeCoverage() {
  const axe = require('axe-core');
  const rules = axe.getRules(CONFORMANCE_TAGS);
  const criteria = new Set();
  for (const r of rules) {
    for (const t of r.tags) {
      const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
      if (m && !AAA_CRITERIA.has(`${m[1]}.${m[2]}.${m[3]}`)) criteria.add(`${m[1]}.${m[2]}.${m[3]}`);
    }
  }
  return { rules: rules.length, criteria: criteria.size };
}

/**
 * Inject axe before any navigation with addInitScript, not addScriptTag.
 * addScriptTag inserts an inline <script>, so a strict Content-Security-Policy
 * blocks it and the scan quietly returns nothing. addInitScript is not subject
 * to the page's CSP and runs in every frame, which axe needs for iframes.
 */
export async function injectAxe(context, axePath) {
  await context.addInitScript({ path: axePath });
}

/** Load an axe locale bundle. Returns null for English, which is built in. */
export async function loadLocale(axeLocaleDir, locale) {
  if (!locale) return null;
  const [lang, region] = locale.toLowerCase().split(/[-_]/);
  if (lang === 'en') return null;
  // axe ships pl.json, pt_BR.json, zh_CN.json and so on.
  const names = region ? [`${lang}_${region.toUpperCase()}`, lang] : [lang];
  for (const name of names) {
    try {
      return JSON.parse(await readFile(path.join(axeLocaleDir, `${name}.json`), 'utf8'));
    } catch { /* try the next spelling */ }
  }
  return null;
}

/**
 * One axe run for one tag set. Conformance and advisory are separate runs so
 * their results can never be merged by accident further down.
 */
export async function runAxe(page, { tags, locale = null, exclude = [] }) {
  return page.evaluate(
    async ({ tags, locale, exclude }) => {
      if (typeof window.axe !== 'object') throw new Error('axe was not injected into this frame');
      if (locale) {
        try { window.axe.configure({ locale }); } catch { /* fall back to English */ }
      }
      const context = exclude.length ? { exclude: exclude.map((s) => [s]) } : document;
      const r = await window.axe.run(context, {
        runOnly: { type: 'tag', values: tags },
        resultTypes: ['violations', 'incomplete'],
        iframes: true,
        ancestry: true,
        xpath: true,
        selectors: true,
      });
      const strip = (nodes) => nodes.map((n) => ({
        target: n.target,
        ancestry: n.ancestry,
        xpath: n.xpath,
        html: n.html,
        failureSummary: n.failureSummary,
      }));
      const pick = (list) => list.map((v) => ({
        id: v.id,
        impact: v.impact,
        tags: v.tags,
        help: v.help,
        description: v.description,
        helpUrl: v.helpUrl,
        nodes: strip(v.nodes),
      }));
      return {
        engineVersion: r.testEngine.version,
        violations: pick(r.violations),
        incomplete: pick(r.incomplete),
      };
    },
    { tags, locale, exclude },
  );
}

/**
 * Success criterion, level and EN 301 549 clause come straight from axe's own
 * tags. A hand-written rule-to-criterion map would drift on every axe release.
 * WCAG 2.2-only criteria such as 2.5.8 have no EN clause, because
 * EN 301 549 v3.2.1 references WCAG 2.1.
 */
export function parseTags(tags = []) {
  let sc = null;
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
    if (m) { sc = `${m[1]}.${m[2]}.${m[3]}`; break; }
  }
  let level = null;
  let version = null;
  for (const t of tags) {
    const cand = LEVEL_FROM_TAG[t];
    // Keep the earliest WCAG version that introduced the criterion.
    if (cand && (!version || parseFloat(cand.version) < parseFloat(version))) {
      level = cand.level;
      version = cand.version;
    }
  }
  return {
    sc,
    level,
    wcagVersion: version,
    enClauses: tags.filter((t) => /^EN-9(\.\d+)+$/.test(t)),
  };
}

/**
 * Flatten axe output into the finding shape shared with the extra checks.
 * `incomplete` means axe could not decide. It goes to needs-review and is
 * never promoted to a violation.
 */
export function normalizeAxe(axeResult, { viewport, url, bucket }) {
  const list = bucket === 'incomplete' ? axeResult.incomplete : axeResult.violations;
  const out = [];
  for (const rule of list) {
    const meta = parseTags(rule.tags);
    for (const node of rule.nodes) {
      out.push({
        id: rule.id,
        source: 'axe',
        bucket,
        sc: meta.sc,
        level: meta.level,
        wcagVersion: meta.wcagVersion,
        enClauses: meta.enClauses,
        class: bucket === 'incomplete' ? 'flag' : 'report',
        impact: rule.impact,
        severity: bucket === 'incomplete' ? null : (SEVERITY_FROM_IMPACT[rule.impact] || 'P3'),
        selector: Array.isArray(node.target) ? node.target.join(' , ') : String(node.target ?? ''),
        ancestry: Array.isArray(node.ancestry) ? node.ancestry.join(' , ') : null,
        xpath: Array.isArray(node.xpath) ? node.xpath.join(' , ') : null,
        htmlSnippet: node.html,
        viewport,
        url,
        message: rule.help,
        detail: node.failureSummary || rule.description,
        helpUrl: rule.helpUrl,
        sourceLocation: null,
      });
    }
  }
  return out;
}
