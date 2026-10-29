// Refuses to treat a page as scanned when the browser did not get the real
// page: an HTTP error, a bot challenge, a maintenance notice or an empty shell.
// All of these tend to produce zero findings, and zero findings on a 403 page
// is not a clean site.

const CHALLENGE = [
  /just a moment/i,
  /attention required/i,
  /checking (if the site connection is secure|your browser)/i,
  /verify(ing)? (that )?you are (a )?human/i,
  /ddos protection by/i,
  /access denied/i,
  /request (unsuccessful|rejected|blocked)/i,
  /the url you requested has been blocked/i,
  /^(403|401|429|5\d\d)\b/,
  /\bforbidden\b/i,
];

// Phrases only. A bare "maintenance" would also catch "Lawn Maintenance Ltd".
const MAINTENANCE = [
  /\b(site|website|page|currently|temporarily|down for|under|scheduled) maintenance\b/i,
  /maintenance mode/i,
  /under construction/i,
  /coming soon/i,
  /be right back/i,
  /przerwa techniczna/i,
  /komunikat techniczny/i,
  /strona w budowie/i,
  /en mantenimiento/i,
  /en maintenance/i,
  /wartungsarbeiten/i,
];

// Markup that only a full-page challenge has.
const CHALLENGE_MARKUP = ['#challenge-form', '#cf-challenge-running'];
// CAPTCHA widgets. Ordinary pages carry them too (reCAPTCHA in a contact form,
// Turnstile on a newsletter signup), so they only count on a page with little else.
const CAPTCHA_WIDGETS = ['.cf-turnstile', '#px-captcha', 'iframe[src*="captcha"]'];

/** Collects what classifyPage needs. Runs in the page. */
export async function collectPageFacts(page) {
  return page.evaluate(({ challenge, widgets }) => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const h1 = document.querySelector('h1');
    const has = (selectors) => selectors.some((s) => {
      try { return !!document.querySelector(s); } catch { return false; }
    });
    return {
      title: document.title || '',
      h1: h1 ? h1.innerText.trim().slice(0, 200) : '',
      textLength: text.length,
      linkCount: document.links.length,
      challengeMarkup: has(challenge),
      captchaWidget: has(widgets),
    };
  }, { challenge: CHALLENGE_MARKUP, widgets: CAPTCHA_WIDGETS });
}

/**
 * Decide whether a loaded page is the real page.
 * Returns null when it is, or a short human reason when it is not.
 */
export function classifyPage({
  status, title = '', h1 = '', textLength = 0, linkCount = 0, challengeMarkup = false, captchaWidget = false,
}) {
  if (typeof status === 'number' && status >= 400) {
    return `HTTP ${status}: the server returned an error page, not the page itself`;
  }
  const heading = `${title} ${h1}`.trim();
  const thinPage = textLength < 1500 && linkCount < 10;
  if (challengeMarkup || (captchaWidget && thinPage) || CHALLENGE.some((re) => re.test(title) || re.test(h1))) {
    return `bot protection or access block ("${heading.slice(0, 60)}")`;
  }
  // A real page can mention maintenance in passing, so the notice has to be in
  // the title or main heading, on a page with little else on it.
  if (MAINTENANCE.some((re) => re.test(title) || re.test(h1)) && textLength < 1500) {
    return `maintenance or placeholder page ("${heading.slice(0, 60)}")`;
  }
  if (textLength < 40 && linkCount < 3) {
    return 'page is almost empty: the content may be rendered later by JavaScript (try --wait-for) or blocked';
  }
  return null;
}
