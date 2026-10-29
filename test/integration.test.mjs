// Real browser against a local server. Needs Chrome, Edge or Playwright's
// Chromium on the machine, the same as the CLI.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { scan } from '../src/scan.mjs';
import { selfTest } from '../src/self-test.mjs';
import { urlsFromSitemap } from '../src/sitemap.mjs';

const filler = '<p>' + 'Plain paragraph text so the page is not empty. '.repeat(20) + '</p>';
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;

let site;
let other;
let base;
let otherBase;
const seenByOther = [];
const seenBySite = [];

function listen(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  // "other" plays a third-party host: it records which headers reached it.
  other = await listen((req, res) => {
    seenByOther.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end('/* third party */');
  });
  otherBase = `http://127.0.0.1:${other.address().port}`;

  site = await listen((req, res) => {
    const send = (status, html, type = 'text/html') => { res.writeHead(status, { 'content-type': type }); res.end(html); };
    switch (req.url) {
      case '/ok':
        return send(200, page('Shop', `<h1>Shop</h1>${filler}<img src="data:,">`
          + '<div class="chat-widget"><button></button></div>'));
      case '/reflow':
        return send(200, page('Wide', `<a class="skip" href="#m" style="position:absolute;left:-9999px">Skip</a>`
          + `<span style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden">sr only</span>`
          + `<div id="wide" style="width:900px">Too wide</div>${filler}`));
      case '/reflow-pre':
        return send(200, page('Code', `<h1>Code</h1>${filler}<pre>const aVeryLongLineOfCodeThatCannotWrap = someFunction(withArguments, andMoreArguments, andEvenMore);</pre>`));
      case '/reflow-box':
        return send(200, page('Box', `<h1>Box</h1>${filler}<div style="overflow-x:auto"><p style="min-width:600px">This paragraph only fits if you scroll sideways inside the box.</p></div>`));
      case '/forbidden':
        return send(403, page('403 Forbidden', '<h1>Forbidden</h1>'));
      case '/challenge':
        return send(200, page('Just a moment...', '<h1>Checking your browser</h1>'));
      case '/maintenance':
        return send(200, page('Website Under Maintenance', '<h1>We will be back soon</h1>'));
      case '/empty':
        return send(200, '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>');
      case '/private':
        seenBySite.push(req.headers);
        return send(200, page('Account', `<h1>Account</h1>${filler}<script src="${otherBase}/tracker.js"></script>`));
      case '/sitemap.xml':
        return send(200, `<sitemapindex><sitemap><loc>${base}/pages.xml.gz</loc></sitemap></sitemapindex>`, 'application/xml');
      case '/pages.xml.gz':
        res.writeHead(200, { 'content-type': 'application/gzip' });
        return res.end(gzipSync(`<urlset><url><loc>${base}/ok</loc></url><url><loc>https://elsewhere.test/x</loc></url></urlset>`));
      default:
        return send(404, page('Not found', '<h1>Not found</h1>'));
    }
  });
  // localhost and 127.0.0.1 are different host names, so they act as two sites.
  base = `http://localhost:${site.address().port}`;
});

after(() => {
  site?.close();
  other?.close();
});

test('the negative control finds every planted problem', async () => {
  const res = await selfTest();
  assert.equal(res.ok, true, res.problems.join('\n'));
});

test('error, challenge, maintenance and empty pages are not reported as scanned', async () => {
  const urls = ['/forbidden', '/challenge', '/maintenance', '/empty'].map((p) => base + p);
  const report = await scan(urls, { concurrency: 2 });
  for (const r of report.results) {
    assert.equal(r.ok, false, `${r.url} should not count as scanned`);
    assert.equal(r.notScanned, true);
  }
  assert.match(report.results[0].error, /HTTP 403/);
  assert.match(report.results[1].error, /bot protection/);
  assert.match(report.results[2].error, /maintenance/);
  assert.match(report.results[3].error, /almost empty/);
});

test('--allow-error-pages scans them anyway', async () => {
  const report = await scan([`${base}/forbidden`], { allowErrorPages: true });
  assert.equal(report.results[0].ok, true);
  assert.match(report.results[0].target.guardWarning, /HTTP 403/);
});

test('a real page is scanned and --exclude removes a region', async () => {
  const plain = await scan([`${base}/ok`]);
  const ids = plain.results[0].findings.map((f) => f.id);
  assert.ok(ids.includes('image-alt'));
  assert.ok(ids.includes('button-name'));

  const excluded = await scan([`${base}/ok`], { exclude: ['.chat-widget'] });
  const ids2 = excluded.results[0].findings.map((f) => f.id);
  assert.ok(ids2.includes('image-alt'));
  assert.ok(!ids2.includes('button-name'), 'the excluded widget should not be scanned');
});

test('reflow blames the wide element, not off-screen skip links', async () => {
  const report = await scan([`${base}/reflow`]);
  const reflow = report.results[0].findings.filter((f) => f.id === 'reflow-horizontal-overflow');
  assert.ok(reflow.length > 0, 'the page scrolls sideways at 320px');
  assert.ok(reflow.some((f) => /#wide/.test(f.selector)));
  assert.ok(reflow.every((f) => !/skip|span/.test(f.selector || '')), reflow.map((f) => f.selector).join(', '));
});

test('code that needs two dimensions goes to review, not failure', async () => {
  const report = await scan([`${base}/reflow-pre`]);
  const ids = report.results[0].findings.map((f) => f.id);
  assert.ok(ids.includes('reflow-two-dimensional-content'));
  assert.ok(!ids.includes('reflow-horizontal-overflow'));
  const f = report.results[0].findings.find((x) => x.id === 'reflow-two-dimensional-content');
  assert.equal(f.class, 'flag');
});

test('text scrolling sideways inside a box goes to review', async () => {
  const report = await scan([`${base}/reflow-box`]);
  const ids = report.results[0].findings.map((f) => f.id);
  assert.ok(ids.includes('reflow-scroll-container'));
  assert.ok(!ids.includes('reflow-horizontal-overflow'), 'the page itself does not scroll');
});

test('extra headers reach the scanned site only', async () => {
  seenByOther.length = 0;
  seenBySite.length = 0;
  await scan([`${base}/private`], {
    headers: { cookie: 'session=secret; theme=dark', authorization: 'Bearer t0ken' },
    viewports: [{ w: 1280, h: 800 }],
  });
  assert.ok(seenBySite.length > 0);
  for (const h of seenBySite) {
    assert.match(h.cookie || '', /session=secret/);
    assert.match(h.cookie || '', /theme=dark/);
    assert.equal(h.authorization, 'Bearer t0ken');
  }
  assert.ok(seenByOther.length > 0, 'the third-party script should have been requested');
  for (const h of seenByOther) {
    assert.equal(h.cookie, undefined, 'cookies must not leak to another host');
    assert.equal(h.authorization, undefined, 'headers must not leak to another host');
  }
});

test('sitemap index, gzip and same-site filtering', async () => {
  const sm = await urlsFromSitemap(`${base}/sitemap.xml`);
  assert.deepEqual(sm.urls, [`${base}/ok`]);
  assert.equal(sm.skippedOtherOrigin, 1);
});
