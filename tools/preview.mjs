/**
 * Preview de fidelidade.
 *
 * Redesenha a arvore capturada aplicando as MESMAS regras que o plugin usa
 * (ordem de fills, stroke por dentro, cantos, sombras, ancoragem de texto) e
 * renderiza o resultado em PNG. Colocado lado a lado com o screenshot da
 * pagina original, mostra o que a conversao perdeu — sem precisar abrir o Figma.
 *
 *   node tools/preview.mjs <captura.json> [saida.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const captureFile = process.argv[2];
const outFile = process.argv[3] || captureFile.replace(/\.json$/, '.preview.png');

if (!captureFile) {
  console.error('uso: node tools/preview.mjs <captura.json> [saida.png]');
  process.exit(1);
}

const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
const doc = capture.docs[0];

// --------------------------------------------------------------- helpers

const rgba = (color, opacity = 1) =>
  `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${(color.a != null ? color.a : 1) * opacity})`;

/**
 * Reconstroi o angulo CSS a partir da gradientTransform gerada pelo extractor.
 * Serve de conferencia dupla: se a matriz estiver errada, o gradiente aparece
 * torto aqui exatamente como apareceria no Figma.
 */
function gradientToCss(paint, width, height) {
  const stops = paint.gradientStops
    .map((stop) => `${rgba(stop.color)} ${Math.round(stop.position * 100)}%`)
    .join(', ');

  if (paint.type === 'GRADIENT_RADIAL') return `radial-gradient(circle, ${stops})`;
  if (paint.type === 'GRADIENT_ANGULAR') return `conic-gradient(${stops})`;

  const [ax, ay] = paint.gradientTransform[0];
  // ax = w*sin/L, ay = -h*cos/L  ->  desfaz a normalizacao pela caixa
  const angle = (Math.atan2(ax / (width || 1), -ay / (height || 1)) * 180) / Math.PI;
  return `linear-gradient(${angle.toFixed(1)}deg, ${stops})`;
}

function fillsToCss(spec, images) {
  if (!spec.fills || !spec.fills.length) return '';

  let backgroundColor = '';
  const layers = [];

  // No Figma o indice 0 e a camada de baixo; em CSS a primeira e a de cima.
  for (const fill of spec.fills) {
    if (fill.type === 'SOLID') {
      backgroundColor = `background-color:${rgba(fill.color, fill.opacity)};`;
    } else if (fill.type === 'IMAGE') {
      const image = images[fill.imageId];
      if (image && image.data) {
        layers.push({
          image: `url("data:${image.mime};base64,${image.data}")`,
          size: fill.scaleMode === 'FIT' ? 'contain' : fill.scaleMode === 'TILE' ? 'auto' : 'cover',
        });
      }
    } else if (fill.type.startsWith('GRADIENT')) {
      layers.push({ image: gradientToCss(fill, spec.w, spec.h), size: 'cover' });
    }
  }

  if (!layers.length) return backgroundColor;

  layers.reverse();
  return (
    backgroundColor +
    `background-image:${layers.map((l) => l.image).join(', ')};` +
    `background-size:${layers.map((l) => l.size).join(', ')};` +
    'background-position:center;background-repeat:no-repeat;'
  );
}

function borderToCss(border) {
  if (!border || !border.uniform) return '';
  // strokeAlign INSIDE no Figma == box-sizing border-box no CSS
  return `border:${border.width}px ${border.dashed ? 'dashed' : 'solid'} ${rgba(border.color)};box-sizing:border-box;`;
}

function radiusToCss(radius) {
  return radius ? `border-radius:${radius.map((r) => r + 'px').join(' ')};` : '';
}

function effectsToCss(effects) {
  if (!effects) return '';
  const shadows = effects.map(
    (effect) =>
      `${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread || 0}px ${rgba(effect.color)}`
  );
  return `box-shadow:${shadows.join(', ')};`;
}

// ------------------------------------------------------------- montagem

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * O nome da familia vai dentro de um atributo style="…". Com aspas duplas ele
 * FECHA o atributo, e todo o resto da declaracao (cor, tamanho, line-height,
 * text-transform) e descartado silenciosamente — o preview ficava mostrando
 * texto preto de tamanho padrao e ninguem percebia.
 */
const cssFamily = (family) => `'${String(family || 'Inter').replace(/['\\]/g, '')}', sans-serif`;

/**
 * Reproduz os ranges de estilo do texto — o equivalente ao setRangeFontName
 * que o plugin aplica no Figma.
 */
