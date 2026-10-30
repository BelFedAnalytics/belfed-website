// research-render v20 styles: Direction 2 "Mono Header + Readable Text".
// Mono (IBM Plex Mono) for kickers, labels, metadata, captions; serif (Source Serif 4)
// for titles and body. Tokens are prefixed --rs- so they never collide with the
// variables the shared header injects on <html> for the legacy pages.
export const RS_CSS = `
:root {
  --rs-mono: 'IBM Plex Mono', 'PT Mono', 'DejaVu Sans Mono', 'Courier New', monospace;
  --rs-serif: 'Source Serif 4', 'PT Serif', Georgia, 'Times New Roman', serif;
  --rs-fs-hero: 60px; --rs-fs-h1: 46px; --rs-fs-h2: 30px; --rs-fs-h3: 22px; --rs-fs-feat: 38px; --rs-fs-row: 24px; --rs-fs-latest: 20px;
  --rs-fs-body: 18px; --rs-fs-lead: 20px; --rs-fs-small: 15px; --rs-fs-meta: 13px; --rs-fs-label: 12px;
  --rs-lh: 1.6;
  --rs-s2: 8px; --rs-s3: 12px; --rs-s4: 16px; --rs-s5: 24px; --rs-s6: 32px; --rs-s7: 48px; --rs-s8: 64px; --rs-s9: 96px;
  --rs-gutter: 32px; --rs-pad: 28px; --rs-max: 1200px; --rs-measure: 640px;
  --rs-text: 640px;
  --rs-bg: #f5f5f0; --rs-paper: #edede6; --rs-paper-2: #e5e5dc;
  --rs-ink: #0a0a0a; --rs-ink-2: #555555; --rs-ink-3: #6b6b6b;
  --rs-rule: rgba(10,10,10,.06); --rs-rule-strong: rgba(10,10,10,.16); --rs-rule-ink: #0a0a0a;
  --rs-green: #14542d; --rs-green-text: #14542d;
  --rs-gold: #b8860b; --rs-gold-text: #7d5c06;
  --rs-cta-bg: #0a0a0a; --rs-cta-fg: #f5f5f0;
  --rs-focus: #14542d;
  --rs-t: 200ms cubic-bezier(.2,.7,.2,1);
  --hdr: 64px;
  color-scheme: light;
}
html[data-theme="dark"] {
  --rs-bg: #0a0c10; --rs-paper: #12151b; --rs-paper-2: #181c23;
  --rs-ink: #f0f0e8; --rs-ink-2: #a3a39a; --rs-ink-3: #8f8f87;
  --rs-rule: rgba(240,240,232,.08); --rs-rule-strong: rgba(240,240,232,.18); --rs-rule-ink: #f0f0e8;
  --rs-green: #2d8f4a; --rs-green-text: #46c277;
  --rs-gold: #b8860b; --rs-gold-text: #d6a020;
  --rs-cta-bg: #f0f0e8; --rs-cta-fg: #0a0c10;
  --rs-focus: #d6a020;
  color-scheme: dark;
}
@media (max-width: 1024px) { :root { --rs-fs-hero: 48px; --rs-fs-h1: 38px; --rs-fs-feat: 32px; --rs-fs-row: 22px; } }
@media (max-width: 640px) {
  :root { --rs-fs-hero: 38px; --rs-fs-h1: 31px; --rs-fs-h2: 25px; --rs-fs-h3: 20px; --rs-fs-feat: 27px; --rs-fs-row: 20px; --rs-fs-latest: 18px; --rs-fs-body: 17px; --rs-fs-lead: 18px; --rs-fs-label: 11px; --rs-pad: 16px; --rs-gutter: 16px; }
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: calc(var(--hdr) + 24px); }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
body { margin: 0; background: var(--rs-bg); color: var(--rs-ink); font-family: var(--rs-serif); font-size: var(--rs-fs-body); line-height: var(--rs-lh); -webkit-font-smoothing: antialiased; overflow-x: clip; font-optical-sizing: auto; }
main img { max-width: 100%; height: auto; display: block; }
main a { color: inherit; }
h1, h2, h3, h4, p, figure, ol, ul { margin: 0; }
main a:focus-visible, main button:focus-visible, main input:focus-visible, main summary:focus-visible, .rs-banner a:focus-visible, .rs-banner button:focus-visible, dialog.rs-lb button:focus-visible { outline: 2px solid var(--rs-focus); outline-offset: 3px; border-radius: 2px; }
.rs-skip { position: absolute; left: -9999px; top: 8px; background: var(--rs-cta-bg); color: var(--rs-cta-fg); padding: 8px 12px; z-index: 3000; font: 600 13px var(--rs-mono); }
.rs-skip:focus { left: 8px; }
.rs-wrap { max-width: var(--rs-max); margin: 0 auto; padding-left: var(--rs-pad); padding-right: var(--rs-pad); }
.rs-main { padding-bottom: var(--rs-s8); }
h1, h2, h3 { font-family: var(--rs-serif); font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }

.kicker { font-family: var(--rs-mono); font-size: var(--rs-fs-label); font-weight: 500; letter-spacing: .15em; text-transform: uppercase; color: var(--rs-green-text); }
.kicker.gold { color: var(--rs-gold-text); }
.label { font-family: var(--rs-mono); font-size: var(--rs-fs-label); font-weight: 500; letter-spacing: .15em; text-transform: uppercase; color: var(--rs-ink-2); }
.tags { display: flex; flex-wrap: wrap; row-gap: 4px; }
.tag { font-family: var(--rs-mono); display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--rs-ink-2); white-space: nowrap; }
.tag.type { color: var(--rs-gold-text); }
.tag.cls { color: var(--rs-green-text); }
.tag + .tag::before { content: "\\00B7"; color: var(--rs-ink-3); margin: 0 8px; }
.meta { font-family: var(--rs-mono); display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--rs-fs-meta); color: var(--rs-ink-2); align-items: center; letter-spacing: .02em; }
.meta time { color: var(--rs-ink); }
.btn { font-family: var(--rs-mono); display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 44px; padding: 10px 18px; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; text-decoration: none; border: 1px solid var(--rs-rule-ink); border-radius: 2px; cursor: pointer; transition: background var(--rs-t), color var(--rs-t), transform var(--rs-t), border-color var(--rs-t); color: var(--rs-ink); background: transparent; text-align: center; }
.btn:hover { transform: translateY(-1px); }
.btn.primary { background: var(--rs-cta-bg); color: var(--rs-cta-fg); border-color: var(--rs-cta-bg); }
.btn.primary:hover { background: #14542d; border-color: #14542d; color: #f5f5f0; }
.btn.ghost { border-color: var(--rs-rule-strong); color: var(--rs-ink); }
.btn.ghost:hover { border-color: var(--rs-rule-ink); }
.btn.sm { min-height: 36px; padding: 6px 12px; font-size: 11px; }
.btn[data-done] { border-color: var(--rs-green); color: var(--rs-green-text); }
.btn svg { flex: 0 0 auto; }
.rs-alt { font-family: var(--rs-mono); font-size: 12px; color: var(--rs-ink-2); text-underline-offset: 3px; }
.rs-alt:hover { color: var(--rs-ink); }

/* ---------- index ---------- */
.index-hero { padding: var(--rs-s8) 0 var(--rs-s6); }
.index-hero h1 { font-size: var(--rs-fs-hero); line-height: 1; margin: var(--rs-s3) 0 var(--rs-s4); }
.index-hero .lead { font-size: var(--rs-fs-lead); line-height: 1.5; color: var(--rs-ink-2); max-width: 60ch; }

.rs-bar { border-top: 1px solid var(--rs-rule-ink); border-bottom: 1px solid var(--rs-rule-strong); position: sticky; top: var(--hdr); z-index: 50; background: color-mix(in oklab, var(--rs-bg) 94%, transparent); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.rs-bar .row { display: flex; align-items: center; gap: var(--rs-s4); flex-wrap: wrap; }
.rs-chips { display: flex; gap: 6px var(--rs-s5); flex: 1 1 auto; flex-wrap: wrap; }
.rs-chip { font-family: var(--rs-mono); font-size: 12px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; min-height: 48px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--rs-ink-2); cursor: pointer; display: inline-flex; gap: 8px; align-items: center; transition: color var(--rs-t), border-color var(--rs-t); border-radius: 0; }
.rs-chip .rs-n { color: var(--rs-ink-3); font-weight: 400; font-size: 11px; }
.rs-chip:hover { color: var(--rs-ink); }
.rs-chip.is-active { color: var(--rs-ink); border-bottom-color: var(--rs-gold); }
.rs-search { position: relative; display: flex; align-items: center; min-width: 240px; flex: 0 1 300px; border-bottom: 1px solid var(--rs-rule-strong); color: var(--rs-ink-2); gap: 6px; }
.rs-search:focus-within { border-bottom-color: var(--rs-rule-ink); }
.rs-search input { flex: 1; min-width: 0; background: transparent; border: 0; padding: 10px 4px; font: 400 14px/1.4 var(--rs-mono); color: var(--rs-ink); outline: none; }
.rs-search input::placeholder { color: var(--rs-ink-3); opacity: 1; }
.rs-search input::-webkit-search-cancel-button { display: none; }
.rs-clear { background: transparent; border: 0; color: var(--rs-ink-2); font-size: 20px; width: 36px; height: 36px; cursor: pointer; }
.rs-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.rs-count { font-family: var(--rs-mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--rs-ink-2); white-space: nowrap; }
@media (max-width: 640px) {
  .rs-bar { position: static; }
  .rs-bar .row { gap: 0 var(--rs-s3); }
  .rs-chips { flex: 0 0 auto; width: calc(100% + 2 * var(--rs-pad)); flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; gap: var(--rs-s4); margin: 0 calc(-1 * var(--rs-pad)); padding: 0 var(--rs-pad); }
  .rs-chips::-webkit-scrollbar { display: none; }
  .rs-chip { flex-shrink: 0; min-height: 44px; }
  .rs-search { flex: 1 1 auto; min-width: 0; }
  .rs-count { padding: var(--rs-s2) 0; }
}

.top { display: grid; grid-template-columns: minmax(0, 8fr) minmax(0, 4fr); gap: var(--rs-s7) var(--rs-gutter); padding: var(--rs-s7) 0 var(--rs-s6); }
.featured a { text-decoration: none; display: block; }
.featured .cover { aspect-ratio: 16/9; overflow: hidden; background: var(--rs-paper); border: 1px solid var(--rs-rule); }
.featured .cover img { width: 100%; height: 100%; object-fit: cover; transition: transform 700ms cubic-bezier(.2,.7,.2,1); }
.featured a:hover .cover img { transform: scale(1.015); }
.featured .tags { margin-top: var(--rs-s5); }
.featured h2 { font-size: var(--rs-fs-feat); line-height: 1.12; margin: var(--rs-s3) 0; }
.featured a:hover h2 { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 4px; }
.featured .sum { font-size: var(--rs-fs-small); line-height: 1.55; color: var(--rs-ink-2); margin: 0 0 var(--rs-s4); max-width: 68ch; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.featured .go { color: var(--rs-green-text); font-weight: 500; letter-spacing: .12em; text-transform: uppercase; font-size: 11px; }
.latest { border-top: 2px solid var(--rs-rule-ink); min-width: 0; }
.latest h2 { font-size: var(--rs-fs-h3); margin: var(--rs-s4) 0 var(--rs-s2); }
.latest ol { list-style: none; padding: 0; }
.latest li { border-top: 1px solid var(--rs-rule-strong); }
.latest li a { display: block; text-decoration: none; padding: var(--rs-s4) 0; }
.latest li a:hover .t { text-decoration: underline; text-underline-offset: 3px; }
.latest .t { display: block; font-family: var(--rs-serif); font-weight: 600; font-size: var(--rs-fs-latest); line-height: 1.3; margin: 6px 0 8px; letter-spacing: -.005em; }
.latest .meta { font-size: 12px; }
.sub { border: 1px solid var(--rs-rule-ink); padding: var(--rs-s5); margin-top: var(--rs-s6); background: var(--rs-paper); scroll-margin-top: calc(var(--hdr) + 80px); }
.sub h3 { font-size: var(--rs-fs-h3); margin: var(--rs-s2) 0; }
.sub > p { font-size: var(--rs-fs-small); color: var(--rs-ink-2); margin: 0 0 var(--rs-s4); line-height: 1.5; }
.sub form { display: grid; gap: var(--rs-s3); }
.sub-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; border: 1px solid var(--rs-rule-ink); background: var(--rs-bg); }
.sub-field[hidden] { display: none; }
.sub-field input { min-width: 0; border: 0; background: transparent; color: var(--rs-ink); font: 400 14px var(--rs-mono); padding: 0 12px; min-height: 44px; }
.sub-field input::placeholder { color: var(--rs-ink-3); opacity: 1; }
.sub-field input:focus-visible { outline: 2px solid var(--rs-focus); outline-offset: -2px; }
.sub-field .btn { min-height: 44px; border: 0; border-left: 1px solid var(--rs-rule-ink); }
.sub .consent { display: flex; gap: 10px; align-items: flex-start; font-family: var(--rs-mono); font-size: 11px; color: var(--rs-ink-2); line-height: 1.5; cursor: pointer; }
.sub .consent[hidden] { display: none; }
.sub .consent input { margin-top: 2px; flex-shrink: 0; width: 16px; height: 16px; accent-color: var(--rs-green); }
.sub .consent a { color: var(--rs-green-text); text-underline-offset: 2px; }
.sub .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.sub .msg { font-family: var(--rs-mono); font-size: 12px; line-height: 1.5; padding: 10px 12px; border: 1px solid; }
.sub .msg.ok { color: var(--rs-green-text); border-color: var(--rs-green); }
.sub .msg.err { color: var(--rs-ink); border-color: #c0392b; }
.sub { container-type: inline-size; }
.sub .soc { margin-top: var(--rs-s5); padding-top: var(--rs-s4); border-top: 1px solid var(--rs-rule-strong); }
.sub .soc ul { list-style: none; padding: 0; margin: var(--rs-s3) 0 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--rs-s2); }
.sub .soc li { border: 0; }
.sub a.soc-a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 92px; padding: 14px 6px 12px; border: 1px solid var(--rs-rule-strong); background: var(--rs-bg); color: var(--rs-ink); text-decoration: none; transition: background var(--rs-t), color var(--rs-t), border-color var(--rs-t), transform var(--rs-t); }
.sub .soc-a .ic { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--rs-ink); color: var(--rs-bg); transition: background var(--rs-t), color var(--rs-t); }
.sub .soc-a .nm { font: 500 10.5px/1 var(--rs-mono); letter-spacing: .1em; text-transform: uppercase; }
.sub a.soc-a:hover { background: var(--rs-cta-bg); color: var(--rs-cta-fg); border-color: var(--rs-cta-bg); transform: translateY(-2px); }
.sub a.soc-a:hover .ic { background: var(--rs-cta-fg); color: var(--rs-cta-bg); }
.sub a.soc-a:focus-visible { outline: 2px solid var(--rs-focus); outline-offset: 2px; }
@container (min-width: 560px) {
  .sub form, .sub > p { max-width: 560px; }
  .sub a.soc-a { flex-direction: row; justify-content: flex-start; min-height: 64px; padding: 10px 14px; gap: 12px; }
  .sub .soc-a .nm { font-size: 11.5px; }
}
@media (prefers-reduced-motion: reduce) { .sub a.soc-a:hover { transform: none; } }
@media (max-width: 1024px) { .top { grid-template-columns: minmax(0, 1fr); } }

.list-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--rs-s3); padding: var(--rs-s4) 0; border-top: 2px solid var(--rs-rule-ink); }
.list-head h2 { font-size: var(--rs-fs-h3); }
.month { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: var(--rs-gutter); border-top: 1px solid var(--rs-rule-strong); padding: var(--rs-s5) 0 0; }
.month > .m { font-family: var(--rs-mono); font-size: var(--rs-fs-label); letter-spacing: .15em; text-transform: uppercase; color: var(--rs-ink-2); padding-top: var(--rs-s2); position: sticky; top: calc(var(--hdr) + 72px); align-self: start; }
.row-card { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--rs-s5); text-decoration: none; padding: 0 0 var(--rs-s5); margin-bottom: var(--rs-s5); border-bottom: 1px solid var(--rs-rule); transition: transform var(--rs-t); }
.rows > .row-card:last-child { border-bottom: 0; }
.row-card:hover { transform: translateX(2px); }
.row-card .cover { aspect-ratio: 16/9; overflow: hidden; background: var(--rs-paper-2); border: 1px solid var(--rs-rule); }
.row-card .cover img { width: 100%; height: 100%; object-fit: cover; }
.row-card h3 { font-size: var(--rs-fs-row); line-height: 1.25; margin: var(--rs-s2) 0; }
.row-card:hover h3 { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
.row-card .sum { margin: 0 0 var(--rs-s3); font-size: var(--rs-fs-small); line-height: 1.55; color: var(--rs-ink-2); max-width: 70ch; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.row-card .meta { font-size: 12px; }
@media (max-width: 1024px) { .month { grid-template-columns: minmax(0, 1fr); gap: var(--rs-s4); } .month > .m { position: static; } }
@media (max-width: 640px) { .row-card { grid-template-columns: minmax(0, 1fr); gap: var(--rs-s3); } .row-card:hover { transform: none; } }

.empty { border: 1px dashed var(--rs-rule-strong); padding: var(--rs-s8) var(--rs-s5); text-align: center; margin: var(--rs-s6) 0; }
.empty h3 { font-size: var(--rs-fs-h3); margin: var(--rs-s3) 0; }
.empty p { color: var(--rs-ink-2); max-width: 48ch; margin: 0 auto var(--rs-s5); font-size: var(--rs-fs-small); }

.nl { margin: var(--rs-s8) 0 0; border-top: 2px solid var(--rs-rule-ink); padding-top: var(--rs-s6); display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: var(--rs-s5) var(--rs-gutter); align-items: end; }
.nl h2 { font-size: var(--rs-fs-h2); line-height: 1.15; margin: var(--rs-s3) 0; }
.nl p { color: var(--rs-ink-2); font-size: var(--rs-fs-small); max-width: 56ch; line-height: 1.55; }
.nl .acts { display: flex; gap: var(--rs-s3); flex-wrap: wrap; }
@media (max-width: 900px) { .nl { grid-template-columns: minmax(0, 1fr); } }

/* ---------- report ---------- */
.rs-progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 1100; pointer-events: none; }
.rs-progress > div { height: 100%; width: 100%; transform-origin: 0 50%; transform: scaleX(0); background: var(--rs-green); }
html[data-theme="dark"] .rs-progress > div { background: var(--rs-gold); }
.rp-crumb { padding-top: var(--rs-s5); font-family: var(--rs-mono); font-size: var(--rs-fs-label); letter-spacing: .12em; text-transform: uppercase; }
.rp-crumb a { color: var(--rs-ink-2); text-decoration: none; }
.rp-crumb a:hover { color: var(--rs-ink); }
.rp-hero { padding: var(--rs-s6) 0; }
.rp-hero .inner { max-width: 820px; }
.rp-hero h1 { font-size: var(--rs-fs-h1); line-height: 1.08; margin: var(--rs-s3) 0 var(--rs-s4); overflow-wrap: break-word; }
.rp-hero .sub { font-size: var(--rs-fs-lead); line-height: 1.5; color: var(--rs-ink-2); margin: 0 0 var(--rs-s5); max-width: 40em; }
.rp-hero .meta { padding: var(--rs-s3) 0; border-top: 1px solid var(--rs-rule-ink); border-bottom: 1px solid var(--rs-rule-strong); }
.rp-hero .meta .sep { color: var(--rs-ink-3); }
.rp-hero .tags { margin-top: var(--rs-s3); }
.rp-hero .actions { display: flex; align-items: center; gap: var(--rs-s2); flex-wrap: wrap; margin-top: var(--rs-s4); }
.disc-line { font-family: var(--rs-mono); font-size: 12px; line-height: 1.55; color: var(--rs-ink-2); margin-top: var(--rs-s4); display: flex; gap: 10px; align-items: stretch; max-width: 72ch; }
.disc-line::before { content: ""; flex: 0 0 3px; background: var(--rs-gold); }
.disc-line a { color: var(--rs-green-text); text-underline-offset: 3px; white-space: nowrap; }
.rp-cover { margin: var(--rs-s6) 0 0; max-width: 1000px; }
.rp-cover img { width: 100%; aspect-ratio: 16/9; object-fit: cover; border: 1px solid var(--rs-rule); }
figcaption.cap { font-family: var(--rs-mono); font-size: var(--rs-fs-label); letter-spacing: .02em; line-height: 1.5; color: var(--rs-ink-2); padding-top: var(--rs-s2); }
figcaption.cap .cap-k { color: var(--rs-ink); font-weight: 500; }
figcaption.cap .cap-src { color: var(--rs-ink-3); }

.rp-layout { display: grid; grid-template-columns: minmax(0, var(--rs-measure)) 240px; gap: var(--rs-s9); justify-content: start; padding-top: var(--rs-s6); }
.rp-aside { position: sticky; top: calc(var(--hdr) + 28px); align-self: start; max-height: calc(100vh - var(--hdr) - 48px); overflow: auto; scrollbar-width: thin; }
.toc .toc-h { font-family: var(--rs-mono); font-size: var(--rs-fs-label); letter-spacing: .15em; text-transform: uppercase; color: var(--rs-ink-2); margin: 0 0 var(--rs-s3); font-weight: 500; }
.toc ol { list-style: none; padding: 0; }
.toc li a { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 6px; padding: 8px 0; border-top: 1px solid var(--rs-rule); text-decoration: none; font-family: var(--rs-mono); font-size: 12.5px; line-height: 1.45; color: var(--rs-ink-2); transition: color var(--rs-t); }
.toc li:last-child a { border-bottom: 1px solid var(--rs-rule); }
.toc li a .n { color: var(--rs-ink-3); }
.toc li a:hover { color: var(--rs-ink); }
.toc li a[aria-current="location"] { color: var(--rs-ink); font-weight: 500; }
.toc li a[aria-current="location"] .n { color: var(--rs-gold-text); }
.toc .lk { display: inline-flex; vertical-align: -2px; margin-left: 4px; color: var(--rs-ink-3); }
.rp-aside .toc-cta { margin-top: var(--rs-s5); font-family: var(--rs-mono); font-size: 12px; line-height: 1.5; color: var(--rs-ink-2); }
.rp-aside .toc-cta a { color: var(--rs-green-text); text-underline-offset: 3px; }
.toc-mobile { display: none; }
@media (max-width: 1024px) { .rp-layout { gap: var(--rs-s7); grid-template-columns: minmax(0, 1fr) 220px; } }
@media (max-width: 900px) {
  .rp-layout { grid-template-columns: minmax(0, 1fr); padding-top: var(--rs-s5); }
  .rp-aside { display: none; }
  .toc-mobile { display: block; position: sticky; top: var(--hdr); z-index: 40; background: color-mix(in oklab, var(--rs-bg) 94%, transparent); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); border-top: 1px solid var(--rs-rule-ink); border-bottom: 1px solid var(--rs-rule-strong); margin-bottom: var(--rs-s5); }
  .toc-mobile summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 44px; font-family: var(--rs-mono); font-size: var(--rs-fs-label); letter-spacing: .15em; text-transform: uppercase; color: var(--rs-ink); font-weight: 500; }
  .toc-mobile summary::-webkit-details-marker { display: none; }
  .toc-mobile summary::after { content: "+"; font-size: 18px; }
  .toc-mobile[open] summary::after { content: "\\2212"; }
  .toc-mobile .toc { padding: 0 0 var(--rs-s3); }
  .toc-mobile .toc .toc-h { display: none; }
  .toc-mobile .toc ol { max-height: 50vh; overflow: auto; }
}

.rp-body { min-width: 0; }
.rp-body > * { max-width: var(--rs-measure); }
.rp-sec > p, .rp-sec > ul, .rp-sec .fade p { max-width: var(--rs-text); }
html[lang="en"] { --rs-text: 590px; }
.rp-body p { margin: 0 0 1.15em; font-size: var(--rs-fs-body); line-height: var(--rs-lh); overflow-wrap: break-word; }
.rp-body p a { color: var(--rs-green-text); text-underline-offset: 3px; word-break: break-word; }
.rp-body strong { font-weight: 600; }
.takeaways { border-top: 2px solid var(--rs-rule-ink); border-bottom: 1px solid var(--rs-rule-ink); padding: var(--rs-s4) 0 var(--rs-s2); margin: 0 0 var(--rs-s7); }
.takeaways .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--rs-s2); }
.takeaways ol { list-style: none; padding: 0; counter-reset: tk; }
.takeaways li { counter-increment: tk; display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--rs-s3); padding: var(--rs-s3) 0; border-top: 1px solid var(--rs-rule); font-size: 16px; line-height: 1.5; }
.takeaways li:first-child { border-top: 0; }
.takeaways li::before { content: counter(tk, decimal-leading-zero); font-family: var(--rs-mono); font-size: 12px; font-weight: 500; color: var(--rs-gold-text); padding-top: 4px; letter-spacing: .05em; }
.rp-sec { padding-top: var(--rs-s6); margin-top: var(--rs-s6); scroll-margin-top: calc(var(--hdr) + 24px); }
.rp-sec.first { margin-top: 0; padding-top: 0; }
.rp-sec .sec-num { font-family: var(--rs-mono); display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--rs-s3); font-size: 12px; letter-spacing: .15em; color: var(--rs-gold-text); font-weight: 500; margin-bottom: var(--rs-s3); text-transform: uppercase; }
.rp-sec .sec-num .sec-lbl { color: var(--rs-ink-2); }
.rp-body h2 { font-size: var(--rs-fs-h2); line-height: 1.18; margin: 0 0 var(--rs-s4); overflow-wrap: break-word; }
figure.chart { margin: var(--rs-s5) 0 var(--rs-s6); }
figure.chart button { display: block; width: 100%; padding: 0; border: 1px solid var(--rs-rule-strong); background: var(--rs-paper-2); cursor: zoom-in; position: relative; overflow: hidden; }
figure.chart button .hint { position: absolute; right: 8px; bottom: 8px; font: 500 10px/1 var(--rs-mono); letter-spacing: .12em; text-transform: uppercase; background: var(--rs-cta-bg); color: var(--rs-cta-fg); padding: 6px 8px; opacity: 0; transition: opacity var(--rs-t); }
figure.chart button:hover .hint, figure.chart button:focus-visible .hint { opacity: 1; }
figure.chart img { width: 100%; height: auto; }
.tbl-wrap { margin: var(--rs-s5) 0 var(--rs-s6); font-family: var(--rs-mono); }
.tbl-scroll { overflow: auto; max-height: 420px; -webkit-overflow-scrolling: touch; border-top: 2px solid var(--rs-rule-ink); }
.tbl-wrap table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 520px; font-size: 13.5px; }
.tbl-wrap thead th { position: sticky; top: 0; background: var(--rs-bg); text-align: left; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--rs-ink-2); font-weight: 500; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--rs-rule-ink); }
.tbl-wrap td { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--rs-rule); vertical-align: top; text-align: left; font-variant-numeric: tabular-nums; }

.locked .fade { position: relative; max-height: 7.5em; overflow: hidden; }
.locked .fade::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 20%, var(--rs-bg)); }
.locked .figs { margin: var(--rs-s4) 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: var(--rs-s3); }
.locked .fig { overflow: hidden; border: 1px solid var(--rs-rule-strong); background: var(--rs-paper-2); aspect-ratio: 16/7; position: relative; }
.locked .fig img { width: 100%; height: 100%; object-fit: cover; filter: blur(10px) saturate(.5); opacity: .5; transform: scale(1.08); }
.locked .fig span { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); font: 500 11px var(--rs-mono); letter-spacing: .15em; text-transform: uppercase; color: var(--rs-ink); background: var(--rs-bg); border: 1px solid var(--rs-rule-ink); padding: 8px 12px; white-space: nowrap; }
.gate { border-top: 2px solid var(--rs-rule-ink); padding: var(--rs-s5) 0 0; margin: var(--rs-s4) 0 0; display: grid; gap: var(--rs-s3); }
.gate .k { font-family: var(--rs-mono); display: inline-flex; align-items: center; gap: 8px; font-size: var(--rs-fs-label); letter-spacing: .15em; text-transform: uppercase; color: var(--rs-gold-text); font-weight: 500; }
.gate h3 { font-size: var(--rs-fs-h3); }
.gate p { margin: 0; font-size: var(--rs-fs-small); color: var(--rs-ink-2); line-height: 1.5; }
.gate .row { display: flex; gap: var(--rs-s3) var(--rs-s4); align-items: center; flex-wrap: wrap; margin-top: var(--rs-s2); }
.gate .fine { font-family: var(--rs-mono); font-size: 11px; color: var(--rs-ink-3); }

.cta-mid { margin: var(--rs-s7) 0; padding: var(--rs-s5); background: var(--rs-paper); border-left: 2px solid var(--rs-green); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--rs-s4) var(--rs-s6); align-items: center; }
html[data-theme="dark"] .cta-mid { border-left-color: var(--rs-gold); }
.cta-mid h3 { font-size: var(--rs-fs-h3); margin: var(--rs-s2) 0; }
.rp-body .cta-mid p { margin: 0; font-size: var(--rs-fs-small); color: var(--rs-ink-2); line-height: 1.5; }
.cta-mid .col { display: grid; gap: var(--rs-s2); justify-items: start; }
@media (max-width: 640px) { .cta-mid { grid-template-columns: minmax(0, 1fr); } }

.cta-final { margin: var(--rs-s8) 0 0; border-top: 2px solid var(--rs-rule-ink); padding-top: var(--rs-s6); }
.cta-final h2 { font-size: var(--rs-fs-h2); line-height: 1.15; margin: var(--rs-s3) 0; }
.rp-body .cta-final p { color: var(--rs-ink-2); margin: 0 0 var(--rs-s4); font-size: var(--rs-fs-small); max-width: 56ch; line-height: 1.55; }
.cta-final .acts { display: flex; gap: var(--rs-s3); flex-wrap: wrap; align-items: center; }
.lead { margin-top: var(--rs-s6); padding-top: var(--rs-s5); border-top: 1px solid var(--rs-rule-strong); }
.lead h3 { font-size: 19px; margin: var(--rs-s2) 0; }
.lead form { display: grid; gap: var(--rs-s3); max-width: 520px; margin-top: var(--rs-s3); }
.lead .field { display: flex; gap: var(--rs-s2); border-bottom: 1px solid var(--rs-rule-ink); padding-bottom: 4px; }
.lead input[type=email] { flex: 1; min-width: 0; background: transparent; border: 0; font: 400 15px var(--rs-mono); color: var(--rs-ink); padding: 8px 0; outline: none; }
.lead input[type=email]::placeholder { color: var(--rs-ink-3); opacity: 1; }
.lead .submit { background: transparent; border: 0; color: var(--rs-ink); cursor: pointer; font: 600 11px var(--rs-mono); letter-spacing: .12em; text-transform: uppercase; min-height: 40px; padding: 0 4px; }
.lead .submit:disabled { opacity: .5; cursor: not-allowed; }
.lead .consent { display: flex; gap: 10px; align-items: flex-start; font-family: var(--rs-mono); font-size: 11.5px; color: var(--rs-ink-2); line-height: 1.5; }
.lead .consent input { margin-top: 2px; flex-shrink: 0; width: 16px; height: 16px; accent-color: var(--rs-green); }
.lead .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.lead .msg { font-family: var(--rs-mono); font-size: 12px; padding: 10px 12px; border: 1px solid; }
.lead .msg.ok { color: var(--rs-green-text); border-color: var(--rs-green); }
.lead .msg.err { color: var(--rs-ink); border-color: #c0392b; }

.trust { font-family: var(--rs-mono); border-top: 1px solid var(--rs-rule-strong); margin-top: var(--rs-s7); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--rs-s4) var(--rs-s6); padding-top: var(--rs-s4); font-size: 12.5px; line-height: 1.55; color: var(--rs-ink-2); }
.trust .k { display: block; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--rs-ink-2); margin-bottom: 4px; }
.trust strong { color: var(--rs-ink); font-weight: 600; }
.trust a { color: var(--rs-green-text); text-underline-offset: 3px; }
.trust .disc { grid-column: 1 / -1; border-left: 3px solid var(--rs-gold); padding-left: var(--rs-s3); }
@media (max-width: 640px) { .trust { grid-template-columns: minmax(0, 1fr); } }

.pn { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--rs-gutter); border-top: 2px solid var(--rs-rule-ink); margin-top: var(--rs-s8); padding-top: var(--rs-s5); }
.pn a { text-decoration: none; display: grid; gap: var(--rs-s2); color: var(--rs-ink); align-content: start; }
.pn .nx { text-align: right; grid-column: 2; }
.pn .k { font-family: var(--rs-mono); font-size: var(--rs-fs-label); letter-spacing: .14em; text-transform: uppercase; color: var(--rs-ink-2); }
.pn .t { font-family: var(--rs-serif); font-weight: 600; font-size: var(--rs-fs-h3); line-height: 1.25; }
.pn a:hover .t { text-decoration: underline; text-underline-offset: 3px; }
.pn .d { font-family: var(--rs-mono); font-size: 12px; color: var(--rs-ink-2); }
@media (max-width: 640px) { .pn { grid-template-columns: minmax(0, 1fr); } .pn .nx { grid-column: 1; text-align: left; border-top: 1px solid var(--rs-rule-strong); padding-top: var(--rs-s4); } }
.related { margin-top: var(--rs-s7); }
.related .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--rs-gutter); padding-top: var(--rs-s5); border-top: 1px solid var(--rs-rule-strong); }
.related .rc { text-decoration: none; display: grid; gap: var(--rs-s2); align-content: start; }
.related .rc .cover { aspect-ratio: 16/9; overflow: hidden; border: 1px solid var(--rs-rule); background: var(--rs-paper-2); margin-bottom: var(--rs-s2); }
.related .rc .cover img { width: 100%; height: 100%; object-fit: cover; }
.related .rc h3 { font-size: 20px; line-height: 1.25; }
.related .rc:hover h3 { text-decoration: underline; text-underline-offset: 3px; }
.related .rc .meta { font-size: 12px; }
@media (max-width: 900px) { .related .grid { grid-template-columns: minmax(0, 1fr); } .related .rc { grid-template-columns: 160px minmax(0, 1fr); column-gap: var(--rs-s4); } .related .rc .cover { grid-row: 1 / span 2; margin: 0; } }
@media (max-width: 640px) { .related .rc { grid-template-columns: 112px minmax(0, 1fr); } .related .rc h3 { font-size: 17px; } }

.rs-banner { position: fixed; left: 0; right: 0; bottom: 0; z-index: 900; background: var(--rs-cta-bg); color: var(--rs-cta-fg); display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px var(--rs-s4); padding: 10px var(--rs-pad); font-family: var(--rs-mono); font-size: 13px; line-height: 1.4; }
.rs-banner a { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.rs-banner button { background: transparent; border: 1px solid currentColor; color: inherit; font: 500 11px var(--rs-mono); letter-spacing: .1em; text-transform: uppercase; padding: 6px 10px; cursor: pointer; min-height: 32px; opacity: .85; }
@media (min-width: 1024px) { .rs-banner { left: auto; right: 24px; bottom: 24px; max-width: 440px; padding: 12px 16px; justify-content: flex-start; } }

dialog.rs-lb { border: 0; padding: 0; background: transparent; max-width: min(96vw, 1400px); width: auto; }
dialog.rs-lb::backdrop { background: rgba(10,10,10,.82); }
dialog.rs-lb figure { background: var(--rs-bg); border: 1px solid var(--rs-rule-strong); padding: var(--rs-s3); }
dialog.rs-lb img { max-height: 82vh; width: auto; max-width: 100%; margin: 0 auto; display: block; }
dialog.rs-lb figcaption { display: flex; justify-content: space-between; gap: var(--rs-s4); align-items: center; padding-top: var(--rs-s3); font-family: var(--rs-mono); font-size: var(--rs-fs-label); color: var(--rs-ink-2); }
dialog.rs-lb .lb-close { font: 600 11px var(--rs-mono); letter-spacing: .12em; text-transform: uppercase; background: var(--rs-cta-bg); color: var(--rs-cta-fg); border: 0; padding: 10px 14px; cursor: pointer; flex: 0 0 auto; }

.nf { max-width: 720px; padding: var(--rs-s9) 0; }
.nf h1 { font-size: var(--rs-fs-h1); line-height: 1.1; margin: var(--rs-s3) 0 var(--rs-s4); }
.nf p { color: var(--rs-ink-2); margin-bottom: var(--rs-s5); }
@media print { .rs-banner, .rs-progress, .rp-aside, .toc-mobile, .cta-mid, .lead, #bf-site-header, #bf-site-footer { display: none !important; } }
`;
