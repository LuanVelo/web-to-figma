/**
 * web-to-figma — thread principal do plugin.
 *
 * Recebe da UI a arvore extraida pelo servidor e monta os nos no canvas.
 * Arquivo unico de proposito: o sandbox do Figma nao suporta import/require
 * sem bundler, e a ideia e nao ter passo de build.
 *
 * Secoes: fontes · imagens · pintura · tokens · construcao · orquestracao
 */

figma.showUI(__html__, { width: 420, height: 620, themeColors: true });

const YIELD_EVERY = 80; // nos entre uma pausa e outra, para a UI nao travar
const STYLE_MIN_USES = 3; // repeticoes minimas para virar um style
const MAX_VARIABLES = 300;

// ============================================================== 1. FONTES

const WEIGHT_CANDIDATES = {
  100: ['Thin', 'Hairline', 'Extra Light', 'Light'],
  200: ['Extra Light', 'ExtraLight', 'Ultra Light', 'Thin', 'Light'],
  300: ['Light', 'Book', 'Regular'],
  400: ['Regular', 'Normal', 'Book', 'Medium'],
  500: ['Medium', 'Regular', 'Semi Bold'],
  600: ['Semi Bold', 'SemiBold', 'Demi Bold', 'DemiBold', 'Bold', 'Medium'],
  700: ['Bold', 'Semi Bold', 'Black'],
  800: ['Extra Bold', 'ExtraBold', 'Ultra Bold', 'Bold', 'Black'],
  900: ['Black', 'Heavy', 'Extra Bold', 'Bold'],
};

const FALLBACK_FAMILY = 'Inter';

/** Arredonda o peso CSS para o degrau de 100 mais proximo. */
function normalizeWeight(weight) {
  const w = Math.round((Number(weight) || 400) / 100) * 100;
  return Math.max(100, Math.min(900, w));
}

/**
 * Resolve cada fonte usada no site para uma fonte que existe neste Figma.
 * Preferimos a familia original; se ela nao estiver instalada, caimos para Inter
 * mantendo o peso — a metrica muda um pouco, mas a hierarquia visual se mantem.
 */
async function buildFontMap(fontSpecs) {
  const available = await figma.listAvailableFontsAsync();

  const stylesByFamily = new Map();
  for (const font of available) {
    const family = font.fontName.family;
    if (!stylesByFamily.has(family)) stylesByFamily.set(family, new Set());
    stylesByFamily.get(family).add(font.fontName.style);
  }

  /** Acha o melhor style disponivel para (familia, peso, italico). */
  function resolveStyle(family, weight, italic) {
    const styles = stylesByFamily.get(family);
    if (!styles) return null;

    const candidates = WEIGHT_CANDIDATES[normalizeWeight(weight)] || ['Regular'];

    if (italic) {
      for (const base of candidates) {
        for (const variant of [base + ' Italic', base + 'Italic']) {
          if (styles.has(variant)) return variant;
        }
      }
      if (styles.has('Italic')) return 'Italic';
    }

    for (const base of candidates) {
      if (styles.has(base)) return base;
    }

    // Ultimo recurso: qualquer style dessa familia.
    return styles.size ? Array.from(styles)[0] : null;
  }

  const map = new Map();
  const toLoad = new Map();

  const fallbackStyle = (weight, italic) =>
    resolveStyle(FALLBACK_FAMILY, weight, italic) || 'Regular';

  for (const spec of fontSpecs) {
    const key = spec.family + '|' + spec.weight + '|' + (spec.italic ? 1 : 0);
    if (map.has(key)) continue;

    let fontName;
    const style = resolveStyle(spec.family, spec.weight, spec.italic);
    if (style) {
      fontName = { family: spec.family, style };
    } else {
      fontName = { family: FALLBACK_FAMILY, style: fallbackStyle(spec.weight, spec.italic) };
    }

    map.set(key, fontName);
    toLoad.set(fontName.family + '|' + fontName.style, fontName);
  }

  // Inter Regular sempre carregada: e o fallback de emergencia.
  const emergency = { family: FALLBACK_FAMILY, style: 'Regular' };
  toLoad.set(FALLBACK_FAMILY + '|Regular', emergency);

  const loaded = new Set();
  await Promise.all(
    Array.from(toLoad.values()).map(async (fontName) => {
      try {
        await figma.loadFontAsync(fontName);
        loaded.add(fontName.family + '|' + fontName.style);
      } catch (err) {
        // Fonte listada mas indisponivel (acontece com fontes da nuvem).
      }
    })
  );

  return {
    /** Devolve uma fonte garantidamente carregada. */
    get(spec) {
      const key = spec.family + '|' + spec.weight + '|' + (spec.italic ? 1 : 0);
      const font = map.get(key);
      if (font && loaded.has(font.family + '|' + font.style)) return font;
      return emergency;
    },
  };
}

