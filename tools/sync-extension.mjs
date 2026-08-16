/**
 * Copia o extractor para dentro da extensao.
 *
 * Uma extensao so pode empacotar arquivos da propria pasta, entao o
 * server/extractor.js precisa ser espelhado. A fonte de verdade e sempre
 * server/extractor.js — a copia leva um aviso no topo.
 *
 *   node tools/sync-extension.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'server', 'extractor.js');
const target = path.join(root, 'extension', 'extractor.js');

const banner = `/* ===========================================================================
 * ARQUIVO GERADO — nao edite aqui.
 * Fonte: server/extractor.js  ·  Atualize com: npm run sync
 * =========================================================================== */

`;

fs.writeFileSync(target, banner + fs.readFileSync(source, 'utf8'));

const bytes = fs.statSync(target).size;
console.log(`extension/extractor.js atualizado (${Math.round(bytes / 1024)}KB)`);
