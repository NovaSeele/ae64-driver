/* Runs before first paint (classic script: CSP is script-src 'self', no inline scripts).
   Mirrors src/theme.ts: reads ae64.theme, resolves "auto", sets data-theme and the two metas.
   The table holds each theme's colour-scheme and --bg-1 (themes.css) because the stylesheet is not loaded yet. */
(function () {
  var THEMES = {
    graphite: ['dark', '#111213'],
    light: ['light', '#f8f9fb'],
    ember: ['dark', '#0b0b0b'],
    aurora: ['dark', '#07080c'],
    mint: ['dark', '#262626'],
    nord: ['dark', '#272c36'],
    dracula: ['dark', '#21222c'],
    rose: ['dark', '#141213'],
  };
  var choice = 'graphite';
  try {
    var v = localStorage.getItem('ae64.theme');
    if (v === 'auto' || Object.prototype.hasOwnProperty.call(THEMES, v)) choice = v;
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
  var t = THEMES[id];
  var cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', t[0]);
  var tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', t[1]);
})();
