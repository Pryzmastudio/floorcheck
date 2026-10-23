# floorcheck

A WCAG 2.2 accessibility scanner for the command line, built on [axe-core](https://github.com/dequelabs/axe-core) and Playwright.

The name comes from the rule it's built around: an automated scan is the floor, not the audit. floorcheck tries to be honest about that. It keeps real failures, things a person has to check, and general advice in separate piles. It adds the checks axe doesn't have, like sideways scrolling at 320px. And it won't tell you a page is clean when it never actually saw the page.

```
$ npx github:Pryzmastudio/floorcheck https://www.w3.org/WAI/demos/bad/before/home.html https://www.w3.org/WAI/demos/bad/after/home.html

scanning 2 pages (quick mode)
  x  https://www.w3.org/WAI/demos/bad/after/home.html
     7 failures: target-size, reflow-horizontal-overflow | 25 to review
  x  https://www.w3.org/WAI/demos/bad/before/home.html
     52 failures: color-contrast, html-has-lang, image-alt, link-name, select-name, target-size, ... | 7 to review

59 WCAG A/AA failures | 32 to review | 64 advisory | 2 pages scanned
report: floorcheck-report/findings.md
```

(Those are the W3C's own before-and-after demo pages. The "after" page was made before WCAG 2.1 and 2.2, so it fails the newer target size and reflow criteria.)

## Why another scanner

I build and fix websites, and I kept running into the same problems with automated scans.

**A 403 page has no accessibility errors.** Neither does a Cloudflare "Just a moment..." page, a maintenance notice or an empty JavaScript shell. Most scanners will happily report all of these as clean. I learned this the hard way when my first count of "clean" homepages in a batch scan turned out to include error pages and bot checks. floorcheck looks at what actually loaded, and if it's not the real page it says so and exits with code 2. A page it didn't scan is never a pass.

**Not everything axe returns is a failure.** axe has `violations`, `incomplete` (it couldn't decide) and best-practice rules that aren't WCAG requirements. Mixing them makes a report either scary or useless. floorcheck keeps three sections that never merge: WCAG A/AA failures, needs review, and advisory. Only the first one can fail your build.

**axe doesn't check some things that break real sites.** floorcheck adds:

| Check | WCAG | Result |
|---|---|---|
| Page scrolls sideways at 320px, with the element that causes it | 1.4.10 Reflow (AA) | failure |
| Focusable element with no visible change on focus (`--mode full`) | 2.4.7 Focus Visible (AA) | needs review |
| Positive `tabindex` changing the focus order (`--mode full`) | 2.4.3 Focus Order (A) | needs review |
| Animation that loops forever with no `prefers-reduced-motion` rule | 2.2.2 Pause, Stop, Hide (A) | needs review |
| Accessibility overlay or toolbar installed (UserWay, accessiBe, One Click Accessibility and others) | none | context |

The overlay note matters because an overlay rewrites the page while the scan runs, so you are looking at results for the page with the overlay switched on.

**It works where other setups quietly don't.** axe is injected so that a strict Content-Security-Policy can't block it. Cookies and auth headers you pass are sent only to the site you're scanning, never to the analytics and font hosts the page loads. Every run records the exact axe-core and browser versions, so two scans can be compared.

## Install

You need Node.js 20 or newer and Google Chrome or Microsoft Edge. No browser download unless you want one.

Run it without installing:

```sh
npx github:Pryzmastudio/floorcheck https://example.com
```

Or add it to a project:

```sh
npm install --save-dev github:Pryzmastudio/floorcheck
npx floorcheck https://example.com
```

No Chrome or Edge on the machine? Download Playwright's Chromium once with `npx playwright-core install chromium`, or point `FLOORCHECK_CHROME` at any Chromium-based browser.

To confirm everything works on your machine:

```sh
npx floorcheck --self-test
```

This scans a test page where every problem is planted on purpose and checks that each one is found in the right section. If axe ever silently stops running, this is how you find out.

## Examples

Scan a whole site from its sitemap, four pages at a time:

```sh
floorcheck --sitemap https://example.com/sitemap.xml --max-pages 100 --concurrency 4
```

Scan pages behind a login. Cookies and headers go only to the scanned site:

```sh
floorcheck https://app.example.com/account --header "Cookie: session=abc123"
```

Leave out a third-party widget you can't fix:

```sh
floorcheck https://example.com --exclude "#chat-widget" --exclude ".cookie-banner"
```

Single-page app that renders after load:

```sh
floorcheck https://example.com --wait-for "main h1"
```

Deeper pass with focus checks, a 390px viewport, the advisory list and full-page screenshots:

```sh
floorcheck https://example.com --mode full
```

Point each finding at a likely file and line in your code (works with React, Vue, Svelte, Astro, PHP and plain HTML projects):

```sh
floorcheck http://localhost:3000 --project .
```

If the project has ESLint and `eslint-plugin-jsx-a11y` installed, floorcheck also runs the full jsx-a11y recommended set with your own ESLint. Nothing is installed or changed.

## Use it in CI

Exit codes are built for pipelines:

| Code | Meaning |
|---|---|
| 0 | every page scanned, no failures at or above `--fail-on` |
| 1 | failures found |
| 2 | bad options, no browser, or at least one page couldn't be scanned |

`--fail-on serious` lets minor and moderate failures through while you work on the rest. Needs-review items never fail a run.

GitHub Actions, scanning a preview URL:

```yaml
name: Accessibility
on: [pull_request]

jobs:
  floorcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Scan
        run: npx -y github:Pryzmastudio/floorcheck https://staging.example.com --fail-on serious
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: floorcheck-report
          path: floorcheck-report/
```

GitHub's Ubuntu runners already have Chrome, so there's nothing else to install.

## Output

Each run writes two files to `./floorcheck-report/` (change it with `--out`, skip it with `--no-report`):

- `findings.md` is for people. One entry per rule rather than per element, so a hundred contrast failures don't bury everything else. Each entry has the WCAG criterion, the EN 301 549 clause where there is one, the viewports it showed up at, and up to ten example elements.
- `findings.json` is the full record: every element, its selector, XPath and HTML, plus the run manifest with versions and settings.

The folder gets its own `.gitignore`, so reports don't end up in your commits by accident.

`--json` prints the full report to stdout as well.

## Options

```
Pages
  --sitemap URL          read page URLs from a sitemap or sitemap index
  --urls-file FILE       read page URLs from a file, one per line
  --max-pages N          limit for --sitemap and --urls-file (default 50)
  --all-origins          with --sitemap, keep URLs on other sites too

Scan
  --mode quick|full      quick: 1280px and 320px, failures only (default)
                         full: adds 390px, focus checks, advisory list, screenshots
  --viewports WxH,...    custom viewports, e.g. 1440x900,375x667
  --concurrency N        pages scanned at the same time (default 2)
  --timeout MS           page load timeout (default 45000)
  --wait MS              extra wait after load (default 400)
  --wait-for SELECTOR    wait until this element exists
  --header "Name: v"     add a request header, repeatable, sent only to the scanned site
  --exclude SELECTOR     leave a region out, repeatable
  --locale CODE          language of the axe messages: en (default), pl, de, fr, es, ...
                         or auto to follow the page's own language
  --allow-error-pages    scan pages that look like errors, bot checks or maintenance
  --no-extra-checks      axe-core only

Output
  --out DIR              report folder (default ./floorcheck-report)
  --no-report            do not write report files
  --json                 print the full JSON report to stdout
  --advisory             list best-practice and AAA findings as well
  --fail-on LEVEL        critical, serious, moderate, minor (default) or none
  --project DIR          map findings to source files and run jsx-a11y

Other
  --self-test            confirm every check works on this machine
  --headed               show the browser window
```

## Node API

```js
import { scan, summarize } from 'floorcheck';

const report = await scan(['https://example.com'], { mode: 'quick', concurrency: 2 });
const s = summarize(report);
console.log(s.conformance, 'failures,', s.review, 'to review,', s.notScanned, 'not scanned');
```

`scan` takes the same options as the CLI in camelCase (`waitFor`, `allowErrorPages`, `failOn` and so on), plus an `onPage(result, index, total)` callback for progress.

## What it can't do

No automated tool can tell you a site is accessible. axe-core 4.14 has rules for 23 of the 55 WCAG 2.2 A/AA success criteria, and even inside those it can't judge whether alt text is any good, whether headings make sense, or whether a form can be finished with a keyboard. A page with zero failures here still needs someone to go through it with a keyboard and a screen reader. The W3C's [Easy Checks](https://www.w3.org/WAI/test-evaluate/easy-checks/) are a good place to start.

floorcheck also only sees the page as it is when it loads. Menus, modals and multi-step forms need to be opened and tested by hand or with your own Playwright scripts.

## How it compares

- **axe-core CLI / axe DevTools**: same engine. floorcheck adds the buckets, the extra checks, the error-page guard, sitemap input and the reports.
- **pa11y**: runs axe or HTML_CodeSniffer, and is lighter and well established. Neither engine checks reflow.
- **Lighthouse**: a subset of axe rules inside a broader performance audit. Great for a score, not built for a fix list.

Use whichever fits. They all sit on the same floor.

## License

MIT. axe-core is © Deque Systems and licensed under MPL-2.0; it's installed as a dependency, not copied into this repository.

Made by [Vayle](https://vayle.art), a one-person web studio. Issues and pull requests are welcome.
