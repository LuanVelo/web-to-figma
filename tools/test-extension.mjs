/**
 * Testa o caminho da extensao sem precisar do Chrome com a extensao instalada.
 *
 * Reproduz exatamente o que collect.js faz: injeta o extractor na pagina,
 * chama captureDocument e delega o download das imagens para fora do contexto
 * da pagina — que e o papel do background script na extensao real.
 *
 * O resultado sai no mesmo formato .w2f que o plugin consome, entao da para
 * jogar direto no simulador.
 *
 *   node tools/test-extension.mjs <url> [saida.w2f]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.argv[2];
const outFile = process.argv[3];
if (!url) {
  console.error('uso: node tools/test-extension.mjs <url> [saida.w2f]');
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

// Faz o papel do background script: busca sem as restricoes da pagina.
await page.exposeFunction('__w2fFetchImage', async (src) => {
  try {
    if (src.startsWith('data:')) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(src);
      if (!match) return null;
      const [, mime, isBase64, payload] = match;
      if (/svg/i.test(mime)) {
        return { mime: 'image/svg+xml', svg: Buffer.from(payload, isBase64 ? 'base64' : 'utf8').toString('utf8') };
      }
      return isBase64 ? { mime, data: payload } : null;
    }

    const response = await context.request.get(src, { timeout: 15000 });
    if (!response.ok()) return { error: `HTTP ${response.status()}` };

    const buffer = await response.body();
    if (buffer.length > 4 * 1024 * 1024) return { error: 'imagem grande demais' };

    const head = buffer.toString('ascii', 0, 200).trim();
    const declared = (response.headers()['content-type'] || '').split(';')[0];
    if (/svg/i.test(declared) || head.startsWith('<svg')) {
      return { mime: 'image/svg+xml', svg: buffer.toString('utf8') };
    }

    const sig = [...buffer.subarray(0, 12)];
    const isPng = sig[0] === 0x89 && sig[1] === 0x50;
    const isJpg = sig[0] === 0xff && sig[1] === 0xd8;
    const isGif = sig[0] === 0x47 && sig[1] === 0x49;
    const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : isWebp ? 'image/webp' : null;
    if (!mime) return { error: 'formato nao reconhecido' };

    return { mime, data: buffer.toString('base64') };
  } catch (err) {
    return { error: String(err.message || err).slice(0, 100) };
  }
});

// Idem para folhas de estilo de outro dominio.
await page.exposeFunction('__w2fFetchText', async (href) => {
  try {
    const response = await context.request.get(href, { timeout: 15000 });
    if (!response.ok()) return null;
    return (await response.text()).slice(0, 2_000_000);
  } catch (err) {
    return null;
  }
});

console.log(`\nabrindo ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

// Mesmo arquivo que a extensao empacota.
await page.evaluate(fs.readFileSync(path.join(__dirname, '..', 'extension', 'extractor.js'), 'utf8'));

const started = Date.now();

const payload = await page.evaluate(async () => {
  const logs = [];
  const result = await window.__W2F.captureDocument({
    simplify: 'empty',
    onProgress: (label) => logs.push(label),
    fetchImage: (src) => window.__w2fFetchImage(src),
    fetchText: (href) => window.__w2fFetchText(href),
  });
  result.logs = logs;
  return result;
});

await browser.close();

// ------------------------------------------------------------- validacao

const doc = payload.docs[0];
const images = Object.values(doc.images);
const ok = images.filter((i) => i.data || i.svg).length;

let nodes = 0;
let texts = 0;
(function walk(node) {
  nodes++;
  if (node.t === 'TEXT') texts++;
  for (const child of node.children || []) walk(child);
})(doc.tree);

console.log(`\nviewport capturado: ${doc.viewport}px  ·  página ${doc.tree.w}x${Math.round(doc.tree.h)}`);
console.log(`nós: ${nodes} (${texts} textos)  ·  elementos visitados: ${doc.meta.stats.elements}`);
console.log(`imagens: ${ok}/${images.length}  ·  fontes: ${doc.fonts.length}  ·  cssVars: ${doc.cssVars.length}`);
console.log(`tempo: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`etapas reportadas: ${payload.logs.length}`);

const problems = [];
if (!nodes || nodes < 10) problems.push('árvore vazia ou pequena demais');
if (!doc.tree.w || !doc.tree.h) problems.push('página sem dimensões');
if (images.length && ok === 0) problems.push('nenhuma imagem foi baixada');
if (!doc.fonts.length) problems.push('nenhuma fonte coletada');

const file = outFile || path.join(process.cwd(), `${new URL(url).hostname.replace(/^www\./, '')}-${doc.viewport}px.w2f`);
delete payload.logs;
fs.writeFileSync(file, JSON.stringify(payload));
console.log(`\narquivo: ${file} (${Math.round(fs.statSync(file).size / 1048576 * 10) / 10}MB)`);

if (problems.length) {
  console.log('\n✗ ' + problems.join('\n✗ ') + '\n');
  process.exit(1);
}

console.log('\n✓ captura válida\n');
