/**
 * Download das imagens referenciadas pela pagina.
 *
 * Usa o request context do proprio Playwright, entao herda cookies, referer e
 * headers da sessao — imagens protegidas por hotlink continuam funcionando.
 */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB por imagem
const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // teto do payload inteiro
const CONCURRENCY = 8;

const MAX_SHOTS = 12; // screenshot e caro: um teto evita pagina cheia de iframe

/**
 * Detecta o formato pelos magic bytes em vez de confiar no content-type —
 * servidores mandam coisas como image/pjpeg, application/octet-stream ou
 * text/plain para arquivos que o Figma aceita sem problema.
 *
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
function sniffImageType(buffer) {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function parseDataUrl(src) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(src);
  if (!match) return null;
  const [, mime, isBase64, payload] = match;
  const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64');
  return { mime, data };
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {Record<string, {src: string, kind: string}>} images
 * @returns {Promise<Record<string, {mime: string, data: string} | {error: string}>>}
 */
export async function downloadImages(context, images) {
  // Entradas kind:'shot' nao tem URL: quem resolve e captureShots().
  const entries = Object.entries(images || {}).filter(([, info]) => info && info.kind !== 'shot');
  const out = {};
  let totalBytes = 0;

  const fetchOne = async ([id, { src }]) => {
    // SVG como data URL e imagem inline nao precisam de rede.
    if (src.startsWith('data:')) {
      const parsed = parseDataUrl(src);
      if (!parsed) {
        out[id] = { error: 'data-url invalida' };
        return;
      }
      if (/svg/i.test(parsed.mime)) {
        out[id] = { mime: 'image/svg+xml', svg: Buffer.from(parsed.data, 'base64').toString('utf8') };
        return;
      }
      out[id] = parsed;
      totalBytes += parsed.data.length;
      return;
    }

    try {
      const response = await context.request.get(src, { timeout: 15000 });
      if (!response.ok()) {
        out[id] = { error: `HTTP ${response.status()}` };
        return;
      }

      const buffer = await response.body();
      if (buffer.length > MAX_IMAGE_BYTES) {
        out[id] = { error: `imagem grande demais (${Math.round(buffer.length / 1024)}KB)` };
        return;
      }
      if (totalBytes + buffer.length > MAX_TOTAL_BYTES) {
        out[id] = { error: 'limite total de imagens atingido' };
        return;
      }

      const declared = (response.headers()['content-type'] || '').split(';')[0].trim();

      // SVG vai como texto: o plugin usa createNodeFromSvg em vez de createImage.
      if (/svg/i.test(declared) || buffer.toString('ascii', 0, 200).trim().startsWith('<svg')) {
        out[id] = { mime: 'image/svg+xml', svg: buffer.toString('utf8') };
        return;
      }

      const mime = sniffImageType(buffer);
      if (!mime) {
        out[id] = { error: `formato nao reconhecido (${declared || 'sem content-type'})` };
        return;
      }

      totalBytes += buffer.length;
      out[id] = { mime, data: buffer.toString('base64') };
    } catch (err) {
      out[id] = { error: String(err.message || err).slice(0, 120) };
    }
  };

  // Pool simples de concorrencia.
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await fetchOne(item);
    }
  });
  await Promise.all(workers);

  return out;
}

/**
 * Fotografa os pedacos de tela que o DOM nao entrega — video sem poster,
 * canvas WebGL, iframe de outro dominio. O extractor marca a regiao com
 * `addShot()`; aqui ela vira um PNG no MESMO formato do download, para o
 * plugin nao precisar saber de onde a imagem veio.
 *
 * Precisa da pagina ainda aberta e com o viewport ja expandido: assim as
 * coordenadas do documento e as do viewport coincidem. Quando a pagina foi
 * truncada (mais alta que o teto do servidor) o recorte sai do modo fullPage,
 * que e mais caro mas alcanca o que ficou abaixo da dobra.
 *
 * @param {import('playwright').Page} page
 * @param {Record<string, {kind: string, rect: {x:number,y:number,w:number,h:number}}>} images
 * @param {{truncated?: boolean, docWidth: number, docHeight: number}} bounds
 */
export async function captureShots(page, images, bounds) {
  const entries = Object.entries(images || {}).filter(([, info]) => info && info.kind === 'shot');
  const out = {};
  if (!entries.length) return out;

  const viewport = page.viewportSize() || { width: bounds.docWidth, height: bounds.docHeight };
  const maxY = bounds.truncated ? bounds.docHeight : viewport.height;

  for (const [id, info] of entries.slice(0, MAX_SHOTS)) {
    const x = Math.max(0, Math.min(info.rect.x, bounds.docWidth));
    const y = Math.max(0, Math.min(info.rect.y, maxY));
    const width = Math.min(info.rect.w - (x - info.rect.x), bounds.docWidth - x);
    const height = Math.min(info.rect.h - (y - info.rect.y), maxY - y);

    if (width < 1 || height < 1) {
      out[id] = { error: 'regiao fora da pagina' };
      continue;
    }

    try {
      // Esconde o que passa por cima da regiao (header, setas do carrossel,
      // overlay de cookie). Sem isso esses elementos entram gravados na foto e
      // ainda chegam como nos por cima dela — cada texto duas vezes no Figma.
      await page.evaluate((shotId) => window.__W2F.beginShot(shotId), id);
      try {
        const buffer = await page.screenshot({
          clip: { x, y, width, height },
          fullPage: !!bounds.truncated,
          timeout: 15000,
        });
        out[id] = { mime: 'image/png', data: buffer.toString('base64') };
      } finally {
        await page.evaluate(() => window.__W2F.endShot());
      }
    } catch (err) {
      out[id] = { error: String(err.message || err).slice(0, 120) };
    }
  }

  for (const [id] of entries.slice(MAX_SHOTS)) {
    out[id] = { error: `limite de ${MAX_SHOTS} capturas de tela atingido` };
  }

  return out;
}