// ============================================================= 2. IMAGENS

/**
 * Registra as imagens no documento e devolve um mapa id -> hash.
 * SVGs ficam de fora: viram nos vetoriais na hora da construcao.
 */
function registerImages(images) {
  const hashes = {};
  const svgs = {};

  for (const id of Object.keys(images || {})) {
    const image = images[id];
    if (image.svg) {
      svgs[id] = image.svg;
      continue;
    }
    if (!image.bytes) continue;
    try {
      hashes[id] = figma.createImage(image.bytes).hash;
    } catch (err) {
      // Formato que o Figma recusou — o no simplesmente fica sem essa camada.
    }
  }

  return { hashes, svgs };
}

// ============================================================= 3. PINTURA

function toRGB(color) {
  return { r: color.r, g: color.g, b: color.b };
}

/** Converte um paint do extractor para o formato do Figma. */
function toPaint(spec, assets) {
  if (!spec) return null;

  if (spec.type === 'SOLID') {
    return { type: 'SOLID', color: toRGB(spec.color), opacity: spec.opacity != null ? spec.opacity : 1 };
  }

  if (spec.type === 'IMAGE') {
    const hash = assets.hashes[spec.imageId];
    if (!hash) return null;
    return { type: 'IMAGE', scaleMode: spec.scaleMode || 'FILL', imageHash: hash };
  }

  if (spec.type === 'GRADIENT_LINEAR' || spec.type === 'GRADIENT_RADIAL' || spec.type === 'GRADIENT_ANGULAR') {
    return {
      type: spec.type,
      gradientTransform: spec.gradientTransform,
      gradientStops: spec.gradientStops.map((stop) => ({
        position: stop.position,
        color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a },
      })),
    };
  }

  return null;
}

function toEffects(specs) {
  if (!specs) return [];
  return specs.map((effect) => ({
    type: effect.type,
    color: { r: effect.color.r, g: effect.color.g, b: effect.color.b, a: effect.color.a },
    offset: effect.offset,
    radius: effect.radius,
    spread: effect.spread || 0,
    visible: true,
    blendMode: 'NORMAL',
  }));
}

/** Aplica raios de canto, usando os cantos individuais so quando diferem. */
function applyRadius(node, radius) {
  if (!radius) return;
  const [tl, tr, br, bl] = radius;
  if (tl === tr && tr === br && br === bl) {
    node.cornerRadius = tl;
  } else {
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = br;
    node.bottomLeftRadius = bl;
  }
}

function applyBorder(node, border) {
  if (!border || !border.uniform) return;
  node.strokes = [{ type: 'SOLID', color: toRGB(border.color), opacity: border.color.a }];
  node.strokeWeight = border.width;
  // CSS desenha a borda dentro da caixa; o padrao do Figma e centralizado.
  node.strokeAlign = 'INSIDE';
  if (border.dashed) node.dashPattern = [4, 4];
}

// ============================================================== 4. TOKENS

function hexOf(color) {
  const channel = (v) => {
    const hex = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return '#' + channel(color.r) + channel(color.g) + channel(color.b);
}

/** RGB 0..1 -> HSL, usado so para dar nome as cores. */
function toHSL(color) {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l: lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === color.r) hue = 60 * (((color.g - color.b) / delta) % 6);
  else if (max === color.g) hue = 60 * ((color.b - color.r) / delta + 2);
  else hue = 60 * ((color.r - color.g) / delta + 4);
  if (hue < 0) hue += 360;

  return { h: hue, s: saturation, l: lightness };
}

