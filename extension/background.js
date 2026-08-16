/**
 * Service worker — existe por um motivo só: baixar as imagens.
 *
 * O content script roda com a origem da página, então um fetch para o CDN de
 * imagens esbarra em CORS ou na CSP do site (no stripe.com, isso derruba 100%
 * das imagens). Aqui no background a extensão usa as próprias host_permissions
 * e busca sem essa restrição.
 */

// O Safari expõe `browser`; o Chrome, `chrome`. Os dois entendem este shim.
const api = globalThis.browser ?? globalThis.chrome;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** ArrayBuffer -> base64 (não há Buffer nem FileReader no service worker). */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // evita estourar o limite de argumentos do apply
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Identifica o formato pelos magic bytes — content-type mente com frequência. */
function sniff(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  const ascii = (start, end) => String.fromCharCode.apply(null, bytes.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function fetchImage(url) {
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(url);
    if (!match) return null;
    const [, mime, isBase64, payload] = match;
    if (/svg/i.test(mime)) {
      return { mime: 'image/svg+xml', svg: isBase64 ? atob(payload) : decodeURIComponent(payload) };
    }
    return isBase64 ? { mime, data: payload } : null;
  }

  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) return { error: `HTTP ${response.status}` };

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { error: `imagem grande demais (${Math.round(buffer.byteLength / 1024)}KB)` };
  }

  const bytes = new Uint8Array(buffer);
  const declared = (response.headers.get('content-type') || '').split(';')[0].trim();

  // SVG viaja como texto: o plugin transforma em vetor, não em bitmap.
  const head = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(200, bytes.length)));
  if (/svg/i.test(declared) || head.trim().startsWith('<svg')) {
    return { mime: 'image/svg+xml', svg: new TextDecoder().decode(bytes) };
  }

  const mime = sniff(bytes);
  if (!mime) return { error: `formato nao reconhecido (${declared || 'sem content-type'})` };

  return { mime, data: toBase64(buffer) };
}

/** Busca uma folha de estilo que a página não consegue ler por ser de outro domínio. */
async function fetchText(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return null;
  const text = await response.text();
  return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler =
    message?.type === 'fetchImage' ? fetchImage(message.url)
    : message?.type === 'fetchText' ? fetchText(message.url)
    : null;

  if (!handler) return false;

  handler
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err?.message || err).slice(0, 120) }));

  return true; // resposta assíncrona
});
