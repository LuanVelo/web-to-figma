# Arquitetura e decisões

Este documento registra *por que* o projeto é como é, e as armadilhas que custaram caro para descobrir. Se você for mexer no `extractor.js`, leia a seção "Armadilhas do browser" antes — quase toda regra estranha ali existe porque um site quebrou.

## O problema central

Um plugin do Figma roda num sandbox sem DOM e sem engine de layout. Baixar o HTML de uma página não diz onde cada elemento cai na tela, nem qual cor o CSS resolveu depois de cascata, variáveis e media queries. Só um browser sabe isso.

Logo, alguém precisa **renderizar a página de verdade** antes do plugin entrar em ação. Daí as duas frentes:

- **Extensão** — o browser do usuário é o renderizador. Sem servidor, sem custo, funciona em páginas logadas.
- **Servidor local** — Playwright controla um Chromium. Serve para capturar vários viewports numa tacada.

As duas usam o **mesmo `extractor.js`**. `server/extractor.js` é a fonte; `npm run sync` espelha para `extension/`, porque uma extensão só empacota arquivos da própria pasta.

## Fluxo

```
        ┌─ extensão ─────────────┐        ┌─ servidor ──────────────┐
        │ popup → collect.js     │        │ Playwright abre a URL   │
        │ background busca img   │        │ Node baixa as imagens   │
        └────────────┬───────────┘        └────────────┬────────────┘
                     │      extractor.js roda na página │
                     └───────────────┬──────────────────┘
                                     ▼
                          árvore JSON + imagens + fontes
                                     ▼
                        plugin/ui.html  (decodifica base64)
                                     ▼
                        plugin/code.js  (monta no canvas)
```

Coordenadas trafegam **absolutas ao documento**; o plugin converte para relativas ao pai na hora de montar. Isso evita propagar erro de acumulação e sobrevive a transforms.

## Armadilhas do browser

Cada item aqui corresponde a um bug real, encontrado num site real.

**`getClientRects()` devolve um retângulo por caixa inline, não por linha.**
`R$ <strong>179,10</strong>` gera dois retângulos lado a lado na *mesma* linha. Contar retângulos fazia o preço passar por texto multilinha, ganhar largura de requebra e quebrar ao meio. Por isso existe `countLines()`, que agrupa por `top`.

**`text-decoration` não aparece no computed style do filho.**
Um `<span>` dentro de `<div style="text-decoration:line-through">` reporta `none`. A decoração propaga visualmente, mas não pelo CSSOM. `textDecoration()` sobe a árvore até achar quem declarou, parando em elementos que criam contexto de formatação próprio.

**Texto que flui junto não pode virar nós separados.**
"15% off na sua primeira compra **PRIMEIRACOMPRA**" são dois text nodes irmãos. Um nó por text node colocava os dois no início da linha, empilhados. Hoje um bloco inline vira **um** nó de texto, com os trechos formatados preservados via `setRangeFontName`/`setRangeFills`.

**`display: contents` devolve rect `[0,0,0,0]`.**
O elemento não gera caixa; só os filhos aparecem. O filtro de "conteúdo fora da tela" fazia `x + w <= 0` — com zeros, verdadeiro — e descartava o elemento **e toda a subárvore**. Um menu inteiro e o slideshow de um hero sumiam assim. Hoje o filtro só se aplica a quem tem área, e `display: contents` apenas repassa os filhos.

**`<details>` fechado ainda responde `visibility: visible`.**
O Chrome calcula layout e devolve rect válido para o conteúdo escondido. Sem tratar isso, todo mega-menu e todo FAQ colapsado entram na captura, empilhados sobre o conteúdo real. Só o `<summary>` deve passar.

**`position: sticky` não pode virar `absolute`.**
Sticky ocupa espaço no fluxo. Convertê-lo tira o elemento do fluxo e **sobe a página inteira** — num teste, +699px de deslocamento e o hero indo de `y=182` para `y=0`. Só `fixed` é congelado, e `fixed` já está fora do fluxo, então não afeta ninguém.

**`fixed` precisa ser congelado antes do resize (só no servidor).**
O servidor expande o viewport até a altura total da página. Um overlay `fixed` de `height:100%` viraria uma cortina de 6000px cobrindo tudo. Congelar converte para `absolute` na posição que o visitante veria.

**Ordem do DOM não é ordem de pintura.**
Um header com `z-index` alto declarado antes do banner ficava atrás dele. Os filhos são ordenados por z-index efetivo, com `sort` estável para preservar a ordem do DOM nos empates.

**Cores modernas não vêm em `rgb()`.**
`oklch()`, `color-mix()` e `lab()` chegam crus no computed style. `parseColor()` normaliza tudo por um canvas 2D, que aceita qualquer sintaxe válida e devolve forma canônica.

