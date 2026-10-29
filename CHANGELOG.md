# Changelog

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
