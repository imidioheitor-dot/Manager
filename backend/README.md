# Backend — Aniversário & Despedida

API compartilhada do site de presentes. Sobe junto com o site no Netlify, então
o navegador chama `/api/...` na própria origem — sem CORS, sem domínio extra e
**sem nenhuma credencial no cliente**.

```
backend/
  netlify/functions/api.mjs  a função da Netlify (declara os próprios caminhos)
  local-server.js            servidor local (roda o MESMO roteador, e serve ../site)
  src/
    handler.js               roteador — Request/Response padrão, sem framework
    armazem.js               onde os dados ficam: Blobs, arquivo, memória, Firebase
    docs.js                  documento versionado (rev) com compare-and-set
    gifts.js                 catálogo — GERADO, é dele que sai o preço
    pix.js                   BR Code (EMV + CRC16)
    validate.js              validação e limpeza de entrada
  scripts/sync-catalogo.js   regenera gifts.js a partir do site
  test/handler.test.js       roteador, armazéns, Pix, validação
  test/funcao.test.js        a função da Netlify com o @netlify/blobs de verdade
```

## Rodar

```bash
cd backend
npm test          # 48 testes, sem rede
npm start         # http://localhost:8787 — site + API, dados em .dados-locais/
```

O servidor local roda **o mesmo roteador** da função da Netlify, trocando só o
armazenamento: em vez do Blobs, arquivos em `.dados-locais/`. Por isso o local
se comporta como a produção — o estado é o mesmo para todas as abas e sobrevive
ao reinício.

```bash
node local-server.js --memoria   # dados somem ao parar
node local-server.js --sem-api   # imita hospedagem SEM funções (para testar o aviso)
```

## Rotas

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/api/status` | De pé? Qual armazenamento? Qual a versão do estado? |
| `GET` | `/api/estado` | Presentes, reservas, mural e totais. Aceita `?rev=` |
| `POST` | `/api/reservar` | Reserva um presente e devolve o código Pix |

`POST /api/reservar` recebe:

```json
{ "presenteId": "g12", "nome": "Julianna", "recado": "Voa alto!" }
```

e responde:

```json
{ "servico": "aniversario-heitor", "ok": true, "presenteId": "g12",
  "titulo": "Uma bike pra andar no campus", "valor": 1000, "rev": 4,
  "pix": "00020126360014BR.GOV.BCB.PIX..." }
