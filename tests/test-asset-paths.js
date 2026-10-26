/* Offline guard for static page assets, CSS imports, and v2 module imports. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let checked = 0;
function exists(source, reference) {
  if (!reference || /^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
  const clean = reference.split(/[?#]/)[0];
  const target = clean.startsWith('/')
    ? path.join(root, clean.slice(1))
    : path.resolve(path.dirname(source), clean);
  assert.ok(fs.existsSync(target), `${path.relative(root, source)} references missing ${reference}`);
  checked++;
}
function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const pages = ['index.html', 'login.html', 'signup.html', '404.html', 'v2.html', 'version.html', 'mp14u/index.html'];
for (const file of pages.map(file => path.join(root, file))) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) exists(file, match[1]);
}
for (const file of walk(path.join(root, 'assets'))) {
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.css')) {
    for (const match of source.matchAll(/url\(\s*["']([^"']+)["']\s*\)/g)) exists(file, match[1]);
  } else if (file.endsWith('.js')) {
    for (const match of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g)) exists(file, match[1]);
  }
}
const manifestFile = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
for (const icon of manifest.icons) exists(manifestFile, icon.src);
console.log(`Static asset paths passed: ${checked} local references across pages, styles, modules, and manifest.`);
