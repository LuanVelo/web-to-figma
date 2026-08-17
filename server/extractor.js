/**
 * Extractor — roda DENTRO da pagina (injetado pelo Playwright).
 *
 * Nao e um modulo: e um arquivo de texto avaliado no contexto da pagina,
 * que expoe window.__W2F.extract(opts).
 *
 * Toda a geometria sai em coordenadas absolutas do documento (px CSS).
 * O plugin converte para coordenadas relativas ao pai na hora de montar.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE',
    'TEMPLATE', 'BASE', 'PARAM', 'SOURCE', 'TRACK', 'BR', 'WBR',
  ]);

  // Elementos cujo conteudo interno nao deve ser percorrido.
  const LEAF_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT']);

  const round = (n) => Math.round(n * 100) / 100;

  /**
   * Agrupa retangulos por LINHA visual, em ordem de leitura.
   *
   * getClientRects() devolve um retangulo por caixa inline, nao por linha:
   * "R$ <strong>179,10</strong>" gera dois retangulos lado a lado na mesma
   * linha. Tratar retangulo como linha faria esse preco passar por texto
   * multilinha e ganhar largura de requebra, quebrando o valor ao meio.
   */
  function groupLines(rects) {
    const lines = [];
    for (const rect of rects) {
      const line = lines.find((l) => Math.abs(l.top - rect.top) < 3);
      if (line) {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
      }
    }
    lines.sort((a, b) => a.top - b.top);
    return lines;
  }

  function countLines(rects) {
    return groupLines(rects).length;
  }

  /** Divide "a, b(c, d), e" em ["a", "b(c, d)", "e"] — respeita parenteses. */
  function splitTopLevel(str, sep = ',') {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // Canvas usado so para normalizar cores. Resolve oklch(), color-mix(), lab(),
  // hsl() e nomes — tudo que o Chrome moderno pode devolver cru no computed style.
  const _colorCanvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const _colorCache = new Map();

  /** "rgba(0,0,0,.5)" | "oklch(...)" | "red" -> {r,g,b,a} em 0..1, ou null se transparente/invalido. */
  function parseColor(input) {
    if (!input) return null;
    const str = String(input).trim();
    if (!str || str === 'transparent' || str === 'none' || str === 'currentcolor') return null;

    if (_colorCache.has(str)) return _colorCache.get(str);

    let result = null;

    // Caminho rapido: o computed style quase sempre ja vem em rgb()/rgba().
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i.exec(str);
    if (m) {
      let a = 1;
      if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      result = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a };
    } else {
      // Sentinela improvavel: se fillStyle nao mudar, a string era invalida.
      const SENTINEL = '#010203';
      _colorCanvas.fillStyle = SENTINEL;
      _colorCanvas.fillStyle = str;
      const norm = _colorCanvas.fillStyle;
      if (norm !== SENTINEL || /^#010203$/i.test(str)) {
        if (norm.startsWith('#')) {
          result = {
            r: parseInt(norm.slice(1, 3), 16) / 255,
            g: parseInt(norm.slice(3, 5), 16) / 255,
            b: parseInt(norm.slice(5, 7), 16) / 255,
            a: 1,
          };
        } else {
          const mm = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(norm);
          if (mm) {
            result = { r: +mm[1] / 255, g: +mm[2] / 255, b: +mm[3] / 255, a: mm[4] != null ? +mm[4] : 1 };
          }
        }
      }
    }

    if (result) {
      result.r = round(result.r);
      result.g = round(result.g);
      result.b = round(result.b);
      result.a = round(result.a);
      if (result.a <= 0) result = null;
    }

    _colorCache.set(str, result);
    return result;
  }

  function solidPaint(color) {
    if (!color) return null;
    return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a };
  }

  /** "12px" | "50%" -> numero em px. */
  function len(value, base = 0) {
    if (!value) return 0;
    const s = String(value).trim();
    if (s.endsWith('%')) return (parseFloat(s) / 100) * base;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  // ------------------------------------------------------------- gradientes

  /**
   * Matriz gradientTransform do Figma para um linear-gradient CSS.
   *
   * O Figma avalia t = (T * p).x com p normalizado em 0..1 na caixa do no.
   * Queremos t = 0 no inicio da linha de gradiente e 1 no fim, respeitando
   * a caixa real w x h (o espaco unitario distorce o angulo em caixas nao quadradas).
   *
   * CSS: 0deg aponta para cima, cresce no sentido horario -> u = (sin A, -cos A).
   * Comprimento da linha de gradiente: L = |w sin A| + |h cos A|.
   */
  function linearGradientTransform(angleRad, w, h) {
    const sin = Math.sin(angleRad);
    const cos = Math.cos(angleRad);
    const L = Math.abs(w * sin) + Math.abs(h * cos) || 1;

    const ax = (w * sin) / L;
    const ay = (-h * cos) / L;
    const tx = 0.5 - (w * sin - h * cos) / (2 * L);

    // Segunda linha: perpendicular. Nao afeta o gradiente linear, mas a matriz
    // precisa ser invertivel.
    const bx = (-h * cos) / L;
    const by = (-w * sin) / L;
    const ty = 0.5 - (-h * cos - w * sin) / (2 * L);

    return [
      [round(ax), round(ay), round(tx)],
      [round(bx), round(by), round(ty)],
    ];
  }

  /** Converte a direcao de um linear-gradient CSS em radianos. */
  function gradientAngle(spec) {
    const s = spec.trim().toLowerCase();

    const deg = /^([-\d.]+)deg$/.exec(s);
    if (deg) return (parseFloat(deg[1]) * Math.PI) / 180;

    const turn = /^([-\d.]+)turn$/.exec(s);
    if (turn) return parseFloat(turn[1]) * 2 * Math.PI;

    const rad = /^([-\d.]+)rad$/.exec(s);
    if (rad) return parseFloat(rad[1]);

    if (s.startsWith('to ')) {
      const dirs = s.slice(3).trim().split(/\s+/).sort().join(' ');
      const map = {
        'top': 0,
        'right top': Math.PI / 4,
        'right': Math.PI / 2,
        'bottom right': (3 * Math.PI) / 4,
        'bottom': Math.PI,
        'bottom left': (5 * Math.PI) / 4,
        'left': (3 * Math.PI) / 2,
        'left top': (7 * Math.PI) / 4,
      };
      if (map[dirs] != null) return map[dirs];
    }

    return Math.PI; // default CSS: to bottom
  }

  /** Parseia a lista de color-stops de um gradiente. */
  function parseStops(parts) {
    const raw = [];
    for (const part of parts) {
      // "rgb(0, 0, 0) 25%" — a cor pode conter espacos dentro dos parenteses.
      const posMatch = /\s([-\d.]+(?:%|px|em|rem))\s*$/.exec(part);
      let colorStr = part;
      let pos = null;
      if (posMatch) {
        colorStr = part.slice(0, posMatch.index);
        pos = posMatch[1].endsWith('%') ? parseFloat(posMatch[1]) / 100 : null;
      }
      const color = parseColor(colorStr) || { r: 0, g: 0, b: 0, a: 0 };
      raw.push({ color, position: pos });
    }

    if (!raw.length) return null;

    // Preenche posicoes ausentes distribuindo uniformemente.
    if (raw[0].position == null) raw[0].position = 0;
    if (raw[raw.length - 1].position == null) raw[raw.length - 1].position = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      if (raw[i].position != null) continue;
      let next = i;
      while (next < raw.length && raw[next].position == null) next++;
      const start = raw[i - 1].position;
      const end = raw[next].position;
      const steps = next - i + 1;
      for (let k = 0; i + k < next; k++) {
        raw[i + k].position = start + ((end - start) * (k + 1)) / steps;
      }
    }

    return raw.map((s) => ({
      position: round(Math.max(0, Math.min(1, s.position))),
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    }));
  }

  /** "linear-gradient(45deg, red, blue)" -> GradientPaint do Figma. */
  function parseGradient(str, w, h) {
    const m = /^(-webkit-|-moz-|-o-)?(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is.exec(str.trim());
    if (!m) return null;

    const kind = m[3].toLowerCase();
    const args = splitTopLevel(m[4]);
    if (!args.length) return null;

    let stopArgs = args;
    let angle = Math.PI;
    let isRadial = kind === 'radial';

    // O primeiro argumento e a direcao/forma se nao for um color-stop.
    const first = args[0].trim().toLowerCase();
    const looksLikeDirection =
      /^(to\s|[-\d.]+(deg|turn|rad|grad)$)/.test(first) ||
      /^(circle|ellipse|closest|farthest|at\s)/.test(first);

    if (looksLikeDirection) {
      stopArgs = args.slice(1);
      if (!isRadial && kind !== 'conic') angle = gradientAngle(args[0]);
    }

    const gradientStops = parseStops(stopArgs);
    if (!gradientStops || gradientStops.length < 2) return null;

    if (isRadial || kind === 'conic') {
      // Aproximacao: circulo/cone centrado cobrindo a caixa.
      return {
        type: kind === 'conic' ? 'GRADIENT_ANGULAR' : 'GRADIENT_RADIAL',
        gradientTransform: [
          [0.5, 0, 0.25],
          [0, 0.5, 0.25],
        ],
        gradientStops,
      };
    }

    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: linearGradientTransform(angle, w, h),
      gradientStops,
    };
  }

  // ------------------------------------------------------------------ fills

  /** background-size -> scaleMode do Figma. */
  function bgScaleMode(size) {
    const s = (size || '').trim().toLowerCase();
    if (s === 'cover') return 'FILL';
    if (s === 'contain') return 'FIT';
    if (s.includes('repeat')) return 'TILE';
    return 'FILL';
  }

  /**
   * Monta a lista de fills. No Figma o indice 0 e a camada de baixo; no CSS a
   * primeira camada de background-image e a de cima. Por isso invertemos.
   */
  function buildFills(cs, rect, ctx) {
    const fills = [];

    const bg = parseColor(cs.backgroundColor);
    const bgPaint = solidPaint(bg);
    if (bgPaint) fills.push(bgPaint);

    const bgi = cs.backgroundImage;
    if (bgi && bgi !== 'none') {
      const layers = splitTopLevel(bgi);
      const sizes = splitTopLevel(cs.backgroundSize || '');
      const built = [];

      layers.forEach((layer, i) => {
        if (/gradient\(/i.test(layer)) {
          const g = parseGradient(layer, rect.w, rect.h);
          if (g) built.push(g);
          return;
        }
        const urlMatch = /url\((['"]?)(.*?)\1\)/i.exec(layer);
        if (urlMatch && urlMatch[2]) {
          const id = ctx.addImage(urlMatch[2]);
          if (id) built.push({ type: 'IMAGE', imageId: id, scaleMode: bgScaleMode(sizes[i] || sizes[0]) });
        }
      });

      // CSS pinta a primeira camada por cima -> inverte para a ordem do Figma.
      built.reverse();
      fills.push(...built);
    }

    return fills;
  }

  // ---------------------------------------------------------------- bordas

  function buildBorder(cs, rect) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({
      side: side.toLowerCase(),
      width: len(cs[`border${side}Width`]),
      style: cs[`border${side}Style`],
      color: parseColor(cs[`border${side}Color`]),
    }));

    const visible = sides.filter((s) => s.width > 0 && s.style !== 'none' && s.style !== 'hidden' && s.color);
    if (!visible.length) return null;

    const first = visible[0];
    const uniform =
      visible.length === 4 &&
      visible.every(
        (s) =>
          Math.abs(s.width - first.width) < 0.01 &&
          s.color.r === first.color.r &&
          s.color.g === first.color.g &&
          s.color.b === first.color.b &&
          s.color.a === first.color.a
      );

    if (uniform) {
      return {
        uniform: true,
        width: round(first.width),
        color: first.color,
        dashed: first.style === 'dashed' || first.style === 'dotted',
      };
    }

    // Bordas diferentes por lado viram retangulos filhos (o Figma so tem
    // um stroke por no).
    return {
      uniform: false,
      sides: visible.map((s) => ({
        side: s.side,
        width: round(s.width),
        color: s.color,
        rect: sideRect(s.side, s.width, rect),
      })),
    };
  }

  function sideRect(side, width, rect) {
    switch (side) {
      case 'top': return { x: rect.x, y: rect.y, w: rect.w, h: width };
      case 'bottom': return { x: rect.x, y: rect.y + rect.h - width, w: rect.w, h: width };
      case 'left': return { x: rect.x, y: rect.y, w: width, h: rect.h };
      default: return { x: rect.x + rect.w - width, y: rect.y, w: width, h: rect.h };
    }
  }

  // ---------------------------------------------------------------- radius

  function buildRadius(cs, rect) {
    const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];
    const out = corners.map((c) => {
      // Pode vir "8px" ou "8px 12px" (raio eliptico) — usamos o horizontal.
      const raw = String(cs[`border${c}Radius`] || '0').trim().split(/\s+/)[0];
      const base = c.includes('Top') || c.includes('Bottom') ? rect.w : rect.h;
      return round(Math.min(len(raw, base), Math.min(rect.w, rect.h) / 2));
    });
    return out.some((r) => r > 0) ? out : null;
  }

  // --------------------------------------------------------------- sombras

  function buildEffects(cs) {
    const raw = cs.boxShadow;
    if (!raw || raw === 'none') return null;

    const effects = [];
    for (const layer of splitTopLevel(raw)) {
      const inset = /\binset\b/i.test(layer);
      let rest = layer.replace(/\binset\b/i, '').trim();

      // O Chrome normaliza a cor no inicio: "rgb(0, 0, 0) 0px 4px 6px -1px".
      const colorMatch = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)/i.exec(rest);
      let color = { r: 0, g: 0, b: 0, a: 1 };
      if (colorMatch) {
        const parsed = parseColor(colorMatch[1]);
        if (parsed) color = parsed;
        rest = rest.replace(colorMatch[1], ' ');
      }

      const nums = rest.trim().split(/\s+/).map((v) => len(v));
      if (nums.length < 2) continue;

      const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = nums;

      effects.push({
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: { r: color.r, g: color.g, b: color.b, a: color.a },
        offset: { x: round(offsetX), y: round(offsetY) },
        radius: round(Math.max(0, blur)),
        spread: round(spread),
        blendMode: 'NORMAL',
        visible: true,
      });
    }

    return effects.length ? effects : null;
  }

  // ------------------------------------------------------------- transform

  /** Extrai rotacao (graus) de uma matrix CSS, se for rotacao aproximadamente pura. */
  function extractRotation(transform) {
    if (!transform || transform === 'none') return 0;
    if (transform.startsWith('matrix3d')) return 0; // 3D nao suportado

    const m = /^matrix\(([^)]+)\)$/.exec(transform);
    if (!m) return 0;

    const [a, b, c, d] = m[1].split(',').map(parseFloat);
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    if (Math.abs(scaleX - 1) > 0.02 || Math.abs(scaleY - 1) > 0.02) return 0; // tem escala junto

    const deg = (Math.atan2(b, a) * 180) / Math.PI;
    return Math.abs(deg) < 0.1 ? 0 : round(deg);
  }

  // ----------------------------------------------------------------- fontes

  // Nomes que nao correspondem a nenhuma fonte instalavel: ou sao apelidos do
  // sistema, ou sao a familia generica do fim da pilha.
  const ABSTRACT_FAMILIES = new Set([
    '-apple-system', 'blinkmacsystemfont', '-webkit-body', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
    'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'emoji', 'math', 'fangsong',
    'inherit', 'initial', 'unset', 'revert',
  ]);

  /**
   * "Inter, -apple-system, sans-serif" -> "Inter"
   * "-apple-system, 'Helvetica Neue', Arial" -> "Helvetica Neue"
   *
   * Pegar cegamente o primeiro nome da pilha entregava "-apple-system" ao
   * plugin, que nao acha essa familia em Figma nenhum e cai no fallback —
   * jogando fora a fonte de verdade, que estava logo ao lado.
   */
  function primaryFamily(fontFamily) {
    if (!fontFamily) return 'Inter';
    for (const entry of splitTopLevel(fontFamily)) {
      const name = entry.replace(/^["']|["']$/g, '').trim();
      if (name && !ABSTRACT_FAMILIES.has(name.toLowerCase())) return name;
    }
    return 'Inter';
  }

  function textCase(transform) {
    switch ((transform || '').toLowerCase()) {
      case 'uppercase': return 'UPPER';
      case 'lowercase': return 'LOWER';
      case 'capitalize': return 'TITLE';
      default: return 'ORIGINAL';
    }
  }

  function textAlign(align, direction) {
    switch ((align || '').toLowerCase()) {
      case 'center': return 'CENTER';
      case 'right': return 'RIGHT';
      case 'justify': return 'JUSTIFIED';
      case 'end': return direction === 'rtl' ? 'LEFT' : 'RIGHT';
      case 'start': return direction === 'rtl' ? 'RIGHT' : 'LEFT';
      default: return 'LEFT';
    }
  }

  /**
   * text-decoration se propaga do ancestral para os descendentes visualmente,
   * mas o computed style do filho continua "none" — um <span> dentro de um
   * <div style="text-decoration:line-through"> reporta none. Por isso subimos
   * a arvore ate achar quem declarou a decoracao.
   *
   * A propagacao para em elementos que criam contexto de formatacao proprio
   * (inline-block, flex, float, absolute), que e o que o CSS tambem faz.
   */
  function textDecoration(el) {
    let node = el;
    let depth = 0;

    while (node && node !== document.body && depth < 8) {
      const cs = window.getComputedStyle(node);
      const line = (cs.textDecorationLine || cs.textDecoration || '').toLowerCase();
      if (line.includes('underline')) return 'UNDERLINE';
      if (line.includes('line-through')) return 'STRIKETHROUGH';

      if (depth > 0) {
        const display = cs.display;
        if (
          display === 'inline-block' ||
          display === 'flex' ||
          display === 'grid' ||
          display === 'table-cell' ||
          cs.position === 'absolute' ||
          cs.position === 'fixed' ||
          cs.float !== 'none'
        ) {
          break;
        }
      }

      node = node.parentElement;
      depth++;
    }

    return 'NONE';
  }

  // ------------------------------------------------------------------ nucleo

  // Elementos a fotografar, na ordem em que foram registrados. Fica fora do
  // JSON de saida de proposito: o servidor precisa da referencia viva ao
  // elemento para mascarar o que estiver por cima na hora do screenshot.
  let shotTargets = new Map();

  // Elementos escondidos temporariamente durante um screenshot.
  let maskedForShot = [];

  function createContext(opts) {
    const images = {};
    const imageIds = new Map();
    const fonts = new Map();
    let counter = 0;

    return {
      images,
      fonts,
      opts,

      /** Registra uma imagem e devolve o id (deduplicado por URL). */
      addImage(src, kind = 'url') {
        if (!src) return null;
        let absolute = src;
        if (kind === 'url') {
          if (src.startsWith('data:')) {
            // Data URL ja e o conteudo — o servidor nao precisa baixar.
            absolute = src;
          } else {
            try {
              absolute = new URL(src, document.baseURI).href;
            } catch {
              return null;
            }
          }
        }
        if (imageIds.has(absolute)) return imageIds.get(absolute);
        const id = `img${++counter}`;
        imageIds.set(absolute, id);
        images[id] = { src: absolute, kind };
        return id;
      },

      /**
       * Registra um pedaco da tela para ser fotografado depois.
       *
       * E o unico jeito de trazer o que o DOM nao entrega: video sem poster,
       * canvas contaminado ou WebGL, iframe de outro dominio. Quem preenche e
       * o servidor, que tem o browser na mao — a extensao nao pode tirar
       * screenshot de dentro da pagina, entao la a opcao fica desligada.
       */
      addShot(el, rect) {
        if (!rect || rect.w <= 0 || rect.h <= 0) return null;
        const key = `shot:${rect.x},${rect.y},${rect.w},${rect.h}`;
        if (imageIds.has(key)) return imageIds.get(key);
        const id = `img${++counter}`;
        imageIds.set(key, id);
        images[id] = { kind: 'shot', rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
        shotTargets.set(id, el);
        return id;
      },

      /** Registra uma fonte usada na pagina. */
      addFont(family, weight, italic) {
        const key = `${family}|${weight}|${italic ? 1 : 0}`;
        if (!fonts.has(key)) fonts.set(key, { family, weight, italic });
      },
    };
  }

  function absRect(el) {
    const r = el.getBoundingClientRect();
    return {
      x: round(r.left + window.scrollX),
      y: round(r.top + window.scrollY),
      w: round(r.width),
      h: round(r.height),
    };
  }

  function nodeName(el) {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
    if (cls && !/^[a-z]+-?\d+$/i.test(cls) && cls.length < 32) return `${tag}.${cls}`;
    if (el.id) return `${tag}#${el.id}`;
    return tag;
  }

  /** Extrai as propriedades tipograficas de um elemento. */
  function typography(el, cs, ctx) {
    const family = primaryFamily(cs.fontFamily);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const italic = (cs.fontStyle || '').includes('italic') || (cs.fontStyle || '').includes('oblique');
    ctx.addFont(family, weight, italic);

    let lineHeight = null;
    if (cs.lineHeight && cs.lineHeight !== 'normal') {
      const lh = len(cs.lineHeight);
      if (lh > 0) lineHeight = round(lh);
    }

    return {
      family,
      weight,
      italic,
      size: round(len(cs.fontSize) || 16),
      lineHeight,
      letterSpacing: cs.letterSpacing && cs.letterSpacing !== 'normal' ? round(len(cs.letterSpacing)) : 0,
      color: solidPaint(parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 }),
      decoration: textDecoration(el),
      case: textCase(cs.textTransform),
    };
  }

  /**
   * Um elemento e um "bloco de texto" quando todo o seu conteudo e inline:
   * so texto e tags de formatacao (b, i, a, span...) sem visual proprio.
   *
   * Nesse caso o texto inteiro vira UM no de texto, com os trechos formatados
   * marcados por range. Tratar cada text node como um no separado quebraria
   * frases que fluem juntas — "15% off <b>PRIMEIRACOMPRA</b>" viraria dois nos
   * empilhados no mesmo ponto, um por cima do outro.
   */
  function collectSegments(el, ctx, out, depth) {
    if (depth > 6) return false;

    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const chars = child.nodeValue;
        if (!chars || !chars.trim()) {
          // Espaco entre tags conta como separador.
          if (chars && /\s/.test(chars) && out.length) out[out.length - 1].chars += ' ';
          continue;
        }
        const parent = child.parentElement || el;
        out.push({ chars: chars.replace(/\s+/g, ' '), style: typography(parent, window.getComputedStyle(parent), ctx) });
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;
      if (tag === 'BR') {
        if (out.length) out[out.length - 1].chars += '\n';
        continue;
      }
      if (SKIP_TAGS.has(tag)) continue;
      if (LEAF_TAGS.has(tag) || tag === 'SVG') return false; // imagem/icone no meio: nao e texto puro

      const childStyle = window.getComputedStyle(child);

      // Conteudo escondido nao entra no texto, mas tambem nao desqualifica o
      // bloco: paginas costumam guardar variacoes de um titulo em elementos
      // display:none ao lado do que esta visivel.
      if (childStyle.display === 'none' || childStyle.visibility === 'hidden') continue;

      if (!childStyle.display.startsWith('inline')) return false;

      // `inline-block` costuma ser so um <a> ou <span> no meio da frase — e a
      // frase precisa continuar sendo um no de texto so. Ele quebraria o bloco
      // se tivesse vida propria: ocupar mais de uma linha (ai e um paragrafo
      // dentro do paragrafo) ou carregar transform. Fundo e borda proprios ja
      // sao barrados logo abaixo.
      if (childStyle.display === 'inline-block') {
        if (childStyle.transform !== 'none') return false;
        if (countLines(Array.from(child.getClientRects())) > 1) return false;
      }

      // Um filho inline com fundo/borda proprios (badge, chip) precisa virar no.
      if (
        parseColor(childStyle.backgroundColor) ||
        (childStyle.backgroundImage && childStyle.backgroundImage !== 'none') ||
        len(childStyle.borderTopWidth) > 0 ||
        len(childStyle.borderLeftWidth) > 0
      ) {
        return false;
      }

      if (!collectSegments(child, ctx, out, depth + 1)) return false;
    }

    return true;
  }

  /** Monta o no de texto unico de um bloco inline. */
  function buildTextBlock(el, cs, ctx) {
    const segments = [];
    if (!collectSegments(el, ctx, segments, 0)) return null;
    if (!segments.length) return null;

    const chars = segments.map((s) => s.chars).join('');
    if (!chars.trim()) return null;

    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    range.detach?.();
    if (!rects.length) return null;

    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));

    const wrap = countLines(rects) > 1 || chars.includes('\n');

    const padL = len(cs.paddingLeft) + len(cs.borderLeftWidth);
    const padR = len(cs.paddingRight) + len(cs.borderRightWidth);
    const elRect = el.getBoundingClientRect();
    const contentX = round(elRect.left + window.scrollX + padL);
    const contentW = round(Math.max(0, elRect.width - padL - padR));

    const box = wrap
      ? { x: contentX, y: round(top + window.scrollY), w: contentW, h: round(bottom - top) }
      : { x: round(left + window.scrollX), y: round(top + window.scrollY), w: round(right - left), h: round(bottom - top) };

    const base = segments[0].style;

    // Ranges so viajam quando ha mais de um estilo — a maioria dos textos e uniforme.
    let ranges;
    if (segments.length > 1) {
      const differs = (a, b) =>
        a.family !== b.family || a.weight !== b.weight || a.italic !== b.italic ||
        a.size !== b.size || a.decoration !== b.decoration || a.case !== b.case ||
        JSON.stringify(a.color) !== JSON.stringify(b.color);

      if (segments.some((s) => differs(s.style, base))) {
        ranges = [];
        let cursor = 0;
        for (const segment of segments) {
          const start = cursor;
          cursor += segment.chars.length;
          if (differs(segment.style, base)) ranges.push({ start, end: cursor, style: segment.style });
        }
      }
    }

    return {
      t: 'TEXT',
      name: chars.trim().slice(0, 24) || 'text',
      ...box,
      text: {
        chars,
        family: base.family,
        weight: base.weight,
        italic: base.italic,
        size: base.size,
        lineHeight: base.lineHeight,
        letterSpacing: base.letterSpacing,
        align: textAlign(cs.textAlign, cs.direction),
        color: base.color,
        decoration: base.decoration,
        case: base.case,
        wrap,
        ranges,
      },
    };
  }

  /**
   * Acha o offset do primeiro caractere de cada linha de um text node.
   *
   * Usa o proprio browser como oraculo: como o texto flui de cima para baixo,
   * o topo do retangulo do caractere `i` so cresce — da para achar a virada por
   * busca binaria, em ~7 medicoes por linha, em vez de medir caractere a
   * caractere.
   */
  function lineCuts(node, lines) {
    const total = node.nodeValue.length;
    const range = document.createRange();

    const topAt = (i) => {
      range.setStart(node, i);
      range.setEnd(node, Math.min(i + 1, total));
      const rects = range.getClientRects();
      return rects.length ? rects[rects.length - 1].top : null;
    };

    const cuts = [0];
    for (let k = 1; k < lines.length; k++) {
      const threshold = lines[k].top - 3;
      let lo = cuts[k - 1];
      let hi = total;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const top = topAt(mid);
        // Sem retangulo (espaco engolido na quebra) conta como "ainda antes".
        if (top == null || top < threshold) lo = mid + 1;
        else hi = mid;
      }
      cuts.push(lo);
    }
    cuts.push(total);

    range.detach?.();
    return cuts;
  }

  /**
   * Coleta os text nodes DIRETOS de um elemento que tambem tem filhos de bloco
   * — o caso em que o texto nao pode virar um bloco unico.
   */
  function collectText(el, cs, ctx) {
    const out = [];
    const style = typography(el, cs, ctx);

    // Content box do elemento — usado como largura de requebra em textos
    // multilinha, para o Figma quebrar onde o browser quebrou.
    const elRect = el.getBoundingClientRect();
    const padL = len(cs.paddingLeft);
    const padR = len(cs.paddingRight);
    const borderL = len(cs.borderLeftWidth);
    const borderR = len(cs.borderRightWidth);
    const contentBox = {
      x: round(elRect.left + window.scrollX + borderL + padL),
      w: round(Math.max(0, elRect.width - borderL - padL - borderR - padR)),
    };

    for (const child of el.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const chars = child.nodeValue;
      if (!chars || !chars.trim()) continue;

      const range = document.createRange();
      range.selectNodeContents(child);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      range.detach?.();
      if (!rects.length) continue;

      const lines = groupLines(rects);
      const wrap = lines.length > 1;

      const textNode = (box, content, multiline) => ({
        t: 'TEXT',
        name: content.trim().slice(0, 24) || 'text',
        ...box,
        text: {
          chars: content.replace(/\s+/g, ' '),
          family: style.family,
          weight: style.weight,
          italic: style.italic,
          size: style.size,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          align: textAlign(cs.textAlign, cs.direction),
          color: style.color,
          decoration: style.decoration,
          case: style.case,
          wrap: multiline,
        },
      });

      const tight = (line) => ({
        x: round(line.left + window.scrollX),
        y: round(line.top + window.scrollY),
        w: round(line.right - line.left),
        h: round(line.bottom - line.top),
      });

      // Trecho multilinha que comeca no MEIO da linha — o texto que sobrou
      // depois de um link, de um icone, de um botao inline. Ancorar na esquerda
      // do content box jogaria a primeira linha por cima do que veio antes, que
      // e como o aviso de cookies saia com tres textos empilhados. Nesse caso
      // vai uma caixa por linha, cada uma onde o browser desenhou.
      if (wrap && Math.abs(lines[0].left + window.scrollX - contentBox.x) > 2) {
        const cuts = lineCuts(child, lines);
        lines.forEach((line, i) => {
          const piece = chars.slice(cuts[i], cuts[i + 1]);
          if (!piece.trim()) return;
          out.push(textNode(tight(line), piece, false));
        });
        continue;
      }

      // Uma linha: caixa justa, o Figma pode crescer sem quebrar.
      // Multilinha: largura do content box e altura fixa, para nao empurrar layout.
      const last = lines[lines.length - 1];
      const box = wrap
        ? {
            x: contentBox.x,
            y: round(lines[0].top + window.scrollY),
            w: contentBox.w,
            h: round(last.bottom - lines[0].top),
          }
        : tight(lines[0]);

      out.push(textNode(box, chars, wrap));
    }

    return out;
  }

  /** Elementos de formulario viram frame + texto do value/placeholder. */
  function formFieldText(el, cs, rect, ctx) {
    const tag = el.tagName;
    let value = '';
    if (tag === 'INPUT') value = el.value || el.placeholder || '';
    else if (tag === 'TEXTAREA') value = el.value || el.placeholder || '';
    else if (tag === 'SELECT') value = el.options[el.selectedIndex]?.text || '';
    if (!value.trim()) return null;

    const family = primaryFamily(cs.fontFamily);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const italic = (cs.fontStyle || '').includes('italic');
    ctx.addFont(family, weight, italic);

    const padL = len(cs.paddingLeft) + len(cs.borderLeftWidth);
    const padT = len(cs.paddingTop) + len(cs.borderTopWidth);
    const size = len(cs.fontSize) || 16;

    return {
      t: 'TEXT',
      name: value.slice(0, 24),
      x: round(rect.x + padL),
      y: round(rect.y + padT),
      w: round(Math.max(0, rect.w - padL * 2)),
      h: round(Math.max(size * 1.3, rect.h - padT * 2)),
      text: {
        chars: value,
        family,
        weight,
        italic,
        size: round(size),
        lineHeight: null,
        letterSpacing: 0,
        align: textAlign(cs.textAlign, cs.direction),
        color: solidPaint(parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 }),
        decoration: 'NONE',
        case: textCase(cs.textTransform),
        wrap: false,
      },
    };
  }

  /**
   * Desenha o quadro atual de um <video> num canvas e devolve o id da imagem.
   *
   * So funciona com video same-origin ou servido com CORS: qualquer outro
   * contamina o canvas e o toDataURL lanca. Vale tentar mesmo assim, porque o
   * quadro sai limpo — sem o texto e os botoes que a pagina desenha por cima.
   */
  function videoFrame(el, ctx) {
    if (!el.videoWidth || !el.videoHeight || el.readyState < 2) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(el.videoWidth, 1920);
      canvas.height = Math.round(canvas.width * (el.videoHeight / el.videoWidth));
      canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
      return ctx.addImage(canvas.toDataURL('image/png'));
    } catch {
      return null;
    }
  }

  function objectFitToScaleMode(fit) {
    switch ((fit || '').toLowerCase()) {
      case 'contain': return 'FIT';
      case 'none': return 'CROP';
      case 'scale-down': return 'FIT';
      default: return 'FILL'; // cover e fill
    }
  }

  /**
   * Percorre um elemento e devolve um array de nos (array porque elementos
   * inline sem visual sao colapsados no pai).
   */
  function walk(el, ctx, depth) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return [];
    if (SKIP_TAGS.has(el.tagName)) return [];
    if (depth > ctx.opts.maxDepth) return [];

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return [];

    // Conteudo de <details> fechado: so o <summary> aparece. O browser ainda
    // calcula layout para o resto e responde "visible" no computed style, com
    // um rect valido — sem esta checagem, todo mega-menu e todo FAQ colapsado
    // entram na captura, empilhados sobre o conteudo real.
    const parent = el.parentElement;
    if (parent && parent.tagName === 'DETAILS' && !parent.hasAttribute('open') && el.tagName !== 'SUMMARY') {
      ctx.stats.collapsedDetails++;
      return [];
    }

    // Mesma ideia, versao moderna: o elemento ocupa espaco mas nao e pintado.
    if (cs.contentVisibility === 'hidden') return [];

    const opacity = parseFloat(cs.opacity);
    if (opacity === 0 && !ctx.opts.keepInvisible) return [];

    const rect = absRect(el);
    const tag = el.tagName;

    // Elemento sem area e sem filhos nao contribui nada.
    if (rect.w <= 0 && rect.h <= 0 && !el.children.length) return [];

    // `display: contents` nao gera caixa propria — os filhos e que aparecem.
    // O rect vem 0x0, entao o elemento nao pode virar frame nem ser avaliado
    // pelos filtros de area; so repassamos os filhos.
    if (cs.display === 'contents') {
      const passthrough = [];
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) passthrough.push(...walk(child, ctx, depth + 1));
      }
      for (const text of collectText(el, cs, ctx)) passthrough.push(text);
      return passthrough;
    }

    // Conteudo totalmente fora da largura do documento: slides de carrossel
    // fora de quadro, menus off-canvas, minicart escondido. O frame raiz do
    // Figma cortaria tudo isso de qualquer forma.
    //
    // So vale para quem tem caixa de verdade: um elemento sem area esta em
    // x=0/w=0 e cairia no teste `x + w <= 0`, levando junto a subarvore
    // inteira — foi assim que um menu inteiro sumia.
    if (ctx.opts.simplify !== 'none' && depth > 0 && rect.w > 0 && rect.h > 0) {
      if (rect.x + rect.w <= 0 || rect.x >= ctx.docWidth) {
        ctx.stats.offscreen++;
        return [];
      }
    }

    ctx.stats.elements++;

    // ---- folhas especiais (imagem, svg, canvas, video, form)

    if (tag === 'IMG') {
      const src = el.currentSrc || el.src;
      const id = ctx.addImage(src);
      if (!id) return [];
      return [{
        t: 'IMAGE',
        name: nodeName(el),
        ...rect,
        opacity: round(opacity),
        radius: buildRadius(cs, rect),
        img: { id, scaleMode: objectFitToScaleMode(cs.objectFit) },
        alt: el.alt || undefined,
      }];
    }

    if (tag === 'SVG' || el instanceof SVGSVGElement) {
      let markup = '';
      try {
        const clone = el.cloneNode(true);
        // O Figma precisa de width/height explicitos para dimensionar o SVG.
        clone.setAttribute('width', String(rect.w));
        clone.setAttribute('height', String(rect.h));
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        markup = new XMLSerializer().serializeToString(clone);
      } catch {
        return [];
      }
      if (markup.length > ctx.opts.maxSvgBytes) return [];
      return [{ t: 'SVG', name: nodeName(el), ...rect, opacity: round(opacity), svg: markup }];
    }

    if (tag === 'CANVAS') {
      // Duas falhas silenciosas moram aqui: um canvas contaminado por conteudo
      // cross-origin faz toDataURL lancar, e um contexto WebGL sem
      // preserveDrawingBuffer devolve um quadro em branco (que sai minusculo
      // depois de comprimido). Nos dois casos a foto da tela e o unico caminho.
      let dataUrl = null;
      try {
        dataUrl = el.toDataURL('image/png');
      } catch {
        dataUrl = null;
      }

      const looksBlank = !dataUrl || (dataUrl.length < 2500 && rect.w * rect.h > 10000);
      const id = (!looksBlank && ctx.addImage(dataUrl)) || (ctx.opts.allowShots ? ctx.addShot(el, rect) : null);
      return id ? [{ t: 'IMAGE', name: nodeName(el), ...rect, img: { id, scaleMode: 'FILL' } }] : [];
    }

    if (tag === 'VIDEO') {
      const poster = el.getAttribute('poster') || el.getAttribute('data-poster');
      const id =
        (poster && ctx.addImage(poster)) ||
        videoFrame(el, ctx) ||
        (ctx.opts.allowShots ? ctx.addShot(el, rect) : null);
      if (id) return [{ t: 'IMAGE', name: nodeName(el), ...rect, radius: buildRadius(cs, rect), img: { id, scaleMode: objectFitToScaleMode(cs.objectFit) } }];
      // nada capturavel: cai no tratamento de frame comum abaixo
    }

    // Mapa, player embutido, widget de terceiro: o conteudo mora noutro
    // documento e nao aparece na arvore. Sem a foto, sobra um frame vazio.
    if (tag === 'IFRAME' && ctx.opts.allowShots && rect.w >= 24 && rect.h >= 24) {
      const id = ctx.addShot(el, rect);
      if (id) return [{ t: 'IMAGE', name: nodeName(el), ...rect, radius: buildRadius(cs, rect), img: { id, scaleMode: 'FILL' } }];
    }

    // ---- frame comum

    const fills = buildFills(cs, rect, ctx);
    const border = buildBorder(cs, rect);
    const radius = buildRadius(cs, rect);
    const effects = buildEffects(cs);
    const rotation = extractRotation(cs.transform);
    const clip = cs.overflow !== 'visible' && cs.overflow !== '';

    const node = {
      t: 'FRAME',
      name: nodeName(el),
      ...rect,
      fills: fills.length ? fills : undefined,
      border: border || undefined,
      radius: radius || undefined,
      effects: effects || undefined,
      opacity: opacity < 1 ? round(opacity) : undefined,
      rotation: rotation || undefined,
      // getBoundingClientRect devolve o bbox JA rotacionado, que e maior que o
      // elemento. offsetWidth/Height ignoram o transform, entao o plugin
      // consegue criar o no no tamanho real e girar em torno do centro.
      layout: rotation ? { w: round(el.offsetWidth || rect.w), h: round(el.offsetHeight || rect.h) } : undefined,
      clip: clip || undefined,
      position: cs.position === 'fixed' || cs.position === 'sticky' ? cs.position : undefined,
      href: tag === 'A' && el.getAttribute('href') ? el.getAttribute('href') : undefined,
      children: [],
    };

    // ---- filhos

    const textBlock = LEAF_TAGS.has(tag) ? null : buildTextBlock(el, cs, ctx);

    if (LEAF_TAGS.has(tag)) {
      const field = formFieldText(el, cs, rect, ctx);
      if (field) node.children.push(field);
    } else if (textBlock) {
      // Conteudo puramente inline: um no de texto so, com os trechos
      // formatados preservados por range.
      node.children.push(textBlock);
    } else {
      // A ordem dos filhos no Figma e a ordem de pintura. Seguir so a ordem do
      // DOM faz um header com z-index alto ficar ATRAS do banner seguinte.
      const groups = [];

      for (const child of el.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const nodes = walk(child, ctx, depth + 1);
        if (!nodes.length) continue;

        const childStyle = window.getComputedStyle(child);
        // z-index so vale para elementos posicionados.
        const z = childStyle.position !== 'static' ? parseInt(childStyle.zIndex, 10) || 0 : 0;
        groups.push({ z, nodes });
      }

      // Texto direto do elemento pinta junto com o fluxo normal.
      for (const text of collectText(el, cs, ctx)) groups.push({ z: 0, nodes: [text] });

      // Array.sort e estavel: empates mantem a ordem do DOM.
      groups.sort((a, b) => a.z - b.z);

      const kids = [];
      for (const group of groups) kids.push(...group.nodes);
      node.children = kids;
    }

    // ---- inline sem visual: colapsa no pai
    const hasVisual = !!(node.fills || node.border || node.effects || node.clip || node.rotation);
    const isInline = cs.display.startsWith('inline') && cs.display !== 'inline-block';
    if (ctx.opts.simplify !== 'none' && isInline && !hasVisual && node.children.length) {
      ctx.stats.collapsed++;
      return node.children;
    }

    // ---- folha sem visual e sem conteudo: descarta
    if (ctx.opts.simplify !== 'none' && !hasVisual && !node.children.length) {
      ctx.stats.dropped++;
      return [];
    }

    // ---- bordas nao uniformes viram retangulos filhos
    if (border && !border.uniform) {
      for (const side of border.sides) {
        node.children.push({
          t: 'FRAME',
          name: `border-${side.side}`,
          x: side.rect.x,
          y: side.rect.y,
          w: side.rect.w,
          h: side.rect.h,
          fills: [solidPaint(side.color)],
        });
      }
      node.border = undefined;
    }

    return [node];
  }

  // ------------------------------------------------------- CSS custom props

  /**
   * Coleta as CSS custom properties (--tokens) declaradas na pagina.
   *
   * `extraNames` vem do servidor: ele intercepta as folhas de estilo pela rede,
   * incluindo as de CDN que o browser bloqueia por cross-origin. O valor final
   * sempre sai do computed style do :root, que ja resolve referencias encadeadas.
   */
  function collectCssVars(extraNames) {
    const vars = new Map();
    const rootStyle = window.getComputedStyle(document.documentElement);

    const record = (name, value) => {
      if (!name.startsWith('--')) return;
      const resolved = (rootStyle.getPropertyValue(name) || value || '').trim();
      if (!resolved || resolved.length > 200) return;
      if (vars.has(name)) return;

      const color = parseColor(resolved);
      let type = 'STRING';
      if (color) type = 'COLOR';
      else if (/^-?[\d.]+(px|rem|em|%)?$/.test(resolved)) type = 'FLOAT';

      vars.set(name, {
        name,
        value: resolved,
        type,
        color: color || undefined,
        number: type === 'FLOAT' ? round(len(resolved)) : undefined,
      });
    };

    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules; // folhas cross-origin lancam SecurityError
      } catch {
        continue;
      }
      if (!rules) continue;

      const visit = (ruleList) => {
        for (const rule of Array.from(ruleList)) {
          if (rule.style) {
            for (const prop of Array.from(rule.style)) {
              if (prop.startsWith('--')) record(prop, rule.style.getPropertyValue(prop));
            }
          }
          if (rule.cssRules) visit(rule.cssRules);
        }
      };

      try {
        visit(rules);
      } catch {
        /* ignora folhas problematicas */
      }
    }

    for (const name of extraNames || []) record(name, '');

    return Array.from(vars.values());
  }

  /**
   * Remove nos de texto identicos empilhados no mesmo ponto.
   *
   * Varias paginas renderizam o mesmo titulo duas vezes (uma copia para
   * animacao ou para medir largura). No browser uma some por baixo da outra;
   * no Figma viram duas camadas sobrepostas que deixam o texto borrado.
   */
  function dedupeTexts(node, seen) {
    if (!node.children || !node.children.length) return;

    node.children = node.children.filter((child) => {
      if (child.t !== 'TEXT') return true;
      const key = child.x + '|' + child.y + '|' + child.text.size + '|' + child.text.chars;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const child of node.children) dedupeTexts(child, seen);
  }

  // -------------------------------------------------------------- fundo raiz

  /** O background da pagina pode estar em <html> ou em <body> (propagacao CSS). */
  function pageBackground() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const color = parseColor(window.getComputedStyle(el).backgroundColor);
      if (color && color.a > 0) return solidPaint(color);
    }
    return solidPaint({ r: 1, g: 1, b: 1, a: 1 });
  }

  // ------------------------------------------------------------------ export

  const W2F = {
    /**
     * Congela elementos position:fixed na posicao em que estao AGORA,
     * convertendo-os para absolute.
     *
     * Precisa rodar com a pagina no topo e ANTES do servidor expandir o
     * viewport para a altura total: um overlay fixed de 100% de altura viraria
     * uma cortina de 6000px cobrindo a captura inteira. Congelado, cada um
     * fica exatamente onde o visitante o veria ao abrir a pagina.
     *
     * `sticky` fica de FORA de proposito. Um elemento sticky ocupa espaco no
     * fluxo normal; transforma-lo em absolute o remove do fluxo e faz a pagina
     * inteira subir — um header sticky de 134px deslocava todo o conteudo
     * abaixo dele e a captura saia com a geometria errada. Alem disso, com a
     * pagina no topo o sticky ja esta na sua posicao natural: nao ha o que
     * congelar.
     *
     * Duas armadilhas moram aqui, e as duas ja custaram um bug:
     *
     * 1. `getBoundingClientRect()` devolve a caixa DEPOIS do transform. Gravar
     *    esse valor em `top`/`left` faz o transform ser aplicado de novo, e o
     *    elemento anda duas vezes — um banner de LGPD com
     *    `transform: translate(-664px, -20px)` saia em x=-608 em vez de x=56.
     *    Por isso medimos a caixa com o transform desligado.
     *
     * 2. `absolute` se resolve contra o bloco conteiner (o ancestral
     *    posicionado), nao contra o documento. Um overlay dentro de um
     *    `header{position:relative}` descia a altura do header inteiro. Em vez
     *    de procurar o offsetParent — que ainda erraria com ancestrais que
     *    criam bloco conteiner por `transform`/`filter`/`contain` — congelamos,
     *    lemos o resultado e corrigimos pela diferenca medida.
     */
    freezeFixed() {
      const targets = [];

      for (const el of document.querySelectorAll('*')) {
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        targets.push({ el, visual: rect, transform: cs.transform });
      }

      for (const { el, visual, transform } of targets) {
        // (1) caixa de layout: a mesma medida, sem o transform proprio.
        let layout = visual;
        if (transform && transform !== 'none') {
          const previous = el.style.getPropertyValue('transform');
          const priority = el.style.getPropertyPriority('transform');
          el.style.setProperty('transform', 'none', 'important');
          layout = el.getBoundingClientRect();
          if (previous) el.style.setProperty('transform', previous, priority);
          else el.style.removeProperty('transform');
        }

        // border-box: o rect medido inclui borda e padding. Sem isto, um
        // elemento content-box incharia por essa diferenca.
        el.style.setProperty('box-sizing', 'border-box', 'important');
        el.style.setProperty('position', 'absolute', 'important');
        el.style.setProperty('width', layout.width + 'px', 'important');
        el.style.setProperty('height', layout.height + 'px', 'important');
        el.style.setProperty('right', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');

        let top = layout.top + window.scrollY;
        let left = layout.left + window.scrollX;
        el.style.setProperty('top', top + 'px', 'important');
        el.style.setProperty('left', left + 'px', 'important');

        // (2) confere onde o elemento realmente foi parar e corrige o desvio.
        const landed = el.getBoundingClientRect();
        const dx = visual.left - landed.left;
        const dy = visual.top - landed.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          el.style.setProperty('top', top + dy + 'px', 'important');
          el.style.setProperty('left', left + dx + 'px', 'important');
        }

        el.setAttribute('data-w2f-was-fixed', '1');
      }

      return targets.length;
    },

    /**
     * Esconde tudo que atravessa a regiao de um shot sem fazer parte dele.
     *
     * Um screenshot recorta a tela, nao o elemento: a primeira versao trouxe o
     * header, o logo e as setas do carrossel gravados dentro do quadro do
     * video — e esses mesmos elementos ainda vinham como nos por cima, entao
     * cada texto aparecia duas vezes no Figma.
     *
     * `visibility: hidden` de proposito, em vez de `display: none`: o elemento
     * some sem sair do fluxo, entao a geometria da pagina nao muda e as
     * coordenadas do recorte continuam validas. Ancestrais e descendentes do
     * alvo ficam de fora — esconder um ancestral esconderia o alvo junto.
     */
    beginShot(id) {
      const target = shotTargets.get(id);
      if (!target) return false;

      const box = target.getBoundingClientRect();
      maskedForShot = [];

      for (const el of document.querySelectorAll('*')) {
        if (el === target || el.contains(target) || target.contains(el)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.right <= box.left || rect.left >= box.right) continue;
        if (rect.bottom <= box.top || rect.top >= box.bottom) continue;

        maskedForShot.push({
          el,
          value: el.style.getPropertyValue('visibility'),
          priority: el.style.getPropertyPriority('visibility'),
        });
        el.style.setProperty('visibility', 'hidden', 'important');
      }

      return true;
    },

    /** Desfaz o que beginShot escondeu. */
    endShot() {
      for (const { el, value, priority } of maskedForShot) {
        if (value) el.style.setProperty('visibility', value, priority);
        else el.style.removeProperty('visibility');
      }
      const count = maskedForShot.length;
      maskedForShot = [];
      return count;
    },

    /**
     * Captura completa feita dentro do browser — usada pela extensao e pelo
     * bookmarklet. O servidor nao usa isto: la o Playwright controla o scroll
     * e o Node baixa as imagens.
     *
     * `fetchImage(url)` deve devolver { mime, data(base64) } ou { svg } ou null.
     * Quem chama decide como buscar: a extensao usa o background script (sem
     * CORS), o bookmarklet usa fetch da propria pagina.
     */
    async captureDocument(options) {
      const opts = options || {};
      const report = opts.onProgress || (() => {});

      // Rola a pagina inteira para disparar lazy-load e volta ao topo.
      report('carregando imagens da página…');
      const step = Math.max(400, window.innerHeight * 0.8);
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 250));

      try {
        await document.fonts.ready;
      } catch (err) {
        /* navegador sem a API */
      }

      // Congela os fixed na posicao em que estao com a pagina no topo.
      W2F.freezeFixed();

      // O browser bloqueia a leitura de folhas de estilo de outro dominio, o
      // que esconderia a maior parte dos design tokens. Quem chama pode passar
      // um fetchText (a extensao usa o background script) para buscar o CSS
      // sem essa restricao; os valores continuam sendo resolvidos na pagina.
      let extraVarNames = [];
      if (opts.fetchText) {
        report('lendo folhas de estilo…');
        const blocked = [];
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            if (sheet.cssRules) continue; // acessivel, o extract ja cobre
          } catch (err) {
            if (sheet.href) blocked.push(sheet.href);
          }
        }

        const names = new Set();
        await Promise.all(
          blocked.slice(0, 30).map(async (href) => {
            try {
              const text = await opts.fetchText(href);
              if (!text) return;
              for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) names.add(match[1]);
            } catch (err) {
              /* folha inacessivel tambem pelo background */
            }
          })
        );
        extraVarNames = Array.from(names).slice(0, 2000);
      }

      report('lendo a estrutura…');
      const result = W2F.extract({ simplify: opts.simplify, extraVarNames });

      report('baixando imagens…');
      const images = {};
      const entries = Object.entries(result.images);
      let done = 0;

      // Poucas em paralelo: o objetivo e nao brigar com a propria pagina.
      const queue = entries.slice();
      await Promise.all(
        Array.from({ length: Math.min(6, queue.length) }, async () => {
          while (queue.length) {
            const entry = queue.shift();
            if (!entry) break;
            const [id, info] = entry;
            try {
              const fetched = await opts.fetchImage(info.src);
              if (fetched) images[id] = fetched;
              else images[id] = { error: 'nao foi possivel baixar' };
            } catch (err) {
              images[id] = { error: String((err && err.message) || err).slice(0, 100) };
            }
            done++;
            if (done % 5 === 0) report(`baixando imagens… ${done}/${entries.length}`);
          }
        })
      );

      return {
        docs: [
          {
            viewport: Math.round(window.innerWidth),
            colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            tree: result.tree,
            images,
            fonts: result.fonts,
            cssVars: result.cssVars,
            meta: result.meta,
          },
        ],
        source: 'browser',
      };
    },

    extract(userOpts) {
      // allowShots so vale para quem controla o browser (o servidor). Na
      // extensao o extractor roda dentro da pagina, sem acesso a screenshot.
      const opts = Object.assign(
        { simplify: 'empty', maxDepth: 60, maxSvgBytes: 400000, keepInvisible: false, allowShots: false },
        userOpts || {}
      );

      shotTargets = new Map(); // uma extracao nao herda os alvos da anterior
      const ctx = createContext(opts);
      ctx.stats = { elements: 0, dropped: 0, collapsed: 0, offscreen: 0, collapsedDetails: 0 };
      ctx.docWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);

      const started = Date.now();
      const children = walk(document.body, ctx, 0);

      const width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );

      const root = { children };
      dedupeTexts(root, new Set());

      const tree = {
        t: 'FRAME',
        name: document.title ? document.title.slice(0, 60) : location.hostname,
        x: 0,
        y: 0,
        w: round(width),
        h: round(height),
        fills: [pageBackground()],
        clip: true,
        children: root.children,
      };

      return {
        tree,
        images: ctx.images,
        fonts: Array.from(ctx.fonts.values()),
        cssVars: collectCssVars(opts.extraVarNames),
        meta: {
          url: location.href,
          title: document.title,
          width: round(width),
          height: round(height),
          stats: ctx.stats,
          extractMs: Date.now() - started,
        },
      };
    },
  };

  window.__W2F = W2F;
})();
