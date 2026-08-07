# Aniversário & Despedida — Heitor Imídio

Site estático (`site/`) + backend serverless (`backend/`) publicados **no mesmo
deploy da Netlify**. O navegador chama `/api/...` na própria origem: sem CORS,
sem domínio extra e sem nenhuma credencial no cliente.

```
netlify.toml   configuração do deploy (publish, functions, build)
site/          o site — index.html único, sem build
backend/       a API — função da Netlify + roteador + testes
```

## Publicar na Netlify

Conecte este repositório em *Add new site → Import an existing project*. O
`netlify.toml` na raiz já traz tudo; os campos do formulário devem repetir os
mesmos valores:

| Campo | Valor |
|---|---|
| **Branch to deploy** | `main` |
| **Base directory** | *(vazio)* |
| **Build command** | `npm install --prefix backend --omit=dev --no-audit --no-fund` |
| **Publish directory** | `site` |
| **Functions directory** | `backend/netlify/functions` |

O build command não compila nada — o site é HTML puro. Ele existe só para
instalar o `@netlify/blobs`, cuja declaração está em `backend/package.json` e
não na raiz: sem `node_modules` ali, o esbuild não consegue empacotar a função.

Nenhuma variável de ambiente é obrigatória. O armazenamento padrão é o Netlify
Blobs, que funciona sem configuração. As opcionais estão em
[`backend/README.md`](backend/README.md#variáveis-de-ambiente).

### Depois do primeiro deploy

1. `https://SEU-SITE.netlify.app/api/status` deve responder JSON com
   `"armazem":"blobs"`. Se vier o HTML do site, a função não subiu — confira o
   *Functions directory*.
2. Abra o site em dois aparelhos, reserve um presente num deles e confirme que
   o outro atualiza sozinho em alguns segundos.
3. Faça um Pix de teste de R$ 1 no seu próprio banco antes de divulgar o link.

## Rodar localmente

```bash
cd backend
npm install
npm test     # 48 testes, sem rede
npm start    # http://localhost:8787 — site + API juntos
```

## Imagens e vídeo

`site/assets/` não está versionado. Sem ele o site funciona: o vídeo do hero cai
para uma cópia em CDN e as fotos ficam como espaços vazios. Para usar arquivos
próprios, crie `site/assets/` com `hero.mp4`, `og.jpg` e `fotos/01.jpg`…`23.jpg`
— os nomes estão listados em `site/index.html`.
