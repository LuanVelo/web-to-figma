/**
 * Popup: dispara a captura na aba ativa e mostra o andamento.
 *
 * O trabalho pesado acontece no content script — se o popup fechar no meio,
 * a captura continua e o arquivo é baixado do mesmo jeito.
 */
const api = globalThis.browser ?? globalThis.chrome;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const goBtn = $('go');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

activeTab().then((tab) => {
  if (!tab) return;
  try {
    $('site').textContent = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    $('site').textContent = tab.url || '';
  }
});

// O content script manda andamento e resultado por aqui.
api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'progress') {
    setStatus(message.label);
    return;
  }

  if (message?.type === 'failed') {
    setStatus('falhou: ' + message.error, 'err');
    goBtn.disabled = false;
    return;
  }

  if (message?.type === 'done') {
    const s = message.summary;
    setStatus(
      `${s.file} baixado — ${s.elements} elementos, ${s.images}/${s.imagesTotal} imagens, ${s.sizeMB}MB`,
      'ok'
    );

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Agora abra o plugin no Figma, aba Arquivo, e solte esse arquivo.';
    statusEl.appendChild(hint);

    goBtn.disabled = false;
  }
});

goBtn.addEventListener('click', async () => {
  const tab = await activeTab();

  if (!tab || !/^https?:/i.test(tab.url || '')) {
    setStatus('esta página não pode ser capturada — abra um site http(s).', 'err');
    return;
  }

  goBtn.disabled = true;
  setStatus('preparando…');

  const simplify = $('simplify').checked;

  try {
    // As opções entram antes: o collect.js as lê de window.__W2F_OPTIONS.
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: (value) => {
        window.__W2F_OPTIONS = { simplify: value };
      },
      args: [simplify],
    });

    // O resultado chega pelo listener de mensagens acima, não por aqui: com
    // `files`, o executeScript não aguarda o script assíncrono terminar.
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['extractor.js', 'collect.js'],
    });

    setStatus('capturando… pode fechar esta janelinha, o download continua.');
  } catch (err) {
    setStatus('falhou: ' + String(err?.message || err).slice(0, 160), 'err');
    goBtn.disabled = false;
  }
});
