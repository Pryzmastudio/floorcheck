// Page discovery from a sitemap. Follows sitemap indexes, reads gzipped
// sitemaps, and keeps URLs on the sitemap's own site unless told otherwise.

import { gunzipSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (compatible; floorcheck; +https://github.com/Pryzmastudio/floorcheck)';

/** Pull <loc> values out of sitemap XML. Returns { kind, locs }. */
export function parseSitemap(xml) {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const locs = [];
  for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
    locs.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return { kind, locs };
}

async function fetchText(url, timeout) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  return (gz ? gunzipSync(buf) : buf).toString('utf8');
}

/**
 * Collect page URLs from a sitemap or sitemap index.
 * @returns {Promise<{urls: string[], skippedOtherOrigin: number, truncated: boolean}>}
 */
export async function urlsFromSitemap(sitemapUrl, { maxPages = 50, sameOrigin = true, timeout = 30000 } = {}) {
  // www and non-www, http and https count as the same site.
  const site = (u) => u.hostname.replace(/^www\./, '');
  const home = site(new URL(sitemapUrl));
  const seen = new Set();
  const urls = [];
  let skippedOtherOrigin = 0;
  let truncated = false;
  const queue = [{ url: sitemapUrl, depth: 0 }];

  while (queue.length && urls.length < maxPages) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let xml;
    try {
      xml = await fetchText(url, timeout);
    } catch (err) {
      if (depth === 0) throw new Error(`could not read sitemap ${url}: ${err.message}`);
      continue;
    }
    const { kind, locs } = parseSitemap(xml);
    if (kind === 'index') {
      if (depth < 3) for (const loc of locs) queue.push({ url: loc, depth: depth + 1 });
      continue;
    }
    for (const loc of locs) {
      let u;
      try { u = new URL(loc); } catch { continue; }
      if (sameOrigin && site(u) !== home) { skippedOtherOrigin++; continue; }
      if (urls.includes(u.href)) continue;
      if (urls.length >= maxPages) { truncated = true; break; }
      urls.push(u.href);
    }
  }
  if (queue.length) truncated = true;
  return { urls, skippedOtherOrigin, truncated };
}