const HUE_NAMES = [
  [15, 'Vermelho'], [45, 'Laranja'], [70, 'Amarelo'], [160, 'Verde'],
  [200, 'Ciano'], [255, 'Azul'], [290, 'Roxo'], [330, 'Rosa'], [360, 'Vermelho'],
];

/** "#0d99ff" -> "Cores/Azul 500" */
function nameColor(color) {
  const { h, s, l } = toHSL(color);
  const level = Math.max(50, Math.min(900, Math.round((1 - l) * 900 / 100) * 100)) || 50;

  if (s < 0.12) {
    if (l > 0.97) return 'Neutros/Branco';
    if (l < 0.04) return 'Neutros/Preto';
    return 'Neutros/Cinza ' + level;
  }

  let hueName = 'Cor';
  for (const [limit, name] of HUE_NAMES) {
    if (h <= limit) {
      hueName = name;
      break;
    }
  }
  return 'Cores/' + hueName + ' ' + level;
}

/**
 * Percorre a arvore contando cores e combinacoes tipograficas, para so criar
 * style do que realmente se repete.
 */
function countTokens(tree, counters) {
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();

    if (node.fills) {
      for (const fill of node.fills) {
        if (fill.type === 'SOLID' && fill.opacity >= 0.99) {
          const key = hexOf(fill.color);
          counters.colors.set(key, (counters.colors.get(key) || 0) + 1);
        }
      }
    }

    if (node.t === 'TEXT' && node.text) {
      const paint = node.text.color;
      if (paint && paint.opacity >= 0.99) {
        const key = hexOf(paint.color);
        counters.colors.set(key, (counters.colors.get(key) || 0) + 1);
      }
      const signature = [node.text.family, node.text.size, node.text.weight, node.text.italic ? 1 : 0, node.text.lineHeight || 'auto'].join('|');
      counters.texts.set(signature, (counters.texts.get(signature) || 0) + 1);
    }

    for (const child of node.children || []) stack.push(child);
  }
}

/** Cria paint e text styles para o que passou do limiar de repeticao. */
async function createStyles(counters, fonts) {
  const paintStyles = new Map();
  const textStyles = new Map();
  const usedNames = new Set();

  const uniqueName = (base) => {
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = base + ' (' + i++ + ')';
    usedNames.add(name);
    return name;
  };

  for (const [hex, count] of counters.colors) {
    if (count < STYLE_MIN_USES) continue;
    const color = {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255,
    };
    const style = figma.createPaintStyle();
    style.name = uniqueName(nameColor(color));
    style.paints = [{ type: 'SOLID', color }];
    paintStyles.set(hex, style.id);
  }

  for (const [signature, count] of counters.texts) {
    if (count < STYLE_MIN_USES) continue;
    const [family, size, weight, italic, lineHeight] = signature.split('|');

    const font = fonts.get({ family, weight: Number(weight), italic: italic === '1' });
    const style = figma.createTextStyle();
    style.name = uniqueName('Texto/' + size + ' ' + font.style);
    style.fontName = font;
    style.fontSize = Number(size);
    style.lineHeight = lineHeight === 'auto' ? { unit: 'AUTO' } : { value: Number(lineHeight), unit: 'PIXELS' };
    textStyles.set(signature, style.id);
  }

  return { paintStyles, textStyles };
}

/** Cria uma collection de variaveis com as CSS custom properties do site. */
function createVariables(cssVars, sourceLabel) {
  const useful = (cssVar) => {
    if (!cssVar.value || cssVar.value.length > 60) return false;
    if (cssVar.type === 'COLOR') return true;
    // Tokens numericos so interessam quando o nome sugere medida.
    if (cssVar.type === 'FLOAT') return /(space|spacing|size|radius|gap|width|height|font|leading)/i.test(cssVar.name);
    return false;
  };

  const selected = cssVars.filter(useful).slice(0, MAX_VARIABLES);
  if (!selected.length) return 0;

  let collection;
  try {
    collection = figma.variables.createVariableCollection('Web tokens — ' + sourceLabel);
  } catch (err) {
    return 0;
  }

  const modeId = collection.modes[0].modeId;
  let created = 0;

  for (const cssVar of selected) {
    const bare = cssVar.name.replace(/^--/, '');
    const isColor = cssVar.type === 'COLOR';
    const name = (isColor ? 'cores/' : 'numeros/') + bare;

    try {
      const variable = figma.variables.createVariable(name, collection, isColor ? 'COLOR' : 'FLOAT');
      variable.setValueForMode(
        modeId,
        isColor
          ? { r: cssVar.color.r, g: cssVar.color.g, b: cssVar.color.b, a: cssVar.color.a }
          : cssVar.number || 0
      );
      created++;
    } catch (err) {
      // Nome duplicado ou valor invalido — segue para a proxima.
    }
  }

  return created;
}

