// --project: point each finding at a likely file:line in your source, and run
// jsx-a11y with your project's own ESLint if it has one.
//
// This is a text search for strings from the failing element (aria-label, alt,
// visible text, id), not a second linter. When a string appears in several
// files it gives up to three candidates instead of one confident wrong answer.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_EXT = new Set(['.tsx', '.jsx', '.astro', '.vue', '.svelte', '.html', '.htm', '.php', '.liquid', '.erb', '.ts', '.js']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', 'coverage', '.vercel', '.turbo', 'vendor', '.cache']);
const MAX_FILES = 4000;

// Lower tier wins. Markup-bearing files first, then plain script/data files:
// a string found in a component is actionable, the same string in a translation
// dictionary usually is not.
const TIER = { '.tsx': 0, '.jsx': 0, '.vue': 0, '.svelte': 0, '.astro': 0, '.html': 1, '.htm': 1, '.liquid': 1, '.erb': 1, '.php': 1, '.ts': 2, '.js': 2 };
const fileTier = (f) => TIER[path.extname(f)] ?? 3;

async function walk(dir, acc = []) {
  if (acc.length >= MAX_FILES) return acc;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Hidden folders hold tooling, caches and copies of the project, not
      // the source that rendered the page.
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await walk(full, acc);
    } else if (SOURCE_EXT.has(path.extname(e.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Extract search tokens from a finding's HTML, strongest first.
 *
 * Weighting matters: in a Tailwind codebase class names are near-useless as
 * signals (`flex items-center` appears everywhere), while visible text and
 * aria-label are close to unique.
 */
function tokensFor(finding) {
  const html = finding.htmlSnippet || '';
  const tokens = [];
  const push = (value, weight, kind) => {
    const v = String(value || '').trim();
    if (v.length >= 4 && v.length <= 120) tokens.push({ value: v, weight, kind });
  };

  const aria = /aria-label=["']([^"']{4,120})["']/i.exec(html);
  if (aria) push(aria[1], 100, 'aria-label');

  const alt = /\balt=["']([^"']{4,120})["']/i.exec(html);
  if (alt) push(alt[1], 90, 'alt');

  // visible text content of the snippet
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text) push(text.slice(0, 60), 85, 'text');

  const id = /\bid=["']([^"']{4,60})["']/i.exec(html);
  if (id) push(id[1], 75, 'id');

  for (const m of html.matchAll(/\b(data-[a-z0-9-]+)=["']([^"']{2,60})["']/gi)) push(m[2], 65, m[1]);

  const href = /\bhref=["']([^"'#][^"']{3,80})["']/i.exec(html);
  if (href) push(href[1], 60, 'href');

  const src = /\bsrc=["']([^"']{4,120})["']/i.exec(html);
  if (src) push(path.basename(src[1].split('?')[0]), 55, 'src');

  const cls = /\bclass(?:Name)?=["']([^"']{4,200})["']/i.exec(html);
  if (cls) {
    for (const c of cls[1].split(/\s+/).filter((x) => x.length >= 6 && !/^(flex|grid|text-|bg-|p-|m-|w-|h-|border)/.test(x)).slice(0, 3)) {
      push(c, 30, 'class');
    }
  }

  return tokens.sort((a, b) => b.weight - a.weight).slice(0, 6);
}

/**
 * Attribute findings to source locations in one pass over the project.
 * Mutates findings, setting `sourceLocation` to either a single high-confidence
 * hit or up to 3 candidates - never one confidently wrong answer.
 */
export async function mapFindingsToSource(findings, projectDir) {
  const root = path.resolve(projectDir);
  if (!existsSync(root)) return { status: `project dir not found: ${root}` };

  const targets = findings.filter((f) => f.htmlSnippet && !f.sourceLocation);
  if (!targets.length) return { status: 'nothing to map' };

  const tokenMap = new Map();   // token value -> {weight, kind}
  const perFinding = new Map(); // finding -> tokens
  for (const f of targets) {
    const toks = tokensFor(f);
    perFinding.set(f, toks);
    for (const t of toks) {
      const prev = tokenMap.get(t.value);
      if (!prev || t.weight > prev.weight) tokenMap.set(t.value, t);
    }
  }
  if (!tokenMap.size) return { status: 'no usable tokens' };

  const files = await walk(root);
  const hits = new Map(); // token -> [{file, line}]
  for (const file of files) {
    let content;
    try {
      const s = await stat(file);
      if (s.size > 1_500_000) continue;
      content = await readFile(file, 'utf8');
    } catch { continue; }

    for (const token of tokenMap.keys()) {
      const idx = content.indexOf(token);
      if (idx === -1) continue;
      const line = content.slice(0, idx).split('\n').length;
      const list = hits.get(token) || [];
      if (list.length < 8) list.push({ file: path.relative(root, file), line, tier: fileTier(file) });
      hits.set(token, list);
    }
  }

  // A component file is almost always the useful answer. Without this, a
  // translated string resolves to the translation dictionary, which is where
  // the text lives but not where the markup can be fixed.
  for (const list of hits.values()) list.sort((a, b) => a.tier - b.tier);

  let mapped = 0;
  for (const f of targets) {
    const toks = perFinding.get(f) || [];
    for (const t of toks) {
      const list = hits.get(t.value);
      if (!list || !list.length) continue;
      if (list.length === 1) {
        f.sourceLocation = { file: list[0].file, line: list[0].line, confidence: t.weight >= 75 ? 'high' : 'medium', via: t.kind };
      } else {
        f.sourceLocation = { candidates: list.slice(0, 3), confidence: 'low', via: t.kind };
      }
      mapped++;
      break;
    }
  }
  return { status: `mapped ${mapped}/${targets.length} findings across ${files.length} files` };
}

const CONFIG_HINT = `// eslint.config.mjs: enable the full jsx-a11y recommended set
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  // ...your existing config
  jsxA11y.flatConfigs.recommended,
];`;

/**
 * Run jsx-a11y's recommended rules with the project's own ESLint and plugin.
 * Nothing is installed or written. Skipped, with the reason, if either is
 * missing. Worth having because eslint-config-next turns on only a handful of
 * jsx-a11y rules, so label-has-associated-control and friends never run.
 */
export async function lintProject(projectDir) {
  const root = path.resolve(projectDir);
  const pkg = path.join(root, 'package.json');
  if (!existsSync(pkg)) return { status: `skipped - no package.json at ${root}`, findings: [] };

  let ESLint, a11y;
  try {
    const req = createRequire(pathToFileURL(pkg));
    ({ ESLint } = req('eslint'));
    a11y = req('eslint-plugin-jsx-a11y');
  } catch (err) {
    return { status: `skipped - ${String(err.message).split('\n')[0]}`, findings: [] };
  }

  const rules = a11y.flatConfigs?.recommended?.rules || a11y.configs?.recommended?.rules;
  if (!rules) return { status: 'skipped - jsx-a11y exposed no recommended rule set', findings: [] };

  let results;
  try {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,          // ignore the project's own config entirely
      errorOnUnmatchedPattern: false,
      overrideConfig: [
        {
          files: ['**/*.jsx', '**/*.tsx'],
          ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', '**/out/**'],
          plugins: { 'jsx-a11y': a11y },
          languageOptions: { parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } } },
          rules,
        },
      ],
    });
    results = await eslint.lintFiles([`${root}/**/*.jsx`, `${root}/**/*.tsx`]);
  } catch (err) {
    return { status: `skipped - lint run failed: ${String(err.message).split('\n')[0]}`, findings: [] };
  }

  const findings = [];
  for (const res of results) {
    for (const m of res.messages) {
      if (!m.ruleId) continue;
      findings.push({
        id: m.ruleId,
        source: 'lint',
        bucket: 'violation',
        class: 'lint',
        sc: null, level: null, wcagVersion: null, enClauses: [],
        impact: m.severity === 2 ? 'serious' : 'moderate',
        severity: null,
        selector: null, ancestry: null, xpath: null, htmlSnippet: null,
        viewports: ['source'],
        url: `project:${root}`,
        message: m.message,
        detail: 'Static analysis: a likely problem at this line, not a confirmed failure in the browser.',
        helpUrl: null,
        sourceLocation: { file: path.relative(root, res.filePath), line: m.line, confidence: 'exact', via: 'eslint' },
      });
    }
  }

  return {
    status: `ran ${Object.keys(rules).length} jsx-a11y rules over ${results.length} files, ${findings.length} finding(s)`,
    findings,
    configHint: findings.length ? CONFIG_HINT : null,
  };
}
