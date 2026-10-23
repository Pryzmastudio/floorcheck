// Browser launch. Tries the installed Google Chrome first so a normal machine
// needs no extra download, then Edge, then Playwright's own Chromium, then an
// explicit binary from FLOORCHECK_CHROME. The tier that won goes into the
// report manifest: a result has to say which browser produced it.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class BootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export function engineInfo() {
  const chromium = require('playwright-core').chromium;
  const axePath = require.resolve('axe-core/axe.min.js');
  const axeDir = require.resolve('axe-core/package.json').replace(/package\.json$/, '');
  return {
    chromium,
    axePath,
    axeLocaleDir: `${axeDir}locales`,
    versions: {
      'axe-core': require('axe-core/package.json').version,
      'playwright-core': require('playwright-core/package.json').version,
    },
  };
}

export async function launchBrowser(chromium, { headless = true } = {}) {
  const tiers = [];
  if (process.env.FLOORCHECK_CHROME) {
    tiers.push({ label: 'env-override', opts: { executablePath: process.env.FLOORCHECK_CHROME, headless } });
  }
  tiers.push(
    { label: 'system-chrome', opts: { channel: 'chrome', headless } },
    { label: 'system-edge', opts: { channel: 'msedge', headless } },
    { label: 'playwright-chromium', opts: { headless } },
  );

  const failures = [];
  for (const tier of tiers) {
    try {
      const browser = await chromium.launch(tier.opts);
      return { browser, tier: tier.label, version: browser.version() };
    } catch (err) {
      failures.push(`  ${tier.label}: ${String(err.message).split('\n')[0]}`);
    }
  }

  throw new BootstrapError([
    'floorcheck: could not start a browser. Tried:',
    ...failures,
    '',
    'Fix one of these:',
    '  - install Google Chrome or Microsoft Edge',
    '  - or download Playwright\'s Chromium: npx playwright-core install chromium',
    '  - or point FLOORCHECK_CHROME at a Chromium-based browser binary',
  ].join('\n'));
}
