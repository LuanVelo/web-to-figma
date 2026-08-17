# web-to-figma

Importa páginas web para o Figma como layers editáveis. Roda 100% local, sem assinatura.

## Como funciona

Um plugin do Figma sozinho não consegue fazer isso: o sandbox não tem DOM nem engine de layout, então baixar o HTML não diz onde cada elemento cai na tela nem qual cor o CSS resolveu. Alguém precisa renderizar a página de verdade primeiro.

São dois caminhos para isso, e o principal **não usa servidor nenhum**:

| | **Extensão** (recomendado) | **Servidor local** |
|---|---|---|
| O que renderiza | o seu próprio browser | um Chromium via Playwright |
| Precisa deixar algo rodando | não | sim, `npm start` |
| Vários viewports de uma vez | não, captura a janela atual | sim (1440 + 390 etc.) |
| Páginas com login | sim | não |
| Funciona em | Chrome e Safari | qualquer lugar |

Nos dois casos sai o mesmo arquivo `.w2f`, e o plugin monta igual.

## Instalação

**1. Plugin no Figma** (necessário nos dois modos)

Requer o **Figma Desktop** — o Figma no navegador não lê arquivos locais.

1. **Plugins → Development → Import plugin from manifest…**
2. Selecione `plugin/manifest.json`

Passa a aparecer em **Plugins → Development → web to figma**. É um plugin de desenvolvimento: fica só na sua conta, sem review e sem custo.

**2. Extensão no Chrome**

1. Abra `chrome://extensions`
2. Ligue o **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** → selecione a pasta `extension/`

**3. Extensão no Safari**

O Safari não carrega uma pasta solta: a extensão precisa vir dentro de um app. O projeto Xcode já está gerado em `safari/` e o app já foi compilado e instalado em `/Applications/web to figma.app`.

Falta só habilitar:

1. Abra **/Applications/web to figma.app** uma vez (é isso que registra a extensão no Safari)
2. **Safari → Ajustes → Extensões** e marque **web to figma**
3. Na primeira captura o Safari pede acesso ao site — escolha **Permitir em Todos os Sites**, senão a extensão não enxerga a página

O app é assinado com a identidade **Apple Development** encontrada no seu keychain, então aparece na lista permanentemente — sem depender de "Permitir Extensões Não Assinadas", que se desliga a cada reinício do Safari.

Se nenhuma identidade for encontrada no keychain, o script cai para assinatura ad-hoc e avisa. Nesse caso a opção acima precisa estar ligada.

Sempre que mexer em `extension/` ou em `server/extractor.js`, recompile:

```bash
npm run safari
```

Depois feche e reabra o Safari para ele pegar a versão nova.

## Uso

**Com a extensão** — abra a página, deixe do jeito que quer capturar (já rolada, logada, com o menu aberto), clique no ícone da extensão e em **Capturar página**. Um arquivo `.w2f` é baixado. No Figma, abra o plugin, aba **Arquivo**, e solte o arquivo ali.

A captura usa a largura atual da janela. Para capturar mobile, estreite a janela antes.

**Com o servidor** — quando quiser vários viewports, ou vários sites, de uma vez:

```bash
npm install
```

```bash
npm start
```

No plugin, aba **URL**, cole o endereço e escolha os viewports. O servidor fecha o Chromium sozinho após 3 minutos parado e se encerra após 20 minutos sem uso — não fica pesando à toa.

**Vários sites de uma vez** — clique em **+ site** para adicionar mais endereços (ou cole uma lista, uma URL por linha, que ela se distribui nos campos). Ao importar, eles entram numa fila e são capturados um de cada vez, cada um virando frames lado a lado no canvas. Os viewports marcados valem para todos.

Durante a fila aparecem duas barras: a de cima é o total (`site 2 de 3`), a de baixo é o site atual. O ponto ao lado de cada campo mostra o estado — cinza na fila, azul importando, verde pronto, vermelho falhou (a mensagem fica no tooltip do ponto). Um site que falha não interrompe os outros; no fim o resumo diz quantos entraram e quantos falharam.

### Opções

**Simplificar camadas** — descarta divs vazias e conteúdo fora da tela (slides ocultos de carrossel, menus off-canvas). Corta a contagem de layers pela metade ou mais. Fica no popup da extensão e na aba URL do plugin, porque é decidido no momento da captura.

Já estas valem para os dois modos, e ficam no plugin (acontecem ao montar):

| Opção | O que faz |
|---|---|
| **Criar color e text styles** | Cores e combinações tipográficas usadas 3+ vezes viram styles do arquivo, já aplicados nos nós. |
| **Criar variáveis** | As CSS custom properties (`--tokens`) do site viram variáveis numa collection `Web tokens`. |

## O que é convertido

- Hierarquia de frames com posição e tamanho exatos
- Cores sólidas, gradientes (linear, radial, cônico) e imagens de fundo
- Texto com fonte, peso, tamanho, entrelinha, espaçamento, cor, alinhamento e caixa
- **Formatação por trecho** — o negrito no meio da frase, o preço riscado, a palavra em outra cor
- Bordas (inclusive diferentes por lado), cantos arredondados, sombras internas e externas
- Imagens (PNG, JPEG, GIF, WebP) e SVG como vetor editável
- Ordem de pintura respeitando `z-index`, e elementos rotacionados
- **Vídeo, canvas e iframe** — pela captura do servidor, viram uma imagem do que estava na tela (banner em vídeo, gráfico WebGL, mapa embutido)