**Content-type de imagem mente.**
`image/pjpeg`, `application/octet-stream`, `text/plain` para arquivos que o Figma aceita sem problema. A detecção é por magic bytes.

**Canvas WebGL não é capturável.** `toDataURL` num contexto WebGL sem `preserveDrawingBuffer` volta vazio. É limitação do browser, não contornável — o hero animado do stripe.com cai nisso.

## Armadilhas do Figma

**`allowedDomains` recusa endereços de loopback.** Plugins publicados não podem falar com a máquina do usuário. O `localhost` vai em `devAllowedDomains`; `allowedDomains` fica `["none"]`, o que é correto — o modo Arquivo não usa rede.

**Rotação pelo campo `rotation` desloca o nó.** O extractor manda o bbox já rotacionado mais as dimensões reais (`offsetWidth`/`offsetHeight`, que ignoram transform). O plugin monta a matriz na mão em `relativeTransform` para girar em torno do centro.

**`gradientTransform` trabalha no espaço unitário do nó.** Um ângulo CSS precisa ser corrigido pelo aspect ratio da caixa, senão o gradiente sai torto em elementos não quadrados. A conta está em `linearGradientTransform()`.

**Ordem dos fills é invertida.** No Figma o índice 0 é a camada de baixo; no CSS a primeira camada de `background-image` é a de cima.

**O sandbox não tem `atob` nem `fetch`.** A UI (que é um iframe comum) decodifica as imagens de base64 para `Uint8Array` e manda por `postMessage`.

**Sem bundler, `main` é um arquivo só.** Por isso `code.js` é grande e seccionado, em vez de `lib/*.js`. Em troca, não há passo de build: editou, reabriu o plugin.

## Armadilhas das extensões

**`chrome.scripting.executeScript` com `files` não aguarda script assíncrono.** O valor de retorno se perde silenciosamente. O resultado vai por `chrome.runtime.sendMessage` — que também é o caminho compatível com o Safari.

**O background script existe para contornar CORS e CSP.** Medido: buscando imagens de dentro da página, dropsrio e tailwind entregam 40/40, mas o **stripe.com entrega 0/35** — a CSP bloqueia tudo. Pelo background, com `host_permissions`, passa. O mesmo vale para ler folhas de estilo de CDN e recuperar os `--tokens`.

**O Safari não implementa `chrome.downloads`.** O arquivo sai por um `<a download>` no content script, que funciona nos dois browsers.

## Armadilhas do build do Safari

**Assinatura ad-hoc esconde a extensão.** Ela só aparece com "Permitir Extensões Não Assinadas" ligado — e essa opção se desliga a cada reinício do Safari. Assinando com a identidade real do keychain, fica permanente.

**O Team ID está no campo `OU` do certificado, não no nome.** Em `Apple Development: fulano@email.com (898942ASU9)`, o número entre parênteses é o do *membro*. O Team ID é o `OU`. Confundir os dois dá `No Account for Team`. O `build-safari.mjs` lê o campo certo automaticamente.

**iCloud Drive quebra o `codesign`.** O file provider carimba `com.apple.FinderInfo` no bundle e a assinatura falha com *"resource fork, Finder information, or similar detritus not allowed"*. Como este projeto vive em `~/Documents`, o build sai em `/tmp`.

**Todo `.appex` no disco vira uma entrada na lista do Safari.** Builds de teste esquecidos aparecem como extensões duplicadas. O script apaga o build temporário depois de instalar.

## Verificação

Não dá para rodar o Figma em CI, então a validação é feita por quatro ferramentas em `tools/`:

- **`simulate.mjs`** — executa `plugin/code.js` de verdade contra um stub da Plugin API que reproduz as validações reais do Figma: fonte carregada antes de escrever texto, ranges dentro dos limites, formatos de imagem aceitos, dimensões finitas. Pega quase todo erro de lógica antes de abrir o Figma.
- **`preview.mjs`** — redesenha a árvore aplicando as mesmas regras do plugin e gera um PNG. É o que revela erro de *fidelidade*, que o simulador não vê.
- **`compare.mjs`** — põe o preview lado a lado com a página real.
- **`test-ui.mjs`** — carrega `plugin/ui.html` com o `fetch` e o `parent.postMessage` dublados, fazendo o papel do servidor e do main thread. É onde se testa a fila da aba URL: ordem dos sites, um request de cada vez, erro em um site sem derrubar o resto.

O preview roda num Chromium sem as fontes do site instaladas, então a tipografia sai com fallback. Compare posição, cor e estrutura — não a fonte.
