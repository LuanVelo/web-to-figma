/**
 * Content script injetado na página pelo popup.
 *
 * Orquestra a captura e entrega o arquivo. Roda no isolated world, que tem
 * acesso completo ao DOM e ao CSSOM — é tudo que o extractor precisa.
 *
 * O download sai por um <a download> em vez da API chrome.downloads porque o
 * Safari não implementa essa API. Assim o mesmo código serve os dois browsers.
 */
(async () => {
  const api = globalThis.browser ?? globalThis.chrome;

  // O popup injeta extractor.js antes deste arquivo, no mesmo world.
  if (!window.__W2F) {
    return { ok: false, error: 'extractor nao carregou' };
  }

  const options = window.__W2F_OPTIONS || {};

  /**
   * O resultado vai por mensagem, não pelo retorno do script: o
   * chrome.scripting.executeScript com `files` não espera a Promise de um
   * script assíncrono, então o valor de retorno se perderia.
   */
  const send = (message) => {
    try {
      api.runtime.sendMessage(message);
    } catch (err) {
      // O popup pode ter fechado — a captura segue e o arquivo baixa igual.
    }
  };

  const report = (label) => send({ type: 'progress', label });

  /** Pede algo ao background e devolve null em qualquer falha. */
  const ask = (type, url) =>
    new Promise((resolve) => {
      try {
        api.runtime.sendMessage({ type, url }, (result) => {
          if (api.runtime.lastError || !result || result.error) resolve(null);
          else resolve(result);
        });
      } catch (err) {
        resolve(null);
      }
    });

  try {
    const payload = await window.__W2F.captureDocument({
      simplify: options.simplify === false ? 'none' : 'empty',
      onProgress: report,
      // Delega a busca ao background: ele não sofre CORS nem CSP da página.
      fetchImage: (url) => ask('fetchImage', url),
      fetchText: (url) => ask('fetchText', url),
    });

    report('gerando arquivo…');

    const hostname = location.hostname.replace(/^www\./, '');
    const name = `${hostname}-${payload.docs[0].viewport}px.w2f`;

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 30000);

    const doc = payload.docs[0];
    const withImages = Object.values(doc.images).filter((i) => i.data || i.svg).length;

    const summary = {
      ok: true,
      file: name,
      elements: doc.meta.stats.elements,
      images: withImages,
      imagesTotal: Object.keys(doc.images).length,
      viewport: doc.viewport,
      sizeMB: Math.round((blob.size / 1048576) * 10) / 10,
    };

    send({ type: 'done', summary });
    return summary;
  } catch (err) {
    const error = String(err?.message || err).slice(0, 200);
    send({ type: 'failed', error });
    return { ok: false, error };
  }
})();
