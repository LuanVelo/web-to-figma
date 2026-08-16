/**
 * Testa a UI do plugin sem Figma e sem servidor.
 *
 * Carrega plugin/ui.html num Chromium com dois dubles: o `fetch` faz o papel
 * do servidor de captura (respondendo /health e /import) e um listener de
 * message faz o papel do code.js (respondendo progress e depois done).
 *
 * O que interessa aqui e a fila da aba URL: ordem dos sites, um request de
 * cada vez, erro no meio nao derrubando o resto, e o estado da interface no
 * fim de tudo.
 *
 *   node tools/test-ui.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = pathToFileURL(path.join(__dirname, '..', 'plugin', 'ui.html')).href;

const FAIL_MARK = 'quebra'; // URL contendo isso faz o servidor falso falhar

const failures = [];

function check(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail == null ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

// --------------------------------------------------------------- dubles

/**
 * Roda no contexto da pagina antes dos scripts da UI.
 *
 * Nota: num iframe do Figma `parent` e o main thread; aqui a pagina e o
 * topo, entao `parent === window` e o postMessage volta para nos mesmos —
 * o que serve perfeitamente para imitar as respostas do code.js.
 */
const stubs = (failMark) => {
  window.__calls = [];
  window.__inFlight = 0;
  window.__maxInFlight = 0;

  const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  window.fetch = (url, init) => {
    if (String(url).endsWith('/health')) return json({ ok: true, version: 'teste' });

    const body = JSON.parse(init.body);
    window.__calls.push({ url: body.url, viewports: body.viewports });
    window.__inFlight++;
    window.__maxInFlight = Math.max(window.__maxInFlight, window.__inFlight);

    return new Promise((resolve) => {
      // Demora de proposito: sem ela, dois requests simultaneos passariam
      // despercebidos pelo contador de concorrencia.
      setTimeout(() => {
        window.__inFlight--;
        if (body.url.includes(failMark)) return resolve(json({ error: 'servidor falso recusou' }));
        resolve(
          json({
            docs: [
              {
                viewport: body.viewports[0],
                tree: { x: 0, y: 0, w: body.viewports[0], h: 800, children: [] },
                images: {},
                fonts: [],
                cssVars: [],
                meta: { url: body.url, stats: { elements: 10 } },
              },
            ],
          })
        );
      }, 40);
    });
  };

  // Faz o papel do code.js: confirma o build depois de um progresso.
  window.addEventListener('message', (event) => {
    const msg = event.data && event.data.pluginMessage;
    if (!msg || msg.type !== 'build') return;
    setTimeout(() => window.postMessage({ pluginMessage: { type: 'progress', value: 0.5, label: 'montando…' } }, '*'), 5);
    setTimeout(
      () => window.postMessage({ pluginMessage: { type: 'done', summary: 'pronto: 10 camadas, 1 viewport em 0.1s' } }, '*'),
      20
    );
  });
};

// ---------------------------------------------------------------- helpers

async function openUI(browser) {
  const page = await browser.newPage();
  await page.addInitScript(stubs, FAIL_MARK);
  await page.goto(UI);
  await page.click('.tab[data-tab="url"]');
  await page.waitForSelector('#go:not([disabled])'); // espera o ping do servidor falso
  return page;
}

/** Preenche a fila, criando as linhas que faltarem. */
async function fillSites(page, urls) {
  for (let i = 1; i < urls.length; i++) await page.click('#addSite');
  const inputs = await page.$$('#sites input');
  for (let i = 0; i < urls.length; i++) await inputs[i].fill(urls[i]);
}

/** Clica em Importar e observa a interface enquanto a fila roda. */
async function importAndWatch(page) {
  const samples = [];
  await page.click('#go');

  while (await page.$('#go[disabled]')) {
    samples.push(
      await page.evaluate(() => ({
        totalBar: document.getElementById('barTotal').classList.contains('on'),
        queueText: document.getElementById('queueLabel').textContent,
        inputsLocked: Array.from(document.querySelectorAll('#sites input')).every((i) => i.disabled),
        addLocked: document.getElementById('addSite').disabled,
      }))
    );
    await page.waitForTimeout(15);
  }

  return samples;
}

const finalState = (page) =>
  page.evaluate(() => ({
    dots: Array.from(document.querySelectorAll('#sites .dot')).map((d) => d.className.replace('dot', '').trim()),
    errors: Array.from(document.querySelectorAll('#sites .dot')).map((d) => d.title),
    status: document.getElementById('statusText').textContent,
    statusKind: document.getElementById('dot').className.replace('dot', '').trim(),
    totalBar: document.getElementById('barTotal').classList.contains('on'),
    bar: document.getElementById('bar').classList.contains('on'),
    goEnabled: !document.getElementById('go').disabled,
    inputsEnabled: Array.from(document.querySelectorAll('#sites input')).every((i) => !i.disabled),
  }));

// ------------------------------------------------------------------ testes

const browser = await chromium.launch();

// --- 1. fila de tres sites com um erro no meio

