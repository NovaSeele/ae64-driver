// "Sơ lược" effect icons (FXP §5): one still glyph per AE64 effect, 20 × 20, currentColor only (opacity tiers for dim and
// bright). Each glyph follows what a real AE64 Max showed (src/data/ledPatterns.ts). Keys are drawn on open ground; strip
// effects on the board's edge (a rounded frame), since the strip is that edge. Our own drawings, not copied from any other
// app. The strings are SVG children for a `viewBox="0 0 20 20"` element; they hold no script and no outside reference.

const f = (o: number) => `fill="currentColor"${o < 1 ? ` fill-opacity="${o}"` : ''}`;
const s = (w: number, o: number) =>
  `fill="none" stroke="currentColor" stroke-width="${w}"${o < 1 ? ` stroke-opacity="${o}"` : ''} stroke-linecap="round" stroke-linejoin="round"`;

/** cols × rows cells filling 1…19; `o` per cell = fill opacity (0 = none). */
function cells(cols: number, rows: number, o: number[], gap = 1.5): string {
  const square = rows === 3 && cols === 3;
  const cw = (18 - gap * (cols - 1)) / cols;
  const ch = square ? cw : (12 - gap * (rows - 1)) / rows;
  const y0 = square ? 1 : 10 - (ch * rows + gap * (rows - 1)) / 2;
  return o.map((v, i) => {
    if (!v) return '';
    const x = 1 + (i % cols) * (cw + gap);
    const y = y0 + Math.floor(i / cols) * (ch + gap);
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" rx="${Math.min(1.3, cw / 3).toFixed(2)}" ${f(v)}/>`;
  }).join('');
}

const D = 0.2; // an unlit key, still drawn so the board reads as a board
const bars = (vertical: boolean) => [0.28, 0.55, 1, 0.55, 0.28].map((o, i) => {
  const a = 2.4 + i * 3.8;
  return vertical
    ? `<rect x="${(a - 1.2).toFixed(2)}" y="2.5" width="2.4" height="15" rx="1.2" ${f(o)}/>`
    : `<rect x="2.5" y="${(a - 1.2).toFixed(2)}" width="15" height="2.4" rx="1.2" ${f(o)}/>`;
}).join('');

function arrow(x1: number, y1: number, x2: number, y2: number, w = 1.5, o = 1): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = 2.6;
  const p = (da: number) => `${(x2 - h * Math.cos(a + da)).toFixed(2)} ${(y2 - h * Math.sin(a + da)).toFixed(2)}`;
  return `<path d="M${x1} ${y1} L${x2} ${y2} M${p(0.6)} L${x2} ${y2} L${p(-0.6)}" ${s(w, o)}/>`;
}

function spark(cx: number, cy: number, r: number, o: number): string {
  const q = r * 0.18;
  return `<path d="M${cx} ${cy - r} C ${cx + q} ${cy - q}, ${cx + q} ${cy - q}, ${cx + r} ${cy} C ${cx + q} ${cy + q}, ${cx + q} ${cy + q}, ${cx} ${cy + r} C ${cx - q} ${cy + q}, ${cx - q} ${cy + q}, ${cx - r} ${cy} C ${cx - q} ${cy - q}, ${cx - q} ${cy - q}, ${cx} ${cy - r} Z" ${f(o)}/>`;
}

// the board's edge for the strip: an 18 × 13 rounded frame centred at (10, 10)
const L = 1.6, T = 3.6, R = 18.4, B = 16.4, RR = 3;
const EDGE = `M${L + RR} ${T} H${R - RR} A${RR} ${RR} 0 0 1 ${R} ${T + RR} V${B - RR} A${RR} ${RR} 0 0 1 ${R - RR} ${B} H${L + RR} A${RR} ${RR} 0 0 1 ${L} ${B - RR} V${T + RR} A${RR} ${RR} 0 0 1 ${L + RR} ${T} Z`;
const edge = (w: number, o: number, extra = '') => `<path d="${EDGE}" ${s(w, o)} ${extra}/>`;
/** the frame's length */
const PER = 2 * (R - L - 2 * RR) + 2 * (B - T - 2 * RR) + 2 * Math.PI * RR;
/** A lit run along the frame, from fraction a to b of its length (0 = the top-left corner's end, going clockwise). */
const run = (a: number, b: number, w = 2.6, o = 1) =>
  `<path d="${EDGE}" ${s(w, o)} stroke-dasharray="0 ${(a * PER).toFixed(2)} ${((b - a) * PER).toFixed(2)} ${PER.toFixed(2)}"/>`;