// ========================================================== 5. CONSTRUCAO

/**
 * Posiciona um no usando coordenadas absolutas do documento web, convertendo
 * para coordenadas relativas ao pai (que e o que o Figma espera).
 */
function place(node, spec, origin) {
  node.x = spec.x - origin.x;
  node.y = spec.y - origin.y;
}

/**
 * Rotacao: o extractor manda o bbox JA rotacionado mais as dimensoes reais.
 * Montamos a matriz na mao para girar em torno do centro — setar `rotation`
 * direto giraria em torno do canto e deslocaria o no.
 */
function applyRotation(node, spec, origin) {
  const layout = spec.layout || { w: spec.w, h: spec.h };
  const rad = (spec.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const centerX = spec.x + spec.w / 2 - origin.x;
  const centerY = spec.y + spec.h / 2 - origin.y;

  node.resize(Math.max(0.01, layout.w), Math.max(0.01, layout.h));
  node.relativeTransform = [
    [cos, -sin, centerX - (cos * layout.w) / 2 + (sin * layout.h) / 2],
    [sin, cos, centerY - (sin * layout.w) / 2 - (cos * layout.h) / 2],
  ];
}

function safeResize(node, width, height) {
  node.resize(Math.max(0.01, width), Math.max(0.01, height));
}

/** Monta um no de texto. */
function buildText(spec, fonts, styles) {
  const info = spec.text;
  const node = figma.createText();
  const font = fonts.get({ family: info.family, weight: info.weight, italic: info.italic });

  node.fontName = font;
  node.characters = info.chars;
  node.fontSize = Math.max(1, info.size);
  node.lineHeight = info.lineHeight ? { value: info.lineHeight, unit: 'PIXELS' } : { unit: 'AUTO' };
  node.letterSpacing = { value: info.letterSpacing || 0, unit: 'PIXELS' };
  node.textAlignHorizontal = info.align;
  node.textCase = info.case;
  node.textDecoration = info.decoration;

  const paint = toPaint(info.color, { hashes: {} });
  if (paint) node.fills = [paint];

  // Trechos com formatacao propria — o negrito no meio da frase, o preco
  // riscado, a palavra em outra cor.
  if (info.ranges) {
    for (const range of info.ranges) {
      const start = Math.max(0, Math.min(range.start, info.chars.length));
      const end = Math.max(start, Math.min(range.end, info.chars.length));
      if (end <= start) continue;

      const style = range.style;
      try {
        node.setRangeFontName(start, end, fonts.get({ family: style.family, weight: style.weight, italic: style.italic }));
        if (style.size) node.setRangeFontSize(start, end, Math.max(1, style.size));
        if (style.decoration) node.setRangeTextDecoration(start, end, style.decoration);
        if (style.case) node.setRangeTextCase(start, end, style.case);
        const rangePaint = toPaint(style.color, { hashes: {} });
        if (rangePaint) node.setRangeFills(start, end, [rangePaint]);
      } catch (err) {
        // Range invalido apos normalizacao de espacos — mantem o estilo base.
      }
    }
  }

  if (info.wrap) {
    // Multilinha: fixa a largura de requebra e deixa a altura crescer, para
    // uma diferenca de metrica nao cortar texto.
    node.textAutoResize = 'HEIGHT';
    safeResize(node, spec.w, spec.h);
  } else {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  node.name = spec.name || 'text';
  return node;
}

/**
 * Corrige a posicao horizontal de um texto de linha unica: a fonte do Figma
 * quase nunca tem a largura exata da fonte do browser, entao reancoramos no
 * lado que o CSS usava como referencia.
 */
function alignText(node, spec) {
  if (spec.text.wrap) return;
  const drift = spec.w - node.width;
  if (Math.abs(drift) < 0.5) return;

  if (spec.text.align === 'CENTER') node.x += drift / 2;
  else if (spec.text.align === 'RIGHT') node.x += drift;
}

/** Monta o no correspondente a um spec e devolve o container dos filhos. */
function buildOne(spec, parent, origin, assets, fonts, styles) {
  let node = null;

  if (spec.t === 'TEXT') {
    node = buildText(spec, fonts, styles);
    parent.appendChild(node);
    place(node, spec, origin);
    alignText(node, spec);

    if (styles) {
      const signature = [spec.text.family, spec.text.size, spec.text.weight, spec.text.italic ? 1 : 0, spec.text.lineHeight || 'auto'].join('|');
      const styleId = styles.textStyles.get(signature);
      if (styleId) {
        try {
          node.textStyleId = styleId;
        } catch (err) {
          /* estilo incompativel, mantem as props diretas */
        }
      }
      const paint = spec.text.color;
      if (paint && paint.opacity >= 0.99) {
        const fillStyleId = styles.paintStyles.get(hexOf(paint.color));
        if (fillStyleId) {
          try {
            node.fillStyleId = fillStyleId;
          } catch (err) {
            /* idem */
          }
        }
      }
    }

    return null; // texto nao recebe filhos
  }

  if (spec.t === 'SVG') {
    try {
      node = figma.createNodeFromSvg(spec.svg);
      node.name = spec.name || 'svg';
      parent.appendChild(node);
      safeResize(node, spec.w, spec.h);
      place(node, spec, origin);
      if (spec.opacity != null) node.opacity = spec.opacity;
    } catch (err) {
      // SVG que o Figma nao conseguiu parsear — melhor pular do que quebrar.
    }
    return null;
  }

  if (spec.t === 'IMAGE') {
    const hash = assets.hashes[spec.img.id];
    const svgMarkup = assets.svgs[spec.img.id];

    if (hash) {
      node = figma.createRectangle();
      node.fills = [{ type: 'IMAGE', scaleMode: spec.img.scaleMode || 'FILL', imageHash: hash }];
    } else if (svgMarkup) {
      // <img src="algo.svg"> vira nó vetorial em vez de bitmap.
      try {
        node = figma.createNodeFromSvg(svgMarkup);
      } catch (err) {
        return null;
      }
    } else {
      return null; // download falhou
    }

    node.name = spec.name || 'image';
    parent.appendChild(node);
    safeResize(node, spec.w, spec.h);
    place(node, spec, origin);
    if (spec.opacity != null) node.opacity = spec.opacity;
    if (spec.radius && node.type === 'RECTANGLE') applyRadius(node, spec.radius);
    return null;
  }

  // --- FRAME
  node = figma.createFrame();
  node.name = spec.name || 'div';
  node.fills = [];
  node.clipsContent = !!spec.clip;

  parent.appendChild(node);
  safeResize(node, spec.w, spec.h);
  place(node, spec, origin);

  if (spec.fills) {
    const paints = [];
    for (const fillSpec of spec.fills) {
      const paint = toPaint(fillSpec, assets);
      if (paint) paints.push(paint);
      else if (fillSpec.type === 'IMAGE' && assets.svgs[fillSpec.imageId]) {
        // background-image apontando para SVG: entra como filho vetorial.
        try {
          const vector = figma.createNodeFromSvg(assets.svgs[fillSpec.imageId]);
          node.appendChild(vector);
          vector.x = 0;
          vector.y = 0;
          safeResize(vector, spec.w, spec.h);
        } catch (err) {
          /* ignora */
        }
      }
    }
    if (paints.length) node.fills = paints;
  }

  applyRadius(node, spec.radius);
  applyBorder(node, spec.border);

  if (spec.effects) node.effects = toEffects(spec.effects);
  if (spec.opacity != null) node.opacity = spec.opacity;
  if (spec.rotation) applyRotation(node, spec, origin);

  if (styles && spec.fills && spec.fills.length === 1 && spec.fills[0].type === 'SOLID' && spec.fills[0].opacity >= 0.99) {
    const styleId = styles.paintStyles.get(hexOf(spec.fills[0].color));
    if (styleId) {
      try {
        node.fillStyleId = styleId;
      } catch (err) {
        /* ignora */
      }
    }
  }

  return node;
}

/**
 * Monta a arvore inteira. Iterativo com pilha explicita: recursao em paginas
 * grandes estoura o stack do sandbox.
 */
async function buildTree(tree, root, assets, fonts, styles, onProgress) {
  const origin = { x: tree.x, y: tree.y };
  const stack = [];

  for (let i = tree.children.length - 1; i >= 0; i--) {
    stack.push({ spec: tree.children[i], parent: root, origin });
  }

  let built = 0;

  while (stack.length) {
    const item = stack.pop();
    const container = buildOne(item.spec, item.parent, item.origin, assets, fonts, styles);

    built++;
    if (built % YIELD_EVERY === 0) {
      onProgress(built);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (container && item.spec.children && item.spec.children.length) {
      const childOrigin = { x: item.spec.x, y: item.spec.y };
      for (let i = item.spec.children.length - 1; i >= 0; i--) {
        stack.push({ spec: item.spec.children[i], parent: container, origin: childOrigin });
      }
    }
  }

  return built;
}

// ======================================================== 6. ORQUESTRACAO

/** Encontra espaco livre a direita do que ja existe na pagina. */
function findStartX() {
  let maxX = 0;
  for (const child of figma.currentPage.children) {
    maxX = Math.max(maxX, child.x + child.width);
  }
  return figma.currentPage.children.length ? maxX + 200 : 0;
}

function hostnameOf(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url || '');
  return match ? match[1].replace(/^www\./, '') : 'pagina';
}

async function run(message) {
  const { docs, options } = message;
  const started = Date.now();

  // Fontes de todos os viewports de uma vez: carregar e o passo mais lento.
  const allFonts = [];
  for (const doc of docs) allFonts.push(...(doc.fonts || []));
  figma.ui.postMessage({ type: 'progress', value: 0.02, label: 'carregando fontes…' });
  const fonts = await buildFontMap(allFonts);

  let cursorX = findStartX();
  const roots = [];
  let totalNodes = 0;
  let totalVariables = 0;

  for (let d = 0; d < docs.length; d++) {
    const doc = docs[d];
    const label = hostnameOf(doc.meta.url) + ' — ' + doc.viewport + 'px';

    figma.ui.postMessage({ type: 'progress', value: 0.05, label: 'registrando imagens (' + doc.viewport + 'px)…' });
    const assets = registerImages(doc.images);

    let styles = null;
    if (options.createStyles) {
      const counters = { colors: new Map(), texts: new Map() };
      countTokens(doc.tree, counters);
      styles = await createStyles(counters, fonts);
    }

    const root = figma.createFrame();
    root.name = label;
    root.x = cursorX;
    root.y = 0;
    safeResize(root, doc.tree.w, doc.tree.h);
    root.clipsContent = true;

    const rootPaint = toPaint((doc.tree.fills || [])[0], assets);
    root.fills = rootPaint ? [rootPaint] : [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

    const built = await buildTree(doc.tree, root, assets, fonts, styles, (count) => {
      const share = (d + count / Math.max(1, doc.meta.stats.elements)) / docs.length;
      figma.ui.postMessage({
        type: 'progress',
        value: Math.min(0.98, share),
        label: 'montando ' + doc.viewport + 'px — ' + count + ' camadas',
      });
    });

    totalNodes += built;
    roots.push(root);
    cursorX += doc.tree.w + 120;

    if (options.createVariables && d === 0) {
      totalVariables = createVariables(doc.cssVars || [], hostnameOf(doc.meta.url));
    }
  }

  figma.currentPage.selection = roots;
  figma.viewport.scrollAndZoomIntoView(roots);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const parts = [totalNodes + ' camadas', roots.length + ' viewport' + (roots.length > 1 ? 's' : '')];
  if (totalVariables) parts.push(totalVariables + ' variáveis');

  const summary = 'pronto: ' + parts.join(', ') + ' em ' + seconds + 's';
  figma.notify(summary);
  figma.ui.postMessage({ type: 'done', summary });
}

figma.ui.onmessage = async (message) => {
  if (!message || message.type !== 'build') return;

  try {
    await run(message);
  } catch (err) {
    const text = String((err && err.message) || err);
    console.error(err);
    figma.notify('web-to-figma falhou: ' + text, { error: true });
    figma.ui.postMessage({ type: 'error', message: text });
  }
};