function renderChars(t) {
  if (!t.ranges || !t.ranges.length) return escapeHtml(t.chars).replace(/\n/g, '<br>');

  const ordered = [...t.ranges].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let html = '';

  for (const range of ordered) {
    if (range.start > cursor) html += escapeHtml(t.chars.slice(cursor, range.start));
    const s = range.style;
    const css =
      `font-weight:${s.weight};font-size:${s.size}px;` +
      (s.italic ? 'font-style:italic;' : '') +
      `font-family:${cssFamily(s.family)};` +
      `color:${rgba(s.color.color, s.color.opacity)};` +
      (s.decoration === 'STRIKETHROUGH' ? 'text-decoration:line-through;' : s.decoration === 'UNDERLINE' ? 'text-decoration:underline;' : '');
    html += `<span style="${css}">${escapeHtml(t.chars.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  }

  if (cursor < t.chars.length) html += escapeHtml(t.chars.slice(cursor));
  return html.replace(/\n/g, '<br>');
}

let nodeCount = 0;

function render(spec, origin) {
  nodeCount++;
  const left = spec.x - origin.x;
  const top = spec.y - origin.y;
  const base = `position:absolute;left:${left}px;top:${top}px;`;

  if (spec.t === 'TEXT') {
    const t = spec.text;
    const transform =
      t.case === 'UPPER' ? 'text-transform:uppercase;'
      : t.case === 'LOWER' ? 'text-transform:lowercase;'
      : t.case === 'TITLE' ? 'text-transform:capitalize;' : '';

    const style =
      base +
      `width:${spec.w}px;` +
      (t.wrap ? '' : 'white-space:nowrap;') +
      `font-family:${cssFamily(t.family)};font-size:${t.size}px;font-weight:${t.weight};` +
      (t.italic ? 'font-style:italic;' : '') +
      (t.lineHeight ? `line-height:${t.lineHeight}px;` : 'line-height:normal;') +
      `letter-spacing:${t.letterSpacing}px;` +
      `color:${rgba(t.color.color, t.color.opacity)};` +
      `text-align:${t.align.toLowerCase()};` +
      (t.decoration === 'UNDERLINE' ? 'text-decoration:underline;' : t.decoration === 'STRIKETHROUGH' ? 'text-decoration:line-through;' : '') +
      transform;

    return `<div style="${style}">${renderChars(t)}</div>`;
  }

  if (spec.t === 'SVG') {
    return `<div style="${base}width:${spec.w}px;height:${spec.h}px;overflow:hidden;">${spec.svg}</div>`;
  }

  if (spec.t === 'IMAGE') {
    const image = doc.images[spec.img.id];
    const box = base + `width:${spec.w}px;height:${spec.h}px;` + radiusToCss(spec.radius);
    if (image && image.data) {
      const fit = spec.img.scaleMode === 'FIT' ? 'contain' : spec.img.scaleMode === 'CROP' ? 'none' : 'cover';
      return `<img src="data:${image.mime};base64,${image.data}" style="${box}object-fit:${fit};" />`;
    }
    if (image && image.svg) {
      return `<div style="${box}">${image.svg}</div>`;
    }
    // Imagem que nao veio: marca em magenta para ficar obvio no preview.
    return `<div style="${box}background:rgba(255,0,255,.25);outline:1px dashed magenta;"></div>`;
  }

  const style =
    base +
    `width:${spec.w}px;height:${spec.h}px;` +
    (spec.clip ? 'overflow:hidden;' : '') +
    (spec.opacity != null ? `opacity:${spec.opacity};` : '') +
    (spec.rotation ? `transform:rotate(${spec.rotation}deg);` : '') +
    fillsToCss(spec, doc.images) +
    borderToCss(spec.border) +
    radiusToCss(spec.radius) +
    effectsToCss(spec.effects);

  const children = (spec.children || []).map((child) => render(child, { x: spec.x, y: spec.y })).join('');
  return `<div style="${style}">${children}</div>`;
}

const body = (doc.tree.children || []).map((child) => render(child, { x: doc.tree.x, y: doc.tree.y })).join('');

const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;}
  /* o frame raiz do Figma tem clipsContent = true */
  body{width:${doc.tree.w}px;height:${doc.tree.h}px;position:relative;overflow:hidden;
       background:${doc.tree.fills && doc.tree.fills[0] ? rgba(doc.tree.fills[0].color, doc.tree.fills[0].opacity) : '#fff'};}
  div{box-sizing:content-box;}
</style>
${body}`;

const htmlFile = outFile.replace(/\.png$/, '.html');
fs.writeFileSync(htmlFile, html);

// ------------------------------------------------------------ screenshot

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: doc.tree.w, height: Math.min(doc.tree.h, 20000) } });
await page.goto('file://' + path.resolve(htmlFile));
await page.waitForTimeout(1200); // deixa as fontes do sistema carregarem
await page.screenshot({ path: outFile, fullPage: true });
await browser.close();

console.log(`preview: ${outFile}`);
console.log(`${nodeCount} nos redesenhados a partir de ${path.basename(captureFile)}`);