/** Key effects by UI number. */
export const KEY_ICONS: Readonly<Record<number, string>> = {
  1: `<rect x="1.5" y="4" width="17" height="12" rx="2.6" ${f(1)}/>`, // static: one steady light over the whole board
  2: bars(true), // horizontal wave: a band of light crossing left to right
  3: bars(false), // vertical wave: a band moving top to bottom
  4: `<circle cx="10" cy="10" r="2" ${f(1)}/><ellipse cx="10" cy="10" rx="5.6" ry="4.4" ${s(1.6, 0.7)}/><ellipse cx="10" cy="10" rx="8.6" ry="7" ${s(1.5, 0.35)}/>`, // ripple: rings spreading out (wider than tall)
  5: `<path d="M10.90 10.00 L11.08 9.74 L11.17 9.39 L11.15 8.99 L11.00 8.57 L10.71 8.17 L10.28 7.85 L9.74 7.63 L9.11 7.56 L8.44 7.67 L7.77 7.97 L7.16 8.45 L6.67 9.12 L6.35 9.93 L6.23 10.85 L6.35 11.82 L6.73 12.77 L7.35 13.64 L8.22 14.36 L9.27 14.87 L10.47 15.11 L11.75 15.05 L13.01 14.67 L14.19 13.97 L15.20 12.96 L15.96 11.70 L16.40 10.24 L16.48 8.66 L16.17 7.07 L15.46 5.55 L14.37 4.21 L12.95 3.14 L11.27 2.43 L9.42 2.13 L7.50 2.30" ${s(1.7, 1)}/><path d="M10.07 0.40 L7.50 2.30 L10.36 3.73" ${s(1.7, 1)}/>`, // spiral: one arm turning counter-clockwise
  8: `<rect x="6" y="6" width="8" height="8" rx="2" ${f(1)}/><rect x="3.4" y="3.4" width="13.2" height="13.2" rx="3.4" ${s(1.4, 0.55)}/><rect x="1" y="1" width="18" height="18" rx="4.6" ${s(1.2, 0.25)}/>`, // breathing: one glow, in and out
  10: `<rect x="1.5" y="4" width="17" height="12" rx="2.4" ${s(1.4, 0.4)}/><path d="M3.9 4 H10 V16 H3.9 A2.4 2.4 0 0 1 1.5 13.6 V6.4 A2.4 2.4 0 0 1 3.9 4 Z" ${f(1)}/><path d="M12.8 7.4 L15.4 10 L12.8 12.6" ${s(1.5, 0.9)}/>`, // colour wipe: a colour fills in, from one side then the other
  11: `<path d="M1.8 3 Q6.2 15 10.6 3" ${s(1.8, 1)}/><path d="M10.6 3 Q15 15 19.4 3" ${s(1.8, 0.45)}/>${arrow(8.6, 17, 3.6, 17, 1.4, 0.75)}`, // arc wave: U-shaped bands moving right to left
  12: `<path d="M1.6 4.2 L10 15.8 L18.4 4.2" ${s(1.9, 1)}/>`, // sine line: one thin line, one swing across the board
  13: cells(3, 3, [1, 0.3, 0.7, 0.45, 1, 0.25, 0.75, 0.4, 0.9]), // random colours: every key its own, all lit
  14: `${spark(7, 7.5, 6, 1)}${spark(15, 14.5, 3.6, 0.7)}<circle cx="15.5" cy="4.5" r="1.1" ${f(0.5)}/><circle cx="4.5" cy="16" r="1" ${f(0.45)}/>`, // twinkle: many keys flare and fade
  15: ([[4, 4.5, 1.6, 1], [11.5, 3, 1, 0.5], [16, 7, 1.4, 0.8], [7.5, 10.5, 1.1, 0.45], [14, 13.5, 1.8, 1], [4.5, 16, 1.2, 0.7], [10.5, 17, 0.9, 0.4]] as const)
    .map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" ${f(o)}/>`).join(''), // starlight: a few single keys flash
  16: `<path d="M2.6 3.4 L17.4 16.6" ${s(1.1, 0.3)} stroke-dasharray="1.4 1.8"/><circle cx="5.4" cy="5.9" r="1.7" ${f(0.22)}/><circle cx="8.7" cy="8.8" r="2.5" ${f(0.45)}/><circle cx="13" cy="12.6" r="3.7" ${f(1)}/>`, // bouncing glow: one soft light sliding corner to corner
  17: cells(5, 3, [D, D, D, D, D, D, D, 1, D, D, D, D, D, D, D]), // reactive: the key you press
  18: cells(5, 3, [D, 1, 1, 1, D, D, 1, 1, 1, D, D, 1, 1, 1, D]), // reactive: the key and the keys around it
  19: cells(5, 3, [D, D, D, D, D, 1, 1, 1, 1, 1, D, D, D, D, D]), // reactive: the key's whole row
};

/** Strip effects by UI number. */
export const STRIP_ICONS: Readonly<Record<number, string>> = {
  1: edge(2.6, 1), // static: the whole edge, one steady light
  2: `${edge(1.6, 0.25)}${run(0.02, 0.5)}${arrow(R, 8.2, R, 11.6, 1.6, 1)}`, // chase: a lit run going round, clockwise
  3: `${edge(2.2, 1)}<rect x="${L - 1.3}" y="${T - 1.3}" width="${R - L + 2.6}" height="${B - T + 2.6}" rx="${RR + 1.3}" ${s(1, 0.32)}/><rect x="${L + 2.6}" y="${T + 2.6}" width="${R - L - 5.2}" height="${B - T - 5.2}" rx="1.4" ${s(1, 0.32)}/>`, // breathing: the edge glows in and out
  4: `${edge(1.6, 0.25)}${run(0.53, 0.83)}<circle cx="5.6" cy="${B}" r="2" ${f(1)}/><circle cx="15.2" cy="${T}" r="1.5" ${s(1.2, 0.85)}/>`, // mirrored wave: from one point near the bottom left, both ways round, meeting near the top right
  5: `${edge(1.6, 0.25)}<path d="${EDGE}" ${s(2.6, 1)} stroke-dasharray="2.6 3.2"/>`, // mirrored chase: short runs with gaps
};

/** An effect whose look is not known yet (keys 6, 7, 9; Pro 20). */
export const UNKNOWN_ICON = `<rect x="2" y="2" width="16" height="16" rx="3.6" ${s(1.3, 0.55)} stroke-dasharray="2.4 2"/><text x="10" y="14.2" text-anchor="middle" font-size="11" font-weight="700" font-family="Inter, Segoe UI, sans-serif" ${f(0.85)}>?</text>`;

/** The glyph of effect `n` (UI number) of an area, or the "?" glyph when its look is not known. */
export function effectIcon(area: 0 | 1, n: number, known: boolean): string {
  if (!known) return UNKNOWN_ICON;
  return (area === 0 ? KEY_ICONS : STRIP_ICONS)[n] ?? UNKNOWN_ICON;
}
