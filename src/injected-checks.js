/*
 * Runs inside the page. Plain browser JavaScript with no imports: the file is
 * read as text and evaluated in the page, so it has to be self-contained.
 *
 * These checks only cover what axe-core has no rule for (reflow, focus
 * visibility, looping motion, positive tabindex, overlay detection).
 * Duplicating an axe rule would put two disagreeing answers on one criterion.
 *
 * `report` is used only when the DOM alone decides the result. Anything that
 * needs a person to judge is a `flag` and lands in needs-review.
 */
(function () {
  if (window.__floorcheck) return;

  var excluded = [];

  function isExcluded(el) {
    for (var i = 0; i < excluded.length; i++) {
      try { if (el.closest(excluded[i])) return true; } catch (e) { /* invalid selector, ignore */ }
    }
    return false;
  }

  function cssPath(el, maxDepth) {
    if (!el || el.nodeType !== 1) return null;
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < (maxDepth || 5)) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function snippet(el) {
    var html = el.outerHTML || '';
    return html.length > 240 ? html.slice(0, 240) + '...' : html;
  }

  function isVisible(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* 1.4.10 Reflow. At a narrow viewport the document must not scroll
   * sideways. Only the outermost overflowing elements are reported, so one wide
   * container does not drag its whole subtree into the report. */
  function checkReflow() {
    var docEl = document.scrollingElement || document.documentElement;
    var vw = window.innerWidth;
    var overflow = docEl.scrollWidth - vw;
    if (overflow <= 2) return [];

    function clippedByAncestor(el) {
      var node = el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowX)) return true;
        node = node.parentElement;
      }
      return false;
    }

    // Only content past the trailing edge creates a scrollbar. Things parked
    // off the leading edge (skip links, screen-reader-only text) do not.
    var rtl = getComputedStyle(document.documentElement).direction === 'rtl';

    function visuallyHidden(cs, r) {
      return (r.width <= 1 && r.height <= 1)
        || cs.clip === 'rect(0px, 0px, 0px, 0px)'
        || /inset\(50%\)/.test(cs.clipPath);
    }

    var offenders = [];
    var all = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      if (!isVisible(el, cs)) continue;
      var r = el.getBoundingClientRect();
      if (rtl ? r.left >= -2 : r.right <= vw + 2) continue;
      if (visuallyHidden(cs, r)) continue;
      if (clippedByAncestor(el)) continue;
      offenders.push({ el: el, right: Math.round(r.right), width: Math.round(r.width) });
    }
    var outermost = offenders.filter(function (o) {
      return !offenders.some(function (p) { return p.el !== o.el && p.el.contains(o.el); });
    });
    // If every offender sits inside an excluded region, the overflow is theirs.
    var counted = outermost.filter(function (o) { return !isExcluded(o.el); });
    if (outermost.length && !counted.length) return [];

    return [{
      id: 'reflow-horizontal-overflow',
      cls: 'report',
      sc: '1.4.10',
      level: 'AA',
      wcagVersion: '2.1',
      impact: 'serious',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html',
      message: 'Page scrolls sideways at ' + vw + 'px wide (content is ' + overflow + 'px too wide).',
      detail: 'WCAG 1.4.10 Reflow: content must work at 320 CSS px wide without scrolling in two directions. '
        + (counted.length ? 'The outermost overflowing elements are listed.' : 'No single element could be blamed; check the layout container.'),
      nodes: counted.slice(0, 12).map(function (o) {
        return {
          selector: cssPath(o.el),
          html: snippet(o.el),
          note: 'right edge ' + o.right + 'px, width ' + o.width + 'px, viewport ' + vw + 'px',
        };
      }),
    }];
  }

  /* 2.2.2 Pause, Stop, Hide. axe only knows <blink> and <marquee>. What the
   * DOM can show: an animation loops forever and no stylesheet mentions
   * prefers-reduced-motion. Whether there is a pause control, or the motion is
   * essential, needs a person, so this is always a flag. */
  function checkLoopingMotion() {
    var hasQuery = false;
    var unreadable = 0;
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length && !hasQuery; i++) {
      var rules = null;
      try { rules = sheets[i].cssRules; } catch (e) { unreadable++; continue; }
      if (!rules) { unreadable++; continue; }
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        var text = String((r.media && r.media.mediaText) || r.conditionText || '');
        if (text.indexOf('prefers-reduced-motion') !== -1) { hasQuery = true; break; }
      }
    }
    if (hasQuery || typeof document.getAnimations !== 'function') return [];

    var looping = [];
    var anims = document.getAnimations();
    for (var k = 0; k < anims.length; k++) {
      var timing = anims[k].effect && anims[k].effect.getTiming ? anims[k].effect.getTiming() : null;
      if (!timing || timing.iterations !== Infinity) continue;
      var dur = typeof timing.duration === 'number' ? timing.duration : 0;
      var t = anims[k].effect.target;
      if (dur <= 0 || (t && isExcluded(t))) continue;
      looping.push({ selector: t ? cssPath(t) : null, html: t ? snippet(t) : null, note: 'duration ' + dur + 'ms, loops forever' });
    }
    if (!looping.length) return [];

    return [{
      id: 'looping-motion-no-reduced-motion',
      cls: 'flag',
      sc: '2.2.2',
      level: 'A',
      wcagVersion: '2.0',
      impact: 'moderate',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html',
      message: looping.length + ' animation(s) loop forever and no prefers-reduced-motion rule was found'
        + (unreadable ? ' (' + unreadable + ' cross-origin stylesheet(s) could not be read).' : '.'),
      detail: 'Check 2.2.2 Pause, Stop, Hide: motion that starts on its own and lasts more than 5 seconds needs a way '
        + 'to pause it, unless it is essential. Respecting prefers-reduced-motion also helps people with vestibular disorders.',
      nodes: looping.slice(0, 10),
    }];
  }

  /* 2.4.7 Focus Visible. Compares the painted focus affordances before and
   * after focusing, not raw property strings: Chrome's default :focus-visible
   * rule changes outline-offset even when the outline itself is suppressed,
   * which would make a naive diff report "something changed" every time. */
  function focusSignature(cs) {
    var outlinePaints = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    return [
      outlinePaints ? 'outline:' + cs.outlineStyle + '/' + cs.outlineWidth + '/' + cs.outlineColor : 'outline:none',
      cs.boxShadow && cs.boxShadow !== 'none' ? 'shadow:' + cs.boxShadow : 'shadow:none',
      'border:' + cs.borderTopStyle + '/' + cs.borderTopWidth + '/' + cs.borderTopColor
        + '/' + cs.borderBottomWidth + '/' + cs.borderBottomColor,
      'bg:' + cs.backgroundColor + '/' + cs.backgroundImage,
      'color:' + cs.color,
      'deco:' + cs.textDecorationLine + '/' + cs.textDecorationThickness + '/' + cs.textDecorationColor,
      'filter:' + cs.filter,
    ].join(' | ');
  }

  function checkFocusVisible(limit) {
    var sel = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    // tabIndex < 0 takes an element out of the Tab sequence (a link with
    // tabindex="-1" still matches a[href]), so focus visibility does not apply.
    var els = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function (el) {
      return !el.disabled && el.tabIndex >= 0 && !isExcluded(el) && isVisible(el, getComputedStyle(el));
    }).slice(0, limit || 40);

    var active = document.activeElement;
    var bad = [];
    var tested = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var before = focusSignature(getComputedStyle(el));
      try { el.focus({ preventScroll: true, focusVisible: true }); } catch (e) { continue; }
      if (document.activeElement !== el) continue;
      tested++;
      if (focusSignature(getComputedStyle(el)) === before) {
        bad.push({
          selector: cssPath(el),
          html: snippet(el),
          note: 'outline, shadow, border, background, colour and underline all stayed the same on focus',
        });
      }
      try { el.blur(); } catch (e) { /* ignore */ }
    }
    try { if (active && active.focus) active.focus({ preventScroll: true }); } catch (e) { /* ignore */ }

    if (!bad.length) return [];
    return [{
      id: 'focus-no-visible-change',
      cls: 'flag',
      sc: '2.4.7',
      level: 'AA',
      wcagVersion: '2.0',
      impact: 'serious',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html',
      message: bad.length + ' of ' + tested + ' focusable element(s) showed no visible change on focus.',
      detail: 'Candidates for 2.4.7 Focus Visible. Confirm each by pressing Tab: a ring drawn with ::before or ::after '
        + 'is invisible to this check, and some browsers only apply :focus-visible styles to real keyboard focus.',
      nodes: bad.slice(0, 15),
    }];
  }

  /* 2.4.3 Focus Order. axe tags its tabindex rule as best practice only. A
   * positive tabindex is a plain fact worth showing; whether the resulting
   * order makes sense is for a person to decide. */
  function checkPositiveTabindex() {
    var els = Array.prototype.slice.call(document.querySelectorAll('[tabindex]')).filter(function (el) {
      var v = parseInt(el.getAttribute('tabindex'), 10);
      return !isNaN(v) && v > 0 && !isExcluded(el);
    });
    if (!els.length) return [];
    return [{
      id: 'positive-tabindex',
      cls: 'flag',
      sc: '2.4.3',
      level: 'A',
      wcagVersion: '2.0',
      impact: 'moderate',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html',
      message: els.length + ' element(s) use a positive tabindex, which overrides the natural focus order.',
      detail: 'Elements with tabindex above 0 receive focus before everything else on the page. Tab through the page '
        + 'and check the order still follows the content.',
      nodes: els.slice(0, 15).map(function (el) {
        return { selector: cssPath(el), html: snippet(el), note: 'tabindex=' + el.getAttribute('tabindex') };
      }),
    }];
  }

  /* Overlays and accessibility toolbars. A fact about the page, not a
   * conformance verdict. It matters because an overlay changes the DOM while
   * the scan runs, so the results describe the page with the overlay active. */
  function checkOverlay(vendors) {
    if (!vendors || !vendors.length) return [];
    var parts = [document.documentElement ? document.documentElement.outerHTML : ''];
    try {
      parts.push(performance.getEntriesByType('resource').map(function (e) { return e.name; }).join(' '));
    } catch (e) { /* ignore */ }
    var blob = parts.join(' ').toLowerCase();

    var hits = [];
    for (var v = 0; v < vendors.length; v++) {
      var vendor = vendors[v];
      var strong = (vendor.strong || []).filter(function (s) { return blob.indexOf(String(s).toLowerCase()) !== -1; });
      var weak = (vendor.weak || []).filter(function (s) { return blob.indexOf(String(s).toLowerCase()) !== -1; });
      if (strong.length) hits.push({ vendor: vendor.name, kind: vendor.kind || 'overlay', confidence: 'installed', matched: strong });
      else if (weak.length) hits.push({ vendor: vendor.name, kind: vendor.kind || 'overlay', confidence: 'mentioned', matched: weak });
    }
    if (!hits.length) return [];

    return [{
      id: 'accessibility-overlay-detected',
      cls: 'report',
      contextOnly: true,
      sc: null,
      level: null,
      wcagVersion: null,
      impact: 'moderate',
      helpUrl: 'https://overlayfactsheet.com/',
      message: 'Accessibility overlay or toolbar found: '
        + hits.map(function (h) { return h.vendor + ' (' + h.kind + ', ' + h.confidence + ')'; }).join(', ') + '.',
      detail: 'This describes the page source, it is not a pass or a fail. An overlay does not make a site conform, and '
        + 'because it rewrites the page while the scan runs, the results reflect the page with the overlay switched on.',
      nodes: hits.map(function (h) {
        return { selector: null, html: null, note: h.vendor + ': ' + h.confidence + ', matched ' + h.matched.join(', ') };
      }),
    }];
  }

  window.__floorcheck = {
    run: function (opts) {
      opts = opts || {};
      excluded = opts.exclude || [];
      var out = [];
      var errors = [];
      function safe(name, fn) {
        try { out.push.apply(out, fn() || []); } catch (e) { errors.push(name + ': ' + (e && e.message)); }
      }
      if (opts.viewportWidth && opts.viewportWidth <= 400) safe('reflow', checkReflow);
      if (opts.isPrimary) {
        safe('overlay', function () { return checkOverlay(opts.overlayVendors); });
        safe('loopingMotion', checkLoopingMotion);
        if (opts.includeFlags) {
          safe('positiveTabindex', checkPositiveTabindex);
          safe('focusVisible', function () { return checkFocusVisible(opts.focusLimit); });
        }
      }
      return { checks: out, errors: errors };
    },
  };
})();
