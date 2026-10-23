// Node side of the in-page checks in injected-checks.js. Normalizes their
// output into the same finding shape axe findings use.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SEVERITY_FROM_IMPACT } from './axe.mjs';

let assets = null;

async function loadAssets() {
  if (!assets) {
    const [source, signatures] = await Promise.all([
      readFile(fileURLToPath(new URL('./injected-checks.js', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('./overlay-signatures.json', import.meta.url)), 'utf8'),
    ]);
    assets = { source, vendors: JSON.parse(signatures).vendors || [] };
  }
  return assets;
}

function errorFinding(id, message, detail, viewport, url) {
  return {
    id, source: 'extra', bucket: 'violation', class: 'flag',
    sc: null, level: null, wcagVersion: null, enClauses: [],
    impact: 'minor', severity: null,
    selector: null, ancestry: null, xpath: null, htmlSnippet: null,
    viewport, url, message, detail, helpUrl: null, sourceLocation: null,
  };
}

/**
 * Evaluate the checks in the current page. page.evaluate goes through the
 * DevTools protocol, so a strict Content-Security-Policy does not block it.
 */
export async function runExtraChecks(page, { viewport, url, mode, isPrimary, exclude = [] }) {
  const { source, vendors } = await loadAssets();
  const vp = `${viewport.w}x${viewport.h}`;

  let result;
  try {
    await page.evaluate(source);
    result = await page.evaluate((opts) => window.__floorcheck.run(opts), {
      viewportWidth: viewport.w,
      isPrimary,
      includeFlags: mode === 'full',
      focusLimit: mode === 'full' ? 60 : 25,
      overlayVendors: vendors,
      exclude,
    });
  } catch (err) {
    return [errorFinding('extra-checks-failed', 'The non-axe checks could not run on this page.',
      `${String(err.message).split('\n')[0]}. axe results are not affected.`, vp, url)];
  }

  const findings = [];
  for (const check of result.checks || []) {
    const nodes = check.nodes?.length ? check.nodes : [{ selector: null, html: null, note: null }];
    for (const node of nodes) {
      findings.push({
        id: check.id,
        source: 'extra',
        bucket: 'violation',
        sc: check.sc ?? null,
        level: check.level ?? null,
        wcagVersion: check.wcagVersion ?? null,
        enClauses: [],
        class: check.cls,
        contextOnly: check.contextOnly === true,
        impact: check.impact ?? null,
        severity: check.cls === 'report' && !check.contextOnly ? (SEVERITY_FROM_IMPACT[check.impact] || 'P3') : null,
        selector: node.selector ?? null,
        ancestry: null,
        xpath: null,
        htmlSnippet: node.html ?? null,
        viewport: vp,
        url,
        message: check.message,
        detail: [check.detail, node.note].filter(Boolean).join(' | '),
        helpUrl: check.helpUrl ?? null,
        sourceLocation: null,
      });
    }
  }
  for (const e of result.errors || []) {
    findings.push(errorFinding('extra-check-error', 'One of the non-axe checks failed.', e, vp, url));
  }
  return findings;
}
