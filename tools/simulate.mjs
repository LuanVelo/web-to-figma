/**
 * Simulador da Figma Plugin API.
 *
 * Roda plugin/code.js de verdade, contra uma captura real do servidor, num
 * stub que imita o comportamento do Figma — inclusive as partes chatas:
 * setar `characters` sem a fonte carregada lanca, `resize` recusa NaN,
 * `createImage` recusa bytes que nao sejam de uma imagem conhecida.
 *
 * Nao valida a aparencia final, mas pega quase todo erro de logica antes de
 * abrir o Figma.
 *
 *   node tools/simulate.mjs <captura.json> [--fonts=poucas|muitas]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const captureFile = process.argv[2];
if (!captureFile) {
  console.error('uso: node tools/simulate.mjs <captura.json> [--fonts=poucas|muitas]');
  process.exit(1);
}

const fontMode = (process.argv.find((a) => a.startsWith('--fonts=')) || '').split('=')[1] || 'muitas';

// ----------------------------------------------------------------- stub

const problems = [];
const loadedFonts = new Set();
let idCounter = 0;

// "poucas" simula uma maquina sem as fontes do site instaladas — o caminho
// de fallback e o que mais quebra na pratica.
const INSTALLED =
  fontMode === 'poucas'
    ? { Inter: ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Italic'] }
    : {
        Inter: ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Black', 'Italic', 'Bold Italic'],
        'Open Sans': ['Light', 'Regular', 'Semi Bold', 'Bold', 'Italic'],
        Roboto: ['Regular', 'Medium', 'Bold'],
        Arial: ['Regular', 'Bold'],
        Rubik: ['Regular', 'Medium', 'Bold'],
      };

function checkNumber(label, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${label}: valor nao numerico (${value})`);
    return false;
  }
  return true;
}

class BaseNode {
  constructor(type) {
    this.type = type;
    this.id = 'n' + ++idCounter;
    this.children = [];
    this.parent = null;
    this.name = '';
    this._x = 0;
    this._y = 0;
    this.width = 0.01;
    this.height = 0.01;
    this.fills = [];
    this.strokes = [];
    this.effects = [];
    this.opacity = 1;
  }

  get x() { return this._x; }
  set x(v) { if (checkNumber(`${this.type}.x`, v)) this._x = v; }
  get y() { return this._y; }
  set y(v) { if (checkNumber(`${this.type}.y`, v)) this._y = v; }

  appendChild(node) {
    if (!node) { problems.push('appendChild recebeu null'); return; }
    node.parent = this;
    this.children.push(node);
  }

  resize(w, h) {
    if (!checkNumber(`${this.type}.resize.w`, w) || !checkNumber(`${this.type}.resize.h`, h)) return;
    if (w <= 0 || h <= 0) problems.push(`${this.type}.resize: dimensao <= 0 (${w}x${h})`);
    this.width = w;
    this.height = h;
  }

  set relativeTransform(matrix) {
    const flat = matrix.flat();
    if (flat.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      problems.push(`${this.type}.relativeTransform com valor invalido`);
    }
    this._relativeTransform = matrix;
  }

  set cornerRadius(v) { checkNumber('cornerRadius', v); this._cornerRadius = v; }
  set strokeWeight(v) { checkNumber('strokeWeight', v); this._strokeWeight = v; }
}

class TextNode extends BaseNode {
  constructor() {
    super('TEXT');
    this._fontName = null;
    this._characters = '';
  }

  set fontName(font) {
    if (!font || !font.family || !font.style) { problems.push('fontName malformado'); return; }
    this._fontName = font;
  }
  get fontName() { return this._fontName; }

  set characters(value) {
    // O Figma exige a fonte carregada antes de escrever no no.
    const key = this._fontName ? this._fontName.family + '|' + this._fontName.style : 'nenhuma';
    if (!loadedFonts.has(key)) {
      problems.push(`characters setado com fonte nao carregada: ${key}`);
    }
    if (typeof value !== 'string') problems.push('characters nao e string');
    this._characters = value;
  }
  get characters() { return this._characters; }

  set fontSize(v) {
    if (checkNumber('fontSize', v) && v <= 0) problems.push(`fontSize <= 0 (${v})`);
    this._fontSize = v;
  }
  set lineHeight(v) {
    if (v.unit === 'PIXELS' && !checkNumber('lineHeight', v.value)) return;
    this._lineHeight = v;
  }
  set letterSpacing(v) { checkNumber('letterSpacing', v.value); this._letterSpacing = v; }
  set textAlignHorizontal(v) {
    if (!['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'].includes(v)) problems.push(`textAlignHorizontal invalido: ${v}`);
  }
  set textCase(v) {
    if (!['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'].includes(v)) problems.push(`textCase invalido: ${v}`);
  }
  set textDecoration(v) {
    if (!['NONE', 'UNDERLINE', 'STRIKETHROUGH'].includes(v)) problems.push(`textDecoration invalido: ${v}`);
  }
  set textAutoResize(v) {
    if (!['NONE', 'HEIGHT', 'WIDTH_AND_HEIGHT', 'TRUNCATE'].includes(v)) problems.push(`textAutoResize invalido: ${v}`);
    this._textAutoResize = v;
    // Emula o crescimento automatico: a largura passa a depender do conteudo.
    if (v === 'WIDTH_AND_HEIGHT') {
      const size = this._fontSize || 16;
      this.width = Math.max(1, this._characters.length * size * 0.52);
      this.height = size * 1.2;
    }
  }
  set textStyleId(v) { if (typeof v !== 'string') problems.push('textStyleId nao e string'); }
  set fillStyleId(v) { if (typeof v !== 'string') problems.push('fillStyleId nao e string'); }

  // --- range styling: o Figma valida os limites e a fonte carregada

  _checkRange(method, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      problems.push(`${method}: limites nao inteiros (${start}, ${end})`);
      return false;
    }
    if (start < 0 || end > this._characters.length || start >= end) {
      problems.push(`${method}: range fora do texto (${start}..${end} de ${this._characters.length})`);
      return false;
    }
    return true;
  }

  setRangeFontName(start, end, font) {
    if (!this._checkRange('setRangeFontName', start, end)) return;
    const key = font.family + '|' + font.style;
    if (!loadedFonts.has(key)) problems.push(`setRangeFontName com fonte nao carregada: ${key}`);
    stats.ranges++;
  }
  setRangeFontSize(start, end, size) {
    if (!this._checkRange('setRangeFontSize', start, end)) return;
    if (!(size > 0)) problems.push(`setRangeFontSize invalido: ${size}`);
  }
  setRangeFills(start, end, fills) {
    if (!this._checkRange('setRangeFills', start, end)) return;
    if (!Array.isArray(fills)) problems.push('setRangeFills sem array');
  }
  setRangeTextDecoration(start, end, value) {
    if (!this._checkRange('setRangeTextDecoration', start, end)) return;
    if (!['NONE', 'UNDERLINE', 'STRIKETHROUGH'].includes(value)) problems.push(`decoration invalida: ${value}`);
  }
  setRangeTextCase(start, end, value) {
    if (!this._checkRange('setRangeTextCase', start, end)) return;
    if (!['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'].includes(value)) problems.push(`case invalido: ${value}`);
  }
}

const SIGNATURES = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpeg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46],
};

const stats = { images: 0, imagesRejeitadas: 0, svgs: 0, svgsRejeitados: 0, paintStyles: 0, textStyles: 0, variables: 0, ranges: 0 };

const figma = {
  showUI() {},
  notify(text) { console.log('   notify:', text); },

  createFrame() { return new BaseNode('FRAME'); },
  createRectangle() { return new BaseNode('RECTANGLE'); },
  createText() { return new TextNode(); },

  createImage(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('createImage precisa de Uint8Array');
    const known = Object.values(SIGNATURES).some((sig) => sig.every((b, i) => bytes[i] === b)) ||
      (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF');
    if (!known) {
      stats.imagesRejeitadas++;
      throw new Error('formato de imagem nao suportado');
    }
    stats.images++;
    return { hash: 'hash' + ++idCounter };
  },

  createNodeFromSvg(markup) {
    if (typeof markup !== 'string' || !markup.trim().startsWith('<svg')) {
      stats.svgsRejeitados++;
      throw new Error('svg invalido');
    }
    stats.svgs++;
    return new BaseNode('FRAME');
  },

  createPaintStyle() {
    stats.paintStyles++;
    return { id: 'S:paint' + ++idCounter, set name(v) {}, set paints(v) {} };
  },

  createTextStyle() {
    stats.textStyles++;
    const style = {
      id: 'S:text' + ++idCounter,
      set name(v) {},
      set fontName(font) {
        const key = font.family + '|' + font.style;
        if (!loadedFonts.has(key)) problems.push(`textStyle com fonte nao carregada: ${key}`);
      },
      set fontSize(v) { checkNumber('textStyle.fontSize', v); },
      set lineHeight(v) {},
    };
    return style;
  },

  async listAvailableFontsAsync() {
    const out = [];
    for (const [family, styles] of Object.entries(INSTALLED)) {
      for (const style of styles) out.push({ fontName: { family, style } });
    }
    return out;
  },

  async loadFontAsync(font) {
    const styles = INSTALLED[font.family];
    if (!styles || !styles.includes(font.style)) {
      throw new Error(`fonte indisponivel: ${font.family} ${font.style}`);
    }
    loadedFonts.add(font.family + '|' + font.style);
  },

  variables: {
    createVariableCollection(name) {
      return { name, modes: [{ modeId: 'mode1' }] };
    },
    createVariable(name, collection, type) {
      if (!['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'].includes(type)) throw new Error('tipo invalido: ' + type);
      stats.variables++;
      return {
        setValueForMode(modeId, value) {
          if (type === 'COLOR' && (!value || typeof value.r !== 'number')) throw new Error('cor invalida');
          if (type === 'FLOAT' && typeof value !== 'number') throw new Error('numero invalido');
        },
      };
    },
  },

  currentPage: { children: [], selection: [] },
  viewport: { scrollAndZoomIntoView() {} },
  ui: {
    postMessage(msg) {
      if (msg.type === 'done') console.log('   done:', msg.summary);
      if (msg.type === 'error') problems.push('plugin reportou erro: ' + msg.message);
    },
    onmessage: null,
  },
};

// -------------------------------------------------------------- execucao

const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));

// A UI e quem decodifica base64 -> Uint8Array; replicamos aqui.
for (const doc of capture.docs) {
  const decoded = {};
  for (const [id, image] of Object.entries(doc.images || {})) {
    if (image.data) decoded[id] = { bytes: new Uint8Array(Buffer.from(image.data, 'base64')), mime: image.mime };
    else if (image.svg) decoded[id] = { svg: image.svg };
  }
  doc.images = decoded;
}

const code = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'code.js'), 'utf8');
const context = vm.createContext({ figma, __html__: '<html></html>', console, setTimeout, Promise, Math, Date, Number, String, Object, Array, Uint8Array, parseInt, isFinite });
vm.runInContext(code, context, { filename: 'code.js' });

console.log(`\nsimulando ${path.basename(captureFile)} (fontes instaladas: ${fontMode})\n`);

const started = Date.now();

await figma.ui.onmessage({
  type: 'build',
  docs: capture.docs,
  options: { createStyles: true, createVariables: true },
});

// ------------------------------------------------------------ validacao

function walk(node, depth, seen) {
  seen.count++;
  seen.maxDepth = Math.max(seen.maxDepth, depth);
  seen.byType[node.type] = (seen.byType[node.type] || 0) + 1;

  for (const child of node.children) {
    // Um filho muito fora do pai costuma ser erro de conversao de coordenada.
    if (child.x < -20000 || child.y < -20000 || child.x > 40000 || child.y > 60000) {
      seen.outliers.push(`${child.type} "${child.name}" em (${Math.round(child.x)}, ${Math.round(child.y)})`);
    }
    walk(child, depth + 1, seen);
  }
}

const seen = { count: 0, maxDepth: 0, byType: {}, outliers: [] };
for (const root of figma.currentPage.selection) walk(root, 0, seen);

console.log(`\nnos criados: ${seen.count}  ${JSON.stringify(seen.byType)}`);
console.log(`profundidade maxima: ${seen.maxDepth}`);
console.log(`imagens: ${stats.images} ok, ${stats.imagesRejeitadas} rejeitadas`);
console.log(`svg: ${stats.svgs} ok, ${stats.svgsRejeitados} rejeitados`);
console.log(`styles: ${stats.paintStyles} de cor, ${stats.textStyles} de texto | variaveis: ${stats.variables}`);
console.log(`fontes carregadas: ${Array.from(loadedFonts).join(', ') || 'nenhuma'}`);
console.log(`tempo: ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (seen.outliers.length) {
  console.log(`\ncoordenadas suspeitas (${seen.outliers.length}):`);
  for (const outlier of seen.outliers.slice(0, 5)) console.log('  ' + outlier);
}

const unique = Array.from(new Set(problems));
if (unique.length) {
  console.log(`\n✗ ${problems.length} problemas (${unique.length} distintos):`);
  for (const problem of unique.slice(0, 15)) console.log('  ' + problem);
  process.exit(1);
}

console.log('\n✓ sem problemas de API\n');
