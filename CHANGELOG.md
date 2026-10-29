# Changelog

## 1.2.1

- A reCAPTCHA, Turnstile or similar widget no longer marks an ordinary page as a bot challenge. These widgets often sit in contact and signup forms, so they now count only on a page with little text and almost no links. Full-page challenge markup still counts on its own

## 1.2.0

- Reflow: overflow caused only by code, tables, canvas or drawings now goes to needs-review (WCAG 1.4.10 allows two-dimensional scrolling when the layout is essential) instead of failing
- Reflow: text that scrolls sideways inside its own box is reported for review
- Reflow: when no element sticks out, the innermost element with a line that spills out is named (a long line in `<pre>`, a long URL)

## 1.1.0

- `npm run act-report`: runs the W3C ACT Rules test cases and writes an EARL report (`act/floorcheck-earl.json`)
- Focus check skips elements taken out of the Tab order with a negative tabindex

## 1.0.1

- Fix the author field in the npm metadata
- Install instructions use the npm package

## 1.0.0

First public release.

- WCAG 2.2 A/AA scan with axe-core 4.14.0 at 1280px and 320px (390px too in full mode)
- Three separate sections: WCAG A/AA failures, needs review, advisory
- Extra checks axe-core does not have: reflow at 320px, focus visible, positive tabindex, looping motion
- Overlay and accessibility toolbar detection
- Error, bot-challenge, maintenance and empty pages are reported as not scanned (exit code 2)
- Sitemap and URL-file input, parallel pages, `--wait-for`, `--exclude`
- `--header` with cookies and auth headers sent only to the scanned site
- `--fail-on` threshold for CI
- `--project` maps findings to likely source lines and runs jsx-a11y with the project's ESLint
- `--self-test` against a page with planted problems
- Markdown and JSON reports, Node API
