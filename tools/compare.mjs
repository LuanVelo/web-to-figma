/**
 * Comparacao visual: preview da conversao x pagina original, lado a lado.
 *
 *   node tools/compare.mjs <preview.png> <real.png> <saida.png> [faixaY] [altura]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [previewFile, realFile, outFile, yRaw, hRaw] = process.argv.slice(2);
if (!previewFile || !realFile || !outFile) {
  console.error('uso: node tools/compare.mjs <preview.png> <real.png> <saida.png> [faixaY] [altura]');
  process.exit(1);
}

const offsetY = Number(yRaw) || 0;
const height = Number(hRaw) || 1200;

const asDataUri = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; background:#111; font:12px/1 Inter, sans-serif; color:#fff; display:flex; }
  section { flex:1; }
  h2 { margin:0; padding:8px 12px; background:#222; font-size:13px; font-weight:600; }
  .frame { height:${height}px; overflow:hidden; position:relative; }
  .frame img { position:absolute; top:${-offsetY}px; left:0; width:100%; display:block; }
</style>
<section><h2>convertido (o que vai para o Figma)</h2><div class="frame"><img src="${asDataUri(previewFile)}"></div></section>
<section><h2>original</h2><div class="frame"><img src="${asDataUri(realFile)}"></div></section>`;

const tmp = outFile.replace(/\.png$/, '.compare.html');
fs.writeFileSync(tmp, html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: height + 30 } });
await page.goto('file://' + path.resolve(tmp));
await page.waitForTimeout(500);
await page.screenshot({ path: outFile });
await browser.close();
fs.unlinkSync(tmp);

console.log('comparacao:', outFile);
