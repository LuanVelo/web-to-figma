/**
 * Reconstroi e reinstala a extensao do Safari.
 *
 * O Safari nao carrega uma pasta solta como o Chrome: a extensao precisa vir
 * dentro de um app. Rode isto sempre que mexer em qualquer arquivo de
 * extension/ — inclusive depois de editar server/extractor.js.
 *
 * Detalhes que este script resolve e que quebram o build feito na mao:
 *  - o Xcode instalado nao e o selecionado no xcode-select (que exige sudo)
 *  - o projeto vive numa pasta do iCloud Drive, que carimba xattrs no bundle
 *    e invalida a assinatura — por isso o build sai em /tmp
 *  - assinatura ad-hoc faz o Safari esconder a extensao a menos que
 *    "Permitir Extensoes Nao Assinadas" esteja ligado, e essa opcao se desliga
 *    a cada reinicio. Assinando com a identidade real ela fica permanente.
 *
 *   npm run safari
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(root, 'safari', 'web to figma');
const project = path.join(projectDir, 'web to figma.xcodeproj');
const buildDir = '/tmp/w2f-xcode-build';
const installed = '/Applications/web to figma.app';

if (!fs.existsSync(project)) {
  console.error('projeto do Safari nao encontrado em safari/');
  console.error('gere com: xcrun safari-web-extension-converter extension --app-name "web to figma" \\');
  console.error('            --bundle-identifier io.github.luanvelo.web-to-figma --project-location safari \\');
  console.error('            --macos-only --swift --no-open --no-prompt --force');
  process.exit(1);
}

const developerDir = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer';
const xcodebuild = path.join(developerDir, 'usr', 'bin', 'xcodebuild');

if (!fs.existsSync(xcodebuild)) {
  console.error(`xcodebuild nao encontrado em ${xcodebuild} — o Xcode completo precisa estar instalado.`);
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });

console.log('sincronizando o extractor…');
run(process.execPath, [path.join(root, 'tools', 'sync-extension.mjs')]);

// O iCloud Drive marca os arquivos e o codesign recusa o bundle depois.
console.log('limpando atributos estendidos…');
try {
  run('xattr', ['-cr', path.join(root, 'extension')]);
} catch (err) {
  /* nada a limpar */
}

/**
 * Descobre a identidade de assinatura no keychain.
 *
 * O Team ID fica no campo OU do certificado — o numero que aparece entre
 * parenteses no nome e o do membro, nao o do time. Confundir os dois faz o
 * xcodebuild reclamar de "No Account for Team".
 */
function findSigningIdentity() {
  let identities;
  try {
    identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch (err) {
    return null;
  }

  const match = /"((?:Apple Development|Developer ID Application|Mac Developer)[^"]+)"/.exec(identities);
  if (!match) return null;

  const name = match[1];
  let team = null;
  try {
    const pem = run('security', ['find-certificate', '-c', name, '-p']);
    const subject = run('openssl', ['x509', '-noout', '-subject'], { input: pem });
    const ou = /OU\s*=\s*([A-Z0-9]{10})/.exec(subject);
    if (ou) team = ou[1];
  } catch (err) {
    /* segue sem team */
  }

  return { name, team };
}

const identity = findSigningIdentity();

const signingArgs = identity?.team
  ? [`CODE_SIGN_IDENTITY=${identity.name}`, `DEVELOPMENT_TEAM=${identity.team}`, 'PROVISIONING_PROFILE_SPECIFIER=']
  : ['CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM='];

if (identity?.team) {
  console.log(`assinando como ${identity.name} (team ${identity.team})`);
} else {
  console.log('nenhuma identidade encontrada — assinando ad-hoc');
  console.log('atencao: com ad-hoc o Safari so mostra a extensao se');
  console.log('"Desenvolvedor → Permitir Extensoes Nao Assinadas" estiver ligado (reseta a cada reinicio).');
}

console.log('compilando (leva ~30s)…');
fs.rmSync(buildDir, { recursive: true, force: true });

try {
  run(xcodebuild, [
    '-project', project,
    '-scheme', 'web to figma',
    '-configuration', 'Release',
    '-derivedDataPath', buildDir,
    'CODE_SIGN_STYLE=Manual',
    ...signingArgs,
    'build',
  ], { env: { ...process.env, DEVELOPER_DIR: developerDir } });
} catch (err) {
  const output = String(err.stdout || '') + String(err.stderr || '');
  const lines = output.split('\n').filter((l) => /error:|BUILD FAILED|detritus/.test(l));
  console.error('\nbuild falhou:\n' + (lines.slice(0, 8).join('\n') || output.slice(-1200)));
  process.exit(1);
}

const built = path.join(buildDir, 'Build', 'Products', 'Release', 'web to figma.app');
if (!fs.existsSync(built)) {
  console.error('build terminou mas o app nao apareceu em ' + built);
  process.exit(1);
}

console.log('instalando em /Applications…');
fs.rmSync(installed, { recursive: true, force: true });
run('cp', ['-R', built, '/Applications/']);
run('codesign', ['--verify', '--deep', '--strict', installed]);

// O macOS registra todo .appex que aparece no disco, entao um build esquecido
// vira uma entrada fantasma na lista de extensoes do Safari. Some com ele.
try {
  const appex = path.join(built, 'Contents', 'PlugIns', 'web to figma Extension.appex');
  if (fs.existsSync(appex)) run('pluginkit', ['-r', appex]);
} catch (err) {
  /* nada registrado */
}
fs.rmSync(buildDir, { recursive: true, force: true });

console.log('\n✓ /Applications/web to figma.app atualizado');
console.log('\nSe for a primeira vez: abra o app uma vez, depois habilite em');
console.log('Safari → Ajustes → Extensões, e escolha "Permitir em Todos os Sites".');
console.log('Se ja estava habilitada, feche e reabra o Safari para pegar a versao nova.\n');
