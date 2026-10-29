// Add shared header and footer to user-facing HTML, including generated research.
// Admin tools retain their private workflow navigation. Redirect shells stay lean.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function syncSiteHeader(root = process.cwd()) {
  let count = 0;
  const lang = (await readFile(path.join(root, 'CNAME'), 'utf8')).trim() === 'belfed.ru' ? 'ru' : 'en';
  const tag = `<script src="/belfed-site-header.js" data-lang="${lang}" defer></script>`;
  const footerTag = `<script src="/belfed-site-footer.js" data-lang="${lang}" defer></script>`;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'tests', 'supabase'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.name.endsWith('.html') || entry.name.startsWith('admin')) continue;
      const html = await readFile(file, 'utf8');
      if (/http-equiv=["']refresh/i.test(html) || !/<\/head>/i.test(html)) continue;
      let updated = html.includes('src="/belfed-site-header.js"')
        ? html.replace(/<script src="\/belfed-site-header\.js"[^>]*><\/script>/, tag)
        : html.replace(/<\/head>/i, tag + '\n</head>');
      updated = updated.includes('src="/belfed-site-footer.js"')
        ? updated.replace(/<script src="\/belfed-site-footer\.js"[^>]*><\/script>/, footerTag)
        : updated.replace(/<\/head>/i, footerTag + '\n</head>');
      if (updated === html) continue;
      await writeFile(file, updated);
      count++;
    }
  }
  await walk(root);
  return count;
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  console.log(`Shared header/footer: updated ${await syncSiteHeader()} pages`);
}
