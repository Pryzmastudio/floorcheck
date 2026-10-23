import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTags } from '../src/axe.mjs';
import { classifyPage } from '../src/page-guard.mjs';
import { bucketOf, failsAt, summarize } from '../src/report.mjs';
import { dedupe } from '../src/scan.mjs';
import { parseSitemap } from '../src/sitemap.mjs';

test('parseTags reads criterion, level and EN clause from axe tags', () => {
  const t = parseTags(['cat.color', 'wcag2aa', 'wcag143', 'EN-301-549', 'EN-9.1.4.3']);
  assert.equal(t.sc, '1.4.3');
  assert.equal(t.level, 'AA');
  assert.equal(t.wcagVersion, '2.0');
  assert.deepEqual(t.enClauses, ['EN-9.1.4.3']);
});

test('parseTags keeps the earliest WCAG version', () => {
  const t = parseTags(['wcag22aa', 'wcag21aa', 'wcag258']);
  assert.equal(t.sc, '2.5.8');
  assert.equal(t.wcagVersion, '2.1');
});

test('bucketOf keeps the three buckets apart', () => {
  assert.equal(bucketOf({ class: 'report', bucket: 'violation' }), 'conformance');
  assert.equal(bucketOf({ class: 'flag', bucket: 'incomplete' }), 'review');
  assert.equal(bucketOf({ class: 'flag', bucket: 'violation' }), 'review');
  assert.equal(bucketOf({ class: 'advisory', bucket: 'advisory' }), 'advisory');
  assert.equal(bucketOf({ class: 'report', contextOnly: true }), 'context');
});

test('failsAt respects --fail-on', () => {
  const serious = { class: 'report', bucket: 'violation', impact: 'serious' };
  const minor = { class: 'report', bucket: 'violation', impact: 'minor' };
  const review = { class: 'flag', bucket: 'incomplete', impact: 'critical' };
  assert.equal(failsAt(serious, 'minor'), true);
  assert.equal(failsAt(serious, 'serious'), true);
  assert.equal(failsAt(serious, 'critical'), false);
  assert.equal(failsAt(minor, 'moderate'), false);
  assert.equal(failsAt(review, 'minor'), false, 'needs-review never fails a run');
  assert.equal(failsAt(serious, 'none'), false);
});

test('summarize never counts a page that was not scanned as clean', () => {
  const report = { results: [
    { ok: true, findings: [], advisoryTotal: 0 },
    { ok: false, notScanned: true, url: 'x', error: 'HTTP 403' },
  ] };
  const s = summarize(report);
  assert.equal(s.scanned, 1);
  assert.equal(s.notScanned, 1);
  assert.match(s.human, /1 NOT scanned/);
});

test('classifyPage rejects error, challenge, maintenance and empty pages', () => {
  const real = { status: 200, title: 'Home', h1: 'Welcome', textLength: 3000, linkCount: 40 };
  assert.equal(classifyPage(real), null);
  assert.match(classifyPage({ ...real, status: 403 }), /HTTP 403/);
  assert.match(classifyPage({ ...real, status: 503 }), /HTTP 503/);
  assert.match(classifyPage({ ...real, title: 'Just a moment...' }), /bot protection/);
  assert.match(classifyPage({ ...real, challengeMarkup: true }), /bot protection/);
  assert.match(classifyPage({ ...real, title: 'Website Under Maintenance', textLength: 300 }), /maintenance/);
  assert.match(classifyPage({ ...real, h1: 'Komunikat techniczny', textLength: 400 }), /maintenance/);
  assert.match(classifyPage({ ...real, textLength: 0, linkCount: 0 }), /almost empty/);
});

test('classifyPage does not reject real businesses with "maintenance" in the name', () => {
  assert.equal(classifyPage({ status: 200, title: 'Green Lawn Maintenance Ltd', h1: 'Lawn care in Leeds', textLength: 900, linkCount: 12 }), null);
  assert.equal(classifyPage({ status: 200, title: 'Scheduled maintenance plans', h1: 'Our plans', textLength: 5000, linkCount: 60 }), null);
});

test('classifyPage leaves file:// pages alone (no HTTP status)', () => {
  assert.equal(classifyPage({ status: null, title: 'Fixture', h1: 'Test', textLength: 500, linkCount: 2 }), null);
});

test('parseSitemap reads urlsets, indexes, CDATA and entities', () => {
  const urlset = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://a.test/</loc></url>
    <url><loc><![CDATA[https://a.test/b?x=1&y=2]]></loc></url>
    <url><loc>https://a.test/c?x=1&amp;y=2</loc></url></urlset>`);
  assert.equal(urlset.kind, 'urlset');
  assert.deepEqual(urlset.locs, ['https://a.test/', 'https://a.test/b?x=1&y=2', 'https://a.test/c?x=1&y=2']);
  const index = parseSitemap('<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(index.kind, 'index');
  assert.deepEqual(index.locs, ['https://a.test/s1.xml']);
});

test('dedupe merges the same element seen at two viewports', () => {
  const f = { source: 'axe', id: 'image-alt', bucket: 'violation', selector: 'img', htmlSnippet: '<img>' };
  const out = dedupe([{ ...f, viewport: '1280x800' }, { ...f, viewport: '320x512' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].viewports, ['1280x800', '320x512']);
  assert.equal('viewport' in out[0], false);
});
