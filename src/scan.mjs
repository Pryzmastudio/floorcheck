// The scan itself: one browser, a small pool of pages, every page checked at
// each viewport with axe-core and the extra checks.

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { engineInfo, launchBrowser } from './browser.mjs';
import {
  ADVISORY_TAGS, CONFORMANCE_TAGS, axeCoverage, injectAxe, loadLocale, normalizeAxe, runAxe,
} from './axe.mjs';
import { runExtraChecks } from './checks.mjs';
import { classifyPage, collectPageFacts } from './page-guard.mjs';

export const DEFAULT_VIEWPORTS = {
  quick: [{ w: 1280, h: 800 }, { w: 320, h: 512 }],
  full: [{ w: 1280, h: 800 }, { w: 390, h: 844 }, { w: 320, h: 512 }],
};

export const DEFAULTS = {
  mode: 'quick',
  viewports: null,
  concurrency: 2,
  timeout: 45000,
  wait: 400,
  waitFor: null,
  headers: {},
  exclude: [],
  locale: 'en',
  allowErrorPages: false,
  extraChecks: true,
  advisory: false,
  outDir: null,
  project: null,
  headless: true,
  failOn: 'minor',
  onPage: null,
};

const vpLabel = (v) => `${v.w}x${v.h}`;
const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export async function packageVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

/** The same defect seen at several viewports becomes one finding. */
export function dedupe(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = [f.source, f.id, f.bucket, f.selector, f.htmlSnippet].join('\u0000');
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.viewports.includes(f.viewport)) seen.viewports.push(f.viewport);
    } else {
      byKey.set(key, { ...f, viewports: [f.viewport] });
    }
  }
  return [...byKey.values()].map(({ viewport, ...rest }) => rest);
}

async function newContext(browser, vp, url, opts, engine) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    reducedMotion: 'no-preference',
  });
  await injectAxe(context, engine.axePath);
  // Extra headers (cookies, tokens) go only to the scanned site, never to the
  // analytics and font hosts the page also loads.
  const { cookie, ...headers } = opts.headers;
  if (cookie && /^https?:/i.test(url)) {
    // Chromium manages Cookie itself and ignores it in request overrides, so
    // cookies go into the browser's jar, bound to the scanned host.
    const cookies = cookie.split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
      const i = c.indexOf('=');
      return { name: c.slice(0, i).trim(), value: c.slice(i + 1).trim(), url };
    }).filter((c) => c.name);
    if (cookies.length) await context.addCookies(cookies);
  }
  if (Object.keys(headers).length) {
    const site = siteOf(url);
    await context.route('**/*', (route) => {
      const req = route.request();
      if (siteOf(req.url()) === site) return route.continue({ headers: { ...req.headers(), ...headers } });
      return route.continue();
    });
  }
  return context;
}

