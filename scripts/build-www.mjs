// Copies the web app (app/) into www/ for the Android build and adds the Capacitor runtime.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const out = 'www';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons']) cpSync(`app/${f}`, `${out}/${f}`, { recursive: true });
const core = 'node_modules/@capacitor/core/dist/capacitor.js';
if (!existsSync(core)) throw new Error('Run npm install first');
cpSync(core, `${out}/capacitor.js`);
const html = readFileSync(`${out}/index.html`, 'utf8')
  .replace('<script src="app.js" type="module"></script>', '<script src="capacitor.js"></script>\n  <script src="app.js" type="module"></script>');
writeFileSync(`${out}/index.html`, html);
console.log('www/ ready');