```

Códigos: **201** reservado · **400** entrada inválida · **404** presente não
existe · **409** alguém reservou primeiro · **429** limite por IP · **503**
armazenamento compartilhado fora do ar.

## Todos os aparelhos vendo a mesma coisa

Este é o problema que o backend existe para resolver. Em serverless cada
requisição pode cair numa instância diferente da função; se o estado não for
compartilhado, **cada celular enxerga uma meta diferente** — o site parece
funcionar e ninguém vê a mesma coisa.

**O estado inteiro vive num documento só**, com um número de versão (`rev`) que
sobe a cada gravação. Daí saem duas coisas:

**Consulta barata.** O site pergunta `GET /api/estado?rev=7`. Se nada mudou, a
resposta tem ~110 bytes em vez de ~2,5 KB — e a tela nem re-renderiza. Só
enquanto a aba está visível, com uma consulta imediata ao voltar para ela.

**Gravação atômica.** Toda escrita é condicional ao que foi lido (`onlyIfMatch`
no Blobs, `if-match` no Firebase). Se outra pessoa gravou no meio do caminho, o
armazém recusa e nós refazemos a alteração sobre o estado novo. Há um teste com
oito reservas simultâneas do mesmo presente: exatamente uma passa, sete recebem
409, e ninguém apaga a reserva de ninguém.

| Armazém | Configuração | Compartilha entre aparelhos |
|---|---|---|
| **Netlify Blobs** (padrão) | **nenhuma** | sim |
| Firebase RTDB | precisa de credencial | sim |
| arquivo | — | só no servidor local |
| memória | — | **não** — só testes |

**Não existe queda para memória em produção.** Se o armazenamento compartilhado
não subir, a API responde **503** e o site mostra o aviso *"sem conexão com o
servidor"*, continuando utilizável com o que está guardado no aparelho. Cair
para memória seria pior que a falha: o site diria que está tudo certo enquanto
cada visitante veria uma meta diferente.

## O que este backend protege

Antes, o navegador escrevia direto no banco com as regras abertas. Qualquer
pessoa com o console aberto podia **desmarcar um presente já reservado, apagar
o mural ou reservar a bike de R$1.000 dizendo que pagou R$1**. Agora:

**O preço é do servidor.** O cliente manda só o `presenteId`. O valor sai de
`src/gifts.js` e o código Pix é montado no servidor — mexer no payload invalida
o CRC.

**Reservas não podem ser desfeitas por terceiros.** Não existe rota de remoção.

**A entrada é validada.** Nome até 40 caracteres, recado até 280, caracteres de
controle e invisíveis removidos.

**A credencial fica no servidor**, em variável de ambiente. Um teste verifica
que o segredo não vaza em nenhuma resposta.

**Há limite por IP:** 10 reservas a cada 10 minutos, contado em chave própria
para não disputar o documento do estado.

**Toda resposta traz `"servico": "aniversario-heitor"`.** Uma hospedagem sem
funções devolve o `index.html` — com status 200 — para qualquer caminho que não
existe, `/api/estado` inclusive. Sem essa marca (e sem conferir o
`content-type`), o site engoliria uma página HTML achando que era estado.

## Variáveis de ambiente

Todas opcionais. No Netlify: *Site settings → Environment variables*.

| Variável | Para quê |
|---|---|
| `BLOBS_STORE` | Nome do store no Blobs (padrão: `aniversario-heitor`) |
| `FIREBASE_DATABASE_URL` | Usa o Firebase em vez do Blobs |
| `FIREBASE_SERVICE_ACCOUNT` | JSON da conta de serviço (recomendado) |
| `FIREBASE_DB_SECRET` | Alternativa legada à anterior |
| `PIX_CHAVE` | Padrão: `himidio@nd.edu` |
| `PIX_NOME` | Padrão: `HEITOR IMIDIO` |
| `PIX_CIDADE` | Padrão: `GOIANIRA` |

O Firebase só entra se `FIREBASE_DATABASE_URL` **e** uma das credenciais
estiverem definidas. Faltando qualquer uma, fica no Blobs — que funciona sem
configuração nenhuma.

## Cuidado com redirects no `netlify.toml`

A função declara os próprios caminhos:

```js
export const config = { path: ["/api", "/api/*"] };
```

Ao fazer isso, ela **deixa de atender** em `/.netlify/functions/api`. Um
redirect de `/api/*` para lá aponta para algo que não existe mais — e com
`force` ele ainda passa na frente do roteamento por path. O resultado é 404 na
API inteira. Não acrescente esse redirect.

## Mexeu na lista de presentes?

O catálogo do servidor é derivado do site. Depois de editar `GIFTS` no
`site/index.html`:

```bash
npm run sync-catalogo
npm test
```

`npm run sync-catalogo -- --check` falha se os dois estiverem fora de sincronia
— bom para rodar em CI.

## Sobre os testes

48 testes cobrindo: geração e integridade do Pix, o servidor impondo o preço,
reserva dupla, oito reservas simultâneas, o `rev` e a resposta "sem mudança",
validação de tipo e tamanho, limpeza de caracteres invisíveis, faixa do valor
livre, limite por IP em chave própria, a marca do serviço em toda resposta, e
os quatro armazéns — inclusive o erro clássico de ler o Blobs sem `type:"json"`
(o estado chegaria como texto e pareceria vazio para todo mundo) e o 412 do
`if-match` no Firebase.

`test/funcao.test.js` vai um passo além: importa **o arquivo que sobe para
produção** e deixa a biblioteca real do `@netlify/blobs` conversar por HTTP com
um servidor de Blobs de mentira. Duas instâncias distintas da função leem o
mesmo estado, e oito reservas simultâneas do mesmo presente — metade em cada
instância — terminam em exatamente um 201, sete 409 e nenhum erro de servidor.

O Blobs de produção não é alcançável do ambiente onde isto foi escrito, então o
que foi testado é a biblioteca contra um servidor que imita o protocolo dela.
**Vale um teste de fumaça na primeira implantação**: abra o site em dois
aparelhos, reserve num deles e confirme que o outro atualiza sozinho em alguns
segundos.
