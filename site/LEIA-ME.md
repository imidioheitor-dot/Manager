# Site de Aniversário & Despedida — Heitor Imídio · 16/08

Arquivo único: **`index.html`**. Sem build, sem npm, sem dependências de JavaScript
ou CSS externas. Arraste para o Netlify e está no ar.

---

## 1. O que você PRECISA editar antes de publicar

**Chave configurada:** `himidio@nd.edu` (titular HEITOR IMIDIO, Goianira).

Para trocar, abra `index.html` e procure por `CONFIGURAÇÃO` (perto do início da tag `<script>`).

### Chave Pix — obrigatório

```js
const PIX = {
  chave : "SUA-CHAVE-PIX-AQUI",   // CPF, telefone (+5562...), e-mail ou chave aleatória
  nome  : "HEITOR IMIDIO",        // até 25 caracteres, SEM acento
  cidade: "GOIANIRA"              // até 15 caracteres, SEM acento
};
```

Enquanto a chave não for trocada, o site funciona normalmente mas mostra um aviso
no lugar do QR Code. Assim que você colar a chave, **todos os QR Codes passam a
funcionar automaticamente**, cada um já com o valor do presente preenchido.

O código Pix é gerado no padrão BR Code / EMV do Banco Central, com CRC16-CCITT.
Foi verificado por teste automatizado: o payload é escrito no QR e lido de volta
da matriz, byte a byte.

> Teste com um valor de R$ 1 no seu próprio banco antes de divulgar o link.

---

## 2. Todos os aparelhos vendo a mesma coisa — **ativo**

Presentes reservados, recados do mural e a meta arrecadada ficam num servidor
que sobe junto com o site (a pasta `backend/`, servida em `/api`). Quem abre o
site no celular vê a mesma coisa que quem abre no notebook, e a tela se
atualiza sozinha em poucos segundos — sem recarregar.

Não há mais nenhuma configuração de banco dentro do `index.html`, de propósito:

- **O preço é do servidor.** O navegador manda só o código do presente. Quem
  decide o valor e monta o Pix é o servidor — ninguém com o console aberto
  reserva a bike de R$1.000 dizendo que pagou R$1.
- **Uma reserva não pode ser desfeita por terceiros.** Não existe caminho de
  escrita além do de criar.
- **Duas pessoas no mesmo presente ao mesmo tempo:** uma leva, a outra recebe um
  aviso honesto de que o Pix chegou mas o presente já tinha saído.

No Netlify funciona sem configurar nada. Se o servidor não estiver no ar (ou se
você abrir o arquivo direto, sem hospedagem), o site mostra o aviso *"sem
conexão com o servidor"* e continua utilizável, guardando o que você marcar só
naquele aparelho — em vez de fingir que sincronizou.

Detalhes de operação e variáveis de ambiente: `backend/README.md`.

---

## 3. O vídeo da hero

O vídeo (15 s, 1080p, sem áudio, gerado por IA) **já está no repositório**, em
`assets/hero.mp4` (20 MB). Não é preciso baixar nada.

O HTML tenta o arquivo local primeiro e só recorre ao CDN se ele faltar, então o
site funciona mesmo se o vídeo for removido — a hero tem animação própria por
baixo.

---

## 3.5 As fotos

São 23, já em `assets/fotos/` (`01.jpg` … `23.jpg`), recortadas, comprimidas
(3,6 MB no total, com carregamento sob demanda) e distribuídas por conteúdo:

| # | Onde aparece | Foto |
|---|---|---|
| 01–02 | flutuando na hero | aeroporto · a medalha |
| 03–20 | galeria de memórias | a jornada: ONU, MIT, Google, sala de controle, foguetes, palcos, Genebra, Boston — misturada com as pessoais |
| 21–23 | tira do rodapé | bandeiras · mesa · a neve |

A galeria repete um padrão a cada 6 fotos: um **destaque** grande (posições
3, 9, 15), quatro retratos e uma **faixa larga** que atravessa a página
(posições 8, 14, 20).

Cada vaga se adapta sozinha à orientação da foto: ao carregar, a imagem é
medida e recebe `is-tall`, `is-wide` ou `is-square`, e a proporção da vaga
segue essa classe. Por isso você pode trocar fotos de lugar sem se preocupar
com corte — um retrato numa posição de destaque não é mais achatado.

A número 23 era um print de WhatsApp: recortei fora a interface do iPhone.

**As legendas são um chute meu** — aparecem no hover. Troque na lista `PHOTOS`,
campo `cap`. As que mais pedem um nome de verdade são a 22 ("Mesa de sempre") e
a 19 ("Entre um evento e outro").

Sobraram 6 fotos do Drive que não entraram, por serem parecidas demais com as
escolhidas (outro ângulo do mesmo foguete, outra selfie de escritório, outra
foto do museu). Para usar alguma, salve com o número seguinte e acrescente uma
linha em `PHOTOS`.

---

## 4. Trocar presentes, valores e desafios

Tudo fica em listas no topo do script, fáceis de editar:

- `GIFTS` — os 13 presentes (código, título, valor, piada).
- `CHALLENGES` — os 7 micos, de R$600 a R$3.000. O último tem `final:true` e
  ocupa a linha inteira. **Confira se você topa cumprir cada um** antes de
  publicar; são promessas suas.
- `PHOTOS` — as 23 fotos e suas legendas.
- `lembrancinha(v)` — a faixa de lembrancinha por valor doado.
- `DATA_EMBARQUE` — alimenta a contagem regressiva.

O cartão de **valor livre** aparece sozinho no fim da grade; quem quiser mandar
qualquer outra quantia usa ele.

---

## 5. Publicar

**Prévia no WhatsApp:** `assets/og.jpg` é a imagem que aparece quando alguém
manda o link. Depois de publicar, troque as duas tags para a URL completa,
senão alguns aplicativos não acham a imagem:

```html
<meta property="og:image" content="https://SEU-SITE.netlify.app/assets/og.jpg">
<meta name="twitter:image" content="https://SEU-SITE.netlify.app/assets/og.jpg">
```

Netlify → *Add new site* → *Deploy manually* → arraste a pasta.
Ou conecte este repositório e mande publicar a raiz do projeto.

---

## Como o site foi construído

Efeitos, todos escritos à mão, sem biblioteca:

| Efeito | Onde |
|---|---|
| Object Reveal on Hover | mala 3D de couro que substitui o cursor sobre os presentes |
| Portal Animation (scroll) | o lado de lá cresce em círculo por cima do lado de cá |
| 3D Product Animation | Golden Dome interativo: arraste para girar, role para aproximar |
| TextPressure | título "HEITOR" reage à proximidade do cursor |
| Cursor interativo | anel + poeira dourada que se afasta do ponteiro |
| Galeria editorial | fotos em duotone azul, cor plena e legenda no hover |

O Three.js e a biblioteca de QR foram **removidos de propósito** e substituídos
por implementações próprias: um renderizador 3D por software em canvas 2D e um
encoder de QR completo. O `index.html` tem ~80 KB e não busca nada de fora além das fontes do Google.
Com as 23 fotos e a imagem de compartilhamento, a pasta toda dá ~3,7 MB —
mas só carregam as fotos que entram na tela.

Acessibilidade e robustez: sem rolagem horizontal em nenhuma largura, foco de
teclado visível, `prefers-reduced-motion` respeitado, e todo texto de visitante é
escapado antes de ir para a tela.