async function scanOnePage(browser, url, index, opts, engine) {
  const viewports = opts.viewports || DEFAULT_VIEWPORTS[opts.mode];
  const findings = [];
  const target = { requestedUrl: url };
  const screenshots = [];
  let advisoryTotal = 0;

  for (const [i, vp] of viewports.entries()) {
    const isPrimary = i === 0;
    const context = await newContext(browser, vp, url, opts, engine);
    try {
      const page = await context.newPage();
      let resp;
      try {
        resp = await page.goto(url, { waitUntil: 'load', timeout: opts.timeout });
        // Best effort: pages with long-polling never go network-idle.
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: opts.timeout });
        if (opts.wait) await page.waitForTimeout(opts.wait);
      } catch (err) {
        return { ok: false, url, error: `could not load: ${String(err.message).split('\n')[0]}` };
      }

      if (isPrimary) {
        const facts = await collectPageFacts(page);
        Object.assign(target, {
          finalUrl: page.url(),
          httpStatus: resp?.status() ?? null,
          htmlLang: await page.evaluate(() => document.documentElement.getAttribute('lang')),
          title: facts.title,
        });
        if (siteOf(target.finalUrl) !== siteOf(url)) target.redirectedToOtherSite = true;
        const reason = classifyPage({ status: target.httpStatus, ...facts });
        if (reason && !opts.allowErrorPages) {
          return { ok: false, notScanned: true, url, error: reason, target };
        }
        if (reason) target.guardWarning = reason;
      }

      const localeName = opts.locale === 'auto'
        ? ((target.htmlLang || 'en').toLowerCase())
        : opts.locale;
      const locale = await loadLocale(engine.axeLocaleDir, localeName);

      const conformance = await runAxe(page, { tags: CONFORMANCE_TAGS, locale, exclude: opts.exclude });
      findings.push(...normalizeAxe(conformance, { viewport: vpLabel(vp), url, bucket: 'violation' }));
      findings.push(...normalizeAxe(conformance, { viewport: vpLabel(vp), url, bucket: 'incomplete' }));

      if (isPrimary) {
        const advisory = await runAxe(page, { tags: ADVISORY_TAGS, locale, exclude: opts.exclude });
        const adv = normalizeAxe(advisory, { viewport: vpLabel(vp), url, bucket: 'violation' })
          .map((f) => ({ ...f, class: 'advisory', bucket: 'advisory', severity: null }));
        advisoryTotal = adv.length;
        if (opts.advisory || opts.mode === 'full') findings.push(...adv);
      }

      if (opts.extraChecks) {
        findings.push(...await runExtraChecks(page, { viewport: vp, url, mode: opts.mode, isPrimary, exclude: opts.exclude }));
      }

      if (opts.mode === 'full' && opts.outDir) {
        const dir = path.join(opts.outDir, 'screenshots');
        await mkdir(dir, { recursive: true });
        const name = `${String(index + 1).padStart(3, '0')}-${siteOf(url) || 'local'}-${vpLabel(vp)}.png`;
        const ok = await page.screenshot({ path: path.join(dir, name), fullPage: true }).then(() => true, () => false);
        if (ok) screenshots.push(`screenshots/${name}`);
      }
    } finally {
      await context.close();
    }
  }

  return { ok: true, url, target, screenshots, advisoryTotal, findings: dedupe(findings) };
}

/**
 * Scan a list of URLs.
 * @param {string[]} urls
 * @param {Partial<typeof DEFAULTS>} options
 * @returns {Promise<{manifest: object, results: object[]}>}
 */
export async function scan(urls, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!['quick', 'full'].includes(opts.mode)) throw new Error(`mode must be quick or full, got "${opts.mode}"`);
  const engine = engineInfo();
  const viewports = opts.viewports || DEFAULT_VIEWPORTS[opts.mode];
  const { browser, tier, version } = await launchBrowser(engine.chromium, { headless: opts.headless });

  const manifest = {
    tool: 'floorcheck',
    version: await packageVersion(),
    engine: {
      axeCore: engine.versions['axe-core'],
      playwrightCore: engine.versions['playwright-core'],
      axeCoverage: axeCoverage(),
    },
    browser: { tier, version, headless: opts.headless },
    run: {
      startedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      mode: opts.mode,
      viewports: viewports.map(vpLabel),
      conformanceTags: CONFORMANCE_TAGS,
      advisoryTags: ADVISORY_TAGS,
      locale: opts.locale,
      exclude: opts.exclude,
      extraChecks: opts.extraChecks,
      failOn: opts.failOn,
    },
  };

  const results = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      let r;
      try {
        r = await scanOnePage(browser, urls[i], i, opts, engine);
      } catch (err) {
        r = { ok: false, url: urls[i], error: String(err.message).split('\n')[0] };
      }
      results[i] = r;
      if (opts.onPage) opts.onPage(r, i, urls.length);
    }
  }

  try {
    const n = Math.max(1, Math.min(opts.concurrency, urls.length));
    await Promise.all(Array.from({ length: n }, worker));
  } finally {
    await browser.close();
  }

  if (opts.project) {
    const { lintProject, mapFindingsToSource } = await import('./source-map.mjs');
    const all = results.filter((r) => r.ok).flatMap((r) => r.findings);
    const mapStatus = (await mapFindingsToSource(all, opts.project)).status;
    const lint = await lintProject(opts.project);
    manifest.run.project = opts.project;
    manifest.run.sourceMapping = mapStatus;
    manifest.run.lint = lint.status;
    if (lint.findings?.length) {
      results.push({ ok: true, url: `project:${opts.project}`, lintOnly: true, findings: lint.findings, lintConfigHint: lint.configHint });
    }
  }

  return { manifest, results };
}
