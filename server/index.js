/**
 * web-to-figma — servidor de captura.
 *
 * Renderiza uma URL no Chromium, injeta o extractor e devolve uma arvore de
 * layout em JSON, pronta para o plugin do Figma montar no canvas.
 *
 *   GET  /health   -> { ok: true }
 *   POST /import   -> { url, viewports, simplify, waitMs } -> { docs: [...] }
 *   POST /shot     -> { url, viewport } -> { png } (referencia visual, opcional)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBrowser, closeBrowser } from './lib/browser.js';
import { downloadImages, captureShots } from './lib/assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3579;
const VERSION = '1.0.0';

const MAX_PAGE_HEIGHT = 20000;
const DEFAULT_TIMEOUT = 45000;

// O servidor nao deve ficar de pe para sempre: fecha o Chromium logo apos o
// uso e encerra o processo se ninguem aparecer.
const BROWSER_IDLE_MS = 3 * 60 * 1000;
const SHUTDOWN_IDLE_MS = 20 * 60 * 1000;

let lastActivity = Date.now();

// Capturas em andamento. Sem esse contador o varredor de ociosidade fecharia o
// Chromium no meio de uma captura longa — o erro que aparece do outro lado e
// "Target page, context or browser has been closed", sem pista da causa.
let inFlight = 0;

function touch() {
  lastActivity = Date.now();
}

setInterval(async () => {
  if (inFlight > 0) {
    touch(); // trabalho em curso conta como atividade
    return;
  }

  const idle = Date.now() - lastActivity;

  if (idle > SHUTDOWN_IDLE_MS) {
    console.log(`\nsem uso ha ${Math.round(idle / 60000)} min — encerrando.`);
    await closeBrowser();
    process.exit(0);
  }

  if (idle > BROWSER_IDLE_MS) await closeBrowser();
}, 30000).unref();

// Lido a cada request para permitir editar o extractor sem reiniciar o servidor.
const extractorPath = path.join(__dirname, 'extractor.js');

// ---------------------------------------------------------------- captura

/** Rola a pagina inteira para disparar lazy-load e volta ao topo. */
async function triggerLazyLoad(page) {
  await page.evaluate(async () => {
    const step = Math.max(400, window.innerHeight * 0.8);
    const total = document.documentElement.scrollHeight;
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  });
}

async function capture({ url, viewport, simplify, waitMs, colorScheme }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: viewport, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: colorScheme || 'light',
    ignoreHTTPSErrors: true,
    userAgent:
      viewport <= 480
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : undefined,
    isMobile: viewport <= 480,
    hasTouch: viewport <= 480,
  });

  const page = await context.newPage();

  // O browser bloqueia a leitura de folhas de estilo cross-origin (CDN), o que
  // esconderia boa parte dos design tokens. Aqui pegamos o texto do CSS direto
  // da rede e extraimos os nomes das custom properties; os valores sao
  // resolvidos depois, dentro da pagina.
  const cssVarNames = new Set();
  page.on('response', async (response) => {
    try {
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (!type.includes('css')) return;
      const text = await response.text();
      for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) cssVarNames.add(match[1]);
    } catch {
      /* resposta ja descartada ou binaria */
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    // networkidle costuma estourar em sites com polling/analytics — nao e fatal.
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

    await triggerLazyLoad(page);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    if (waitMs) await page.waitForTimeout(Math.min(waitMs, 15000));

    // O extractor entra ANTES do resize: precisamos congelar os elementos
    // fixed enquanto o viewport ainda tem a altura real de uma tela.
    const extractorSource = fs.readFileSync(extractorPath, 'utf8');
    await page.evaluate(extractorSource);
    const frozen = await page.evaluate(() => window.__W2F.freezeFixed());

    // Expande o viewport ate a altura total: a pagina inteira cabe num frame so,
    // sem precisar costurar capturas.
    const fullHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
    );
    const height = Math.min(Math.ceil(fullHeight), MAX_PAGE_HEIGHT);
    await page.setViewportSize({ width: viewport, height });
    await page.waitForTimeout(500); // deixa o relayout assentar

    const result = await page.evaluate((opts) => window.__W2F.extract(opts), {
      simplify,
      // So o servidor consegue fotografar a tela: video, canvas e iframe
      // dependem disso para nao virarem frame vazio.
      allowShots: true,
      extraVarNames: Array.from(cssVarNames).slice(0, 2000),
    });

    const truncated = fullHeight > MAX_PAGE_HEIGHT;
    const [downloaded, shots] = await Promise.all([
      downloadImages(context, result.images),
      captureShots(page, result.images, {
        truncated,
        docWidth: result.meta.width,
        docHeight: result.meta.height,
      }),
    ]);

    return {
      viewport,
      colorScheme: colorScheme || 'light',
      tree: result.tree,
      images: { ...downloaded, ...shots },
      fonts: result.fonts,
      cssVars: result.cssVars,
      meta: { ...result.meta, truncated, frozenFixed: frozen },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function screenshot({ url, viewport }) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: viewport, height: 900 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await triggerLazyLoad(page);
    const buffer = await page.screenshot({ fullPage: true });
    return { png: buffer.toString('base64') };
  } finally {
    await context.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ HTTP

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // A UI do plugin roda num iframe de origem `null` — precisa de CORS aberto.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('corpo da requisicao grande demais'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('informe uma url');
  const trimmed = input.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol); // lanca se for invalida
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('apenas http e https sao suportados');
  return parsed.href;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  touch();

  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, { ok: true, version: VERSION });
  }

  if (req.method === 'POST' && pathname === '/import') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }

    let url;
    try {
      url = normalizeUrl(body.url);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }

    const viewports = (Array.isArray(body.viewports) && body.viewports.length ? body.viewports : [1440])
      .map((v) => Math.max(320, Math.min(3840, Math.round(Number(v)))))
      .filter((v) => Number.isFinite(v))
      .slice(0, 5);

    const simplify = body.simplify === 'none' ? 'none' : 'empty';
    const started = Date.now();

    inFlight++;
    try {
      const docs = [];
      // Sequencial de proposito: paralelizar viewports multiplica o uso de
      // memoria do Chromium em paginas altas.
      for (const viewport of viewports) {
        console.log(`  → capturando ${url} @ ${viewport}px`);
        const doc = await capture({ url, viewport, simplify, waitMs: body.waitMs, colorScheme: body.colorScheme });
        console.log(
          `    ${doc.meta.stats.elements} elementos, ${Object.keys(doc.images).length} imagens, ${doc.meta.height}px de altura`
        );
        docs.push(doc);
      }

      console.log(`✓ concluido em ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
      return send(res, 200, { docs, tookMs: Date.now() - started });
    } catch (err) {
      console.error('✗ falha na captura:', err.message);
      return send(res, 500, { error: String(err.message || err) });
    } finally {
      inFlight--;
      touch();
    }
  }

  if (req.method === 'POST' && pathname === '/shot') {
    inFlight++;
    try {
      const body = await readBody(req);
      const result = await screenshot({
        url: normalizeUrl(body.url),
        viewport: Number(body.viewport) || 1440,
      });
      return send(res, 200, result);
    } catch (err) {
      return send(res, 500, { error: String(err.message || err) });
    } finally {
      inFlight--;
      touch();
    }
  }

  send(res, 404, { error: 'rota nao encontrada' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nweb-to-figma server v${VERSION}`);
  console.log(`escutando em http://localhost:${PORT}`);
  console.log('deixe rodando enquanto usa o plugin no Figma.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nencerrando…');
    await closeBrowser();
    server.close(() => process.exit(0));
  });
}
