// Build REPLAY DESK into _site/ (static, GitHub Pages ready): copies site/ and data/,
// validates every data file, and stamps a build id into index.html.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '_site');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'site'), out, { recursive: true });
mkdirSync(join(out, 'data'));

const manifest = JSON.parse(readFileSync(join(root, 'data/manifest.json'), 'utf8'));
const files = ['manifest.json', 'headlines.json', ...Object.values(manifest.products).map((p) => p.file)];
for (const f of files) {
  const text = readFileSync(join(root, 'data', f), 'utf8');
  JSON.parse(text); // throws on invalid JSON (e.g. a bad hand edit of headlines.json)
  writeFileSync(join(out, 'data', f), text);
}
const headlines = JSON.parse(readFileSync(join(root, 'data/headlines.json'), 'utf8')).headlines;
for (const h of headlines) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date) || !/^\d{2}:\d{2}$/.test(h.time) || !h.headline) {
    throw new Error(`headlines.json: bad entry ${JSON.stringify(h)}`);
  }
  if (h.class !== 'real' && h.class !== 'noise') throw new Error(`headlines.json: entry needs "class": "real" | "noise": ${h.date} ${h.time} ${h.headline}`);
  if (h.class === 'noise' && h.implies !== 'up' && h.implies !== 'down') throw new Error(`headlines.json: noise entry needs "implies": "up" | "down": ${h.date} ${h.time}`);
  if (/noise|herring/i.test(h.headline)) throw new Error(`headlines.json: headline text hints at its class: ${h.headline}`);
}

let sha = 'local';
try { sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }
const buildId = `${sha}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
const indexPath = join(out, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('__BUILD_ID__', buildId));
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, 'version.json'), JSON.stringify({ sha: process.env.GITHUB_SHA || sha, build: buildId, products: Object.keys(manifest.products), failed: manifest.failed }, null, 2));

console.log(`REPLAY DESK built into _site/ (build ${buildId}); data files: ${readdirSync(join(out, 'data')).join(', ')}`);
if (Object.keys(manifest.failed || {}).length) console.warn(`Products missing (download failed): ${Object.keys(manifest.failed).join(', ')}`);