E, igualmente importante, o que ele **não** traz: mega-menus e acordeões fechados, slides de carrossel fora de quadro e menus off-canvas ficam de fora, em vez de aparecerem empilhados sobre o conteúdo real.

### Fontes

O plugin procura a fonte original no seu Figma. Se não estiver instalada, cai para **Inter** mantendo o peso equivalente — a hierarquia se mantém, mas a quebra de linha pode variar. Instalar as fontes do site antes dá o melhor resultado.

## Limitações conhecidas

- **Pseudo-elementos `::before` / `::after` não são capturados** — não têm bounding rect acessível. Afeta ícones decorativos, bolinhas de carrossel, setas e alguns badges.
- **Vídeo, canvas e iframe só vêm pelo servidor.** É ele que fotografa a região da tela; na extensão o extractor roda dentro da página, sem acesso a captura, então esses blocos continuam vazios (exceto vídeo com `poster` ou servido com CORS). O teto é de 12 fotos por página.
- Uma foto de região é uma imagem chapada: o texto que estiver dentro dela não vira camada editável.
- Elementos `position: fixed` (headers flutuantes, botões de chat, overlays) são congelados na posição em que aparecem com a página no topo.
- Filtros CSS (`blur`, `backdrop-filter`), blend modes e máscaras: suporte parcial ou nenhum.
- Transforms 3D não são suportados.
- Popups e banners de cookie **são** capturados, como o visitante os veria — é só apagar no Figma.
- Pelo servidor, páginas acima de 20000px de altura são truncadas.

## Ferramentas de verificação

Servem para conferir uma conversão sem abrir o Figma.

> Salve as capturas em `capturas/` — a pasta é ignorada pelo git. Uma captura leva a página inteira, com as imagens embutidas: se veio de um site logado, leva junto o que estava na tela.

**Testar o caminho da extensão** — faz o mesmo que a extensão faz e grava o `.w2f`:

```bash
node tools/test-extension.mjs https://exemplo.com capturas/captura.w2f
```

**Simular o plugin** — roda `plugin/code.js` de verdade contra um stub da Plugin API que reproduz as validações do Figma (fonte carregada antes de escrever texto, ranges dentro dos limites, formatos de imagem aceitos):

```bash
node tools/simulate.mjs capturas/captura.w2f
```

```bash
node tools/simulate.mjs capturas/captura.w2f --fonts=poucas
```

**Preview de fidelidade** — redesenha a árvore com as mesmas regras do plugin e gera um PNG:

```bash
node tools/preview.mjs capturas/captura.w2f capturas/saida.png
```

**Comparar com o original** — lado a lado com a página real (precisa do servidor no ar):

```bash
node tools/compare.mjs capturas/saida.png capturas/real.png capturas/comparacao.png 0 1000
```

**Testar a UI do plugin** — carrega `plugin/ui.html` com servidor e main thread falsos, e exercita a fila da aba URL (ordem, um site de cada vez, erro no meio, estado dos campos). Não precisa de servidor nem do Figma:

```bash
npm run test-ui
```

> O preview roda num Chromium sem as fontes do site instaladas, então o texto sai com fonte de fallback. Compare posições, cores e estrutura — não a tipografia.

## Estrutura

```
extension/
  manifest.json     extensão MV3 (Chrome e Safari)
  popup.html/js     interface do botão
  background.js     baixa imagens e CSS sem esbarrar em CORS/CSP
  collect.js        orquestra a captura e entrega o arquivo
  extractor.js      GERADO — cópia de server/extractor.js
server/
  index.js          HTTP: /health, /import, /shot
  extractor.js      injetado na página — é onde mora a fidelidade
  lib/browser.js    Chromium reusado entre requests
  lib/assets.js     download das imagens
plugin/
  manifest.json
  code.js           monta os nós no canvas
  ui.html           abas Arquivo e URL (a fila de sites mora aqui)
safari/
  web to figma/     projeto Xcode gerado (empacota a extensão para o Safari)
tools/
  test-extension.mjs  reproduz a captura da extensão
  simulate.mjs        roda o plugin contra um stub da Plugin API
  preview.mjs         redesenha a árvore em PNG
  compare.mjs         preview x original
  test-ui.mjs         exercita a fila da aba URL sem Figma nem servidor
  sync-extension.mjs  espelha o extractor para a extensão
  build-safari.mjs    recompila e reinstala o app do Safari
```

> O build do Safari sai em `/tmp` de propósito: este projeto está numa pasta do iCloud Drive, que carimba atributos estendidos no bundle e faz o `codesign` recusar a assinatura. O `npm run safari` já cuida disso.

`server/extractor.js` é a fonte única. Depois de editá-lo, rode `npm run sync` para atualizar a cópia da extensão (o `npm start` já faz isso sozinho), e `npm run safari` se estiver usando o Safari.

O plugin é JavaScript puro, sem bundler: editou `code.js`, é só reabrir o plugin no Figma.

## Contribuindo / mexendo no código

Leia o [ARQUITETURA.md](ARQUITETURA.md) antes de mexer no `extractor.js`. Quase toda regra estranha ali existe porque um site real quebrou — `display: contents` devolvendo rect zerado, `<details>` fechado se declarando visível, `getClientRects()` contando caixas em vez de linhas. O documento explica cada uma.

Depois de qualquer mudança, o mínimo é:

```bash
node tools/test-extension.mjs https://algum-site.com /tmp/t.w2f && node tools/simulate.mjs /tmp/t.w2f --fonts=poucas
```
