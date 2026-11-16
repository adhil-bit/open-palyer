// Copies the web player (../app) into www/ and adds hls.js plus the desktop bridge flag.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons']) cpSync(`../app/${f}`, `www/${f}`, { recursive: true });
cpSync('node_modules/hls.js/dist/hls.light.min.js', 'www/hls.js');
const html = readFileSync('www/index.html', 'utf8')
  .replace('<script src="app.js" type="module"></script>', '<script src="hls.js"></script>\n  <script src="app.js" type="module"></script>');
if (!html.includes('hls.js')) throw new Error('Could not add hls.js to index.html');
writeFileSync('www/index.html', html);
console.log('www/ ready');
