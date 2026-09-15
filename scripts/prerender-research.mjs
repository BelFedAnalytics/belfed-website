#!/usr/bin/env node
/**
 * Prerenders the public /research/ surface into this repository so GitHub Pages
 * can serve it as plain static HTML.
 *
 * Why static: both belfed.ru and belfed.com resolve straight to GitHub Pages, so
 * there is no proxy layer that could forward /research/ to the Supabase edge
 * function. The Supabase gateway also sends a locked-down CSP on function
 * responses, which makes serving those URLs to browsers directly unusable.
 *
 * What it writes:
 *   research/index.html            <- the public report index
 *   research/<slug>/index.html     <- one page per public report
 *   sitemap.xml                    <- research URLs inside a managed block
 *
 * Everything is fetched first and validated before a single file is touched, so
 * a failing edge function leaves the committed site untouched instead of
 * publishing empty pages.
 *
 * Env:
 *   RESEARCH_LANG   "ru" | "en"                (required)
 *   SITE_ORIGIN     "https://belfed.ru" | ...  (required)
 *   FUNCTIONS_BASE  override for the edge base (optional)
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const LANG = (process.env.RESEARCH_LANG || "").trim();
const ORIGIN = (process.env.SITE_ORIGIN || "").trim().replace(/\/$/, "");
const FN_BASE = (process.env.FUNCTIONS_BASE || "https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1").replace(/\/$/, "");

if (LANG !== "ru" && LANG !== "en") die("RESEARCH_LANG must be 'ru' or 'en'");
if (!/^https:\/\/[a-z0-9.-]+$/.test(ORIGIN)) die("SITE_ORIGIN must look like https://belfed.ru");

const ROOT = process.cwd();
const RESEARCH_DIR = path.join(ROOT, "research");
const SITEMAP = path.join(ROOT, "sitemap.xml");
const MARK_START = "  <!-- research:start (managed by scripts/prerender-research.mjs) -->";
const MARK_END = "  <!-- research:end -->";

// A real page always carries the closing tag and the canonical link. Anything
// shorter than this is treated as a broken render rather than a valid page.
const MIN_BYTES = 2000;

function die(msg) {
  console.error("prerender-research: " + msg);
  process.exit(1);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return await r.json();
}

async function getHtml(url) {
  const r = await fetch(url, { headers: { accept: "text/html" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  const html = await r.text();
  if (html.length < MIN_BYTES) throw new Error(`GET ${url} -> only ${html.length} bytes`);
  if (!/<\/html>\s*$/i.test(html.trim())) throw new Error(`GET ${url} -> HTML is truncated`);
  if (!/<link rel="canonical"/i.test(html)) throw new Error(`GET ${url} -> no canonical link`);
  return html;
}

function isSafeSlug(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{2,140}$/.test(s);
}

function isoDay(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  // ---- 1. collect everything in memory first
  const list = await getJson(`${FN_BASE}/research-list?limit=200`);
  if (!list || list.ok !== true || !Array.isArray(list.items)) {
    throw new Error("research-list returned an unexpected shape");
  }

  const items = list.items.filter(it => isSafeSlug(it && it.slug));
  const skipped = list.items.length - items.length;
  if (skipped > 0) console.warn(`prerender-research: skipped ${skipped} item(s) with an unusable slug`);

  const pages = new Map(); // relative path -> html
  pages.set("research/index.html", await getHtml(`${FN_BASE}/research-render?lang=${LANG}`));

  for (const it of items) {
    const html = await getHtml(`${FN_BASE}/research-render?lang=${LANG}&slug=${encodeURIComponent(it.slug)}`);
    // The renderer answers 404 with a "not found" shell; make sure we never
    // freeze that into a static page.
    if (/name="robots" content="noindex/i.test(html)) {
      throw new Error(`research-render returned the not-found page for ${it.slug}`);
    }
    pages.set(`research/${it.slug}/index.html`, html);
  }

  // ---- 2. write pages
  await mkdir(RESEARCH_DIR, { recursive: true });
  for (const [rel, html] of pages) {
    const abs = path.join(ROOT, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, html, "utf8");
  }

  // ---- 3. drop slug directories that are no longer public
  const keep = new Set(items.map(it => it.slug));
  let removed = 0;
  for (const entry of await readdir(RESEARCH_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;
    await rm(path.join(RESEARCH_DIR, entry.name), { recursive: true, force: true });
    removed++;
  }

  // ---- 4. sitemap
  if (existsSync(SITEMAP)) {
    let xml = await readFile(SITEMAP, "utf8");
    const usesDetail = xml.includes("<priority>");
    const today = new Date().toISOString().slice(0, 10);

    const urls = [
      {
        loc: `${ORIGIN}/research/`,
        lastmod: items.map(it => isoDay(it.published_public_at) || isoDay(it.report_date)).filter(Boolean).sort().pop() || today,
        changefreq: "daily",
        priority: "0.8",
      },
      ...items.map(it => ({
        loc: `${ORIGIN}/research/${it.slug}/`,
        lastmod: isoDay(it.published_public_at) || isoDay(it.report_date) || today,
        changefreq: "monthly",
        priority: "0.7",
      })),
    ];

    const block = [
      MARK_START,
      ...urls.map(u => {
        const lines = [
          "  <url>",
          `    <loc>${xmlEscape(u.loc)}</loc>`,
          `    <lastmod>${u.lastmod}</lastmod>`,
        ];
        if (usesDetail) {
          lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
          lines.push(`    <priority>${u.priority}</priority>`);
        }
        lines.push("  </url>");
        return lines.join("\n");
      }),
      MARK_END,
    ].join("\n");

    const startIdx = xml.indexOf(MARK_START);
    const endIdx = xml.indexOf(MARK_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      xml = xml.slice(0, startIdx) + block + xml.slice(endIdx + MARK_END.length);
    } else {
      const close = xml.lastIndexOf("</urlset>");
      if (close === -1) throw new Error("sitemap.xml has no </urlset>");
      xml = xml.slice(0, close) + block + "\n" + xml.slice(close);
    }
    await writeFile(SITEMAP, xml, "utf8");
  } else {
    console.warn("prerender-research: no sitemap.xml in this repo, skipping sitemap update");
  }

  console.log(`prerender-research: lang=${LANG} pages=${pages.size} reports=${items.length} removed_dirs=${removed}`);
}

main().catch(e => die(e && e.message ? e.message : String(e)));