console.log('\nfila de 3 sites (o do meio falha)');
{
  const page = await openUI(browser);
  const urls = ['https://um.com', `https://${FAIL_MARK}.com`, 'https://tres.com'];
  await fillSites(page, urls);

  const samples = await importAndWatch(page);
  const calls = await page.evaluate(() => window.__calls);
  const maxInFlight = await page.evaluate(() => window.__maxInFlight);
  const state = await finalState(page);

  check(calls.length === 3, '3 capturas pedidas ao servidor', `foram ${calls.length}`);
  check(
    calls.map((c) => c.url).join() === urls.join(),
    'capturas na ordem da lista',
    calls.map((c) => c.url).join(' → ')
  );
  check(maxInFlight === 1, 'um request de cada vez', `pico de ${maxInFlight}`);
  check(state.dots.join() === 'ok,err,ok', 'estados das linhas: ok, err, ok', state.dots.join(' · '));
  check(!!state.errors[1], 'linha com erro guarda a mensagem', state.errors[1]);
  check(state.status === '2 importados · 1 falhou', 'resumo final da fila', state.status);
  check(state.statusKind === 'err', 'resumo marcado como erro quando algo falha', state.statusKind);
  check(
    samples.some((s) => s.totalBar),
    'barra do total aparece com mais de um site'
  );
  check(
    samples.some((s) => /site 1 de 3/.test(s.queueText)) && samples.some((s) => /site 3 de 3/.test(s.queueText)),
    'contador da fila anda de 1 a 3',
    samples.map((s) => s.queueText).join(' | ')
  );
  check(
    samples.every((s) => s.inputsLocked && s.addLocked),
    'campos e "+ site" travados durante a fila'
  );
  check(state.goEnabled && state.inputsEnabled, 'interface liberada no fim');
  check(!state.totalBar && !state.bar, 'barras somem no fim');

  // O ping do servidor roda a cada 4s e ja apagou o resumo da fila uma vez.
  await page.waitForTimeout(5000);
  check(
    (await finalState(page)).status === state.status,
    'resumo sobrevive ao ping do servidor',
    (await finalState(page)).status
  );

  await page.close();
}

// --- 2. site unico: sem barra de total, resumo do proprio build

console.log('\nsite único');
{
  const page = await openUI(browser);
  await fillSites(page, ['https://unico.com']);

  const samples = await importAndWatch(page);
  const state = await finalState(page);

  check(
    samples.every((s) => !s.totalBar),
    'barra do total não aparece com um site só'
  );
  check(state.dots.join() === 'ok', 'linha marcada como ok', state.dots.join());
  check(/^pronto:/.test(state.status), 'status mostra o resumo do build', state.status);

  await page.close();
}

// --- 3. validacoes e duplicatas

console.log('\nvalidações');
{
  const page = await openUI(browser);

  await page.click('#go');
  check((await finalState(page)).status === 'informe ao menos uma URL', 'fila vazia é recusada');

  await fillSites(page, ['https://repetido.com', 'https://repetido.com', '']);
  await importAndWatch(page);
  const calls = await page.evaluate(() => window.__calls);
  check(calls.length === 1, 'URL repetida importa uma vez só', `${calls.length} capturas`);

  // Sem viewport marcado, nem sai do lugar.
  await page.evaluate(() => {
    for (const cb of document.querySelectorAll('.vp input[type="checkbox"]')) {
      if (cb.checked) cb.click();
    }
  });
  await page.click('#go');
  check((await finalState(page)).status === 'selecione ao menos um viewport', 'exige ao menos um viewport');

  await page.close();
}

// --- 4. manipulacao das linhas

console.log('\nlinhas da lista');
{
  const page = await openUI(browser);

  check(await page.$eval('#sites', (el) => el.classList.contains('single')), 'começa com uma linha só');

  await page.click('#addSite');
  await page.click('#addSite');
  check((await page.$$('#sites .site')).length === 3, '"+ site" adiciona linhas');
  check(!(await page.$eval('#sites', (el) => el.classList.contains('single'))), 'remover aparece com mais de uma linha');

  await page.click('#sites .site:nth-child(2) .rm');
  check((await page.$$('#sites .site')).length === 2, 'remover tira a linha');

  // Colar uma lista pronta distribui em varias linhas.
  await page.$eval('#sites input', (input) => {
    const data = new DataTransfer();
    data.setData('text', 'https://a.com\nhttps://b.com\nhttps://c.com');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const pasted = await page.$$eval('#sites input', (els) => els.map((e) => e.value));
  check(
    pasted.slice(0, 3).join() === 'https://a.com,https://b.com,https://c.com',
    'colar lista multilinha vira várias linhas',
    pasted.join(' | ')
  );

  while ((await page.$$('#sites .site')).length > 1) await page.click('#sites .site:last-child .rm');
  check(
    await page.$eval('#sites .rm', (el) => getComputedStyle(el).visibility === 'hidden'),
    'com uma linha só o remover fica oculto'
  );

  // A guarda de nunca ficar sem campo (o clique nem chega ao usuario, ja que
  // o botao esta oculto — aqui disparamos direto para conferir o caminho).
  await page.$eval('#sites .rm', (el) => el.click());
  check((await page.$$('#sites .site')).length === 1, 'nunca fica sem campo');
  check((await page.$eval('#sites input', (i) => i.value)) === '', 'última linha é limpa ao remover');

  await page.close();
}

await browser.close();

if (failures.length) {
  console.log(`\n✗ ${failures.length} verificação(ões) falharam:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}

console.log('\n✓ fila da aba URL funcionando\n');
