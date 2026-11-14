/* Runs before first paint (classic script: CSP is script-src 'self', no inline scripts).
   Mirrors src/theme.ts: reads ae64.theme, resolves "auto", sets data-theme and the two metas.
   The table holds each theme's colour-scheme and --bg-1 (themes.css) because the stylesheet is not loaded yet. */
(function () {
  var THEMES = {
    indigo: ['dark', '#101120'],
    'indigo-light': ['light', '#f8f8fd'],
    gold: ['dark', '#111213'],
    graphite: ['dark', '#111213'],
    light: ['light', '#f8f9fb'],
    ember: ['dark', '#0b0b0b'],
    aurora: ['dark', '#07080c'],
    mint: ['dark', '#262626'],
    nord: ['dark', '#272c36'],
    dracula: ['dark', '#21222c'],
    rose: ['dark', '#141213'],
  };
  var LEGACY = { seele: 'indigo', 'seele-light': 'indigo-light' };
  var choice = 'auto';
  try {
    var v = localStorage.getItem('ae64.theme');
    if (Object.prototype.hasOwnProperty.call(LEGACY, v)) {
      choice = LEGACY[v];
      localStorage.setItem('ae64.theme', choice);
    } else if (v === 'auto' || Object.prototype.hasOwnProperty.call(THEMES, v)) choice = v;
  } catch (e) {}
  var id = choice;
  if (choice === 'auto') {
    try {
      id = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'graphite';
    } catch (e) {
      id = 'graphite';
    }
  }
  document.documentElement.setAttribute('data-theme', id);
  // A custom accent (DESIGN J §3.3): copy the cached token set of this theme; the maths is in src/accent.ts, not here.
  try {
    var hx = localStorage.getItem('ae64.accent'), c = JSON.parse(localStorage.getItem('ae64.accentVars') || 'null');
    if (hx && c && c.v === 1 && c.hex === hx && c.themes && c.themes[id]) {
      var vs = c.themes[id], ks = ['--acc', '--acc-hover', '--on-acc', '--sel', '--m-actuation'];
      for (var i = 0; i < ks.length; i++) if (/^#[0-9a-f]{6}$/.test(vs[ks[i]])) document.documentElement.style.setProperty(ks[i], vs[ks[i]]);
    }
  } catch (e) { /* the theme's own accent */ }
  var t = THEMES[id];
  var cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', t[0]);
  var tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', t[1]);
})();
