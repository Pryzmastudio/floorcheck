// SARIF 2.1.0 output for GitHub code scanning and other tools that read it.
//
// Code scanning only shows a result that points at a file and line, so only
// findings that --project placed in the source become results. Everything
// else stays in findings.md and findings.json.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { bucketOf } from './report.mjs';

const LEVEL = { conformance: 'error', lint: 'warning', review: 'note' };
const INFO_URI = 'https://github.com/Pryzmastudio/floorcheck';

/**
 * @param {object} report the object scan() returns
 * @param {object} [opts]
 * @param {string|null} [opts.projectRoot] the --project directory; source paths are relative to it
 * @param {string} [opts.cwd] SARIF paths are written relative to this (the repository root in CI)
 */
export function toSarif(report, { projectRoot = null, cwd = process.cwd() } = {}) {
  const rules = new Map();
  const results = new Map();

  for (const page of report.results || []) {
    for (const f of page.findings || []) {
      const level = LEVEL[bucketOf(f)];
      const loc = f.sourceLocation;
      if (!level || !loc?.file || !loc.line) continue;

      const file = projectRoot ? path.resolve(projectRoot, loc.file) : path.resolve(cwd, loc.file);
      const uri = path.relative(cwd, file).split(path.sep).join('/');
      const fingerprint = createHash('sha256').update(`${f.id}\n${uri}\n${loc.line}\n${f.selector || ''}`).digest('hex');

      const seen = results.get(fingerprint);
      if (seen) {
        if (page.url && !seen.properties.pages.includes(page.url)) seen.properties.pages.push(page.url);
        continue;
      }
      if (!rules.has(f.id)) rules.set(f.id, rule(f));
      results.set(fingerprint, {
        ruleId: f.id,
        level,
        message: { text: messageText(f, page.url) },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
            region: { startLine: loc.line },
          },
        }],
        partialFingerprints: { 'floorcheck/v1': fingerprint },
        properties: {
          pages: page.url ? [page.url] : [],
          selector: f.selector || undefined,
          impact: f.impact || undefined,
          confidence: loc.confidence,
        },
      });
    }
  }

  const notScanned = (report.results || []).filter((r) => !r.ok && !r.lintOnly).length;
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'floorcheck',
          version: report.manifest?.version,
          informationUri: INFO_URI,
          rules: [...rules.values()],
        },
      },
      invocations: [{ executionSuccessful: notScanned === 0 }],
      columnKind: 'utf16CodeUnits',
      results: [...results.values()],
    }],
  };
}

function rule(f) {
  const wcag = f.sc ? `WCAG ${f.sc}${f.level ? ` (level ${f.level})` : ''}` : null;
  const text = f.message || f.id;
  return {
    id: f.id,
    name: f.id,
    shortDescription: { text },
    fullDescription: { text: wcag ? `${text}. ${wcag}.` : text },
    help: { text: f.helpUrl ? `${text}. More: ${f.helpUrl}` : text },
    helpUri: f.helpUrl || INFO_URI,
    properties: {
      tags: ['accessibility', ...(f.sc ? [`wcag-${f.sc}`] : [])],
      precision: 'high',
      'problem.severity': LEVEL[bucketOf(f)] === 'error' ? 'error' : 'warning',
    },
  };
}

function messageText(f, url) {
  const parts = [f.message || f.id];
  if (f.selector) parts.push(`Element: ${f.selector}`);
  if (url) parts.push(`Page: ${url}`);
  if (f.detail) parts.push(String(f.detail).split('\n')[0].slice(0, 300));
  return `${parts.map((p) => p.trim().replace(/\.+$/, '')).join('. ')}.`;
}
