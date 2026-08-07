/* Servidor local — roda o MESMO roteador da Netlify Function, trocando o
 * Netlify Blobs por arquivos em .dados-locais/.
 *
 *   node local-server.js                → arquivos (o estado sobrevive ao reinício)
 *   node local-server.js --memoria      → memória (some ao parar)
 *   node local-server.js --sem-api      → imita uma hospedagem SEM funções
 *   FIREBASE_DATABASE_URL=... FIREBASE_DB_SECRET=... node local-server.js
 *
 * Serve também a pasta ../site, então dá para abrir o site inteiro em
 * http://localhost:8787 com o backend já respondendo em /api. Guardar em
 * arquivo — e não em memória — é o que faz o local se comportar como a
 * produção: o mesmo estado para todas as abas, e nada some ao reiniciar.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { criarHandler } from "./src/handler.js";
import { armazemArquivo, armazemMemoria, armazemFirebase } from "./src/armazem.js";

const AQUI = fileURLToPath(new URL(".", import.meta.url));
const SITE = join(AQUI, "..", "site");
const PORTA = Number(process.env.PORT || 8787);
const SEM_API = process.argv.includes("--sem-api");

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png",
  ".mp4": "video/mp4", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8",
};

function montarArmazem() {
  if (process.env.FIREBASE_DATABASE_URL) {
    return armazemFirebase({
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
      dbSecret: process.env.FIREBASE_DB_SECRET,
    });
  }
  if (process.argv.includes("--memoria")) return armazemMemoria();
  // resolve, e não join: assim --dados aceita caminho absoluto também.
  return armazemArquivo(resolve(AQUI, arg("dados", ".dados-locais")));
}

const armazem = montarArmazem();

const handler = criarHandler({
  armazem,
  pix: {
    chave: process.env.PIX_CHAVE || "himidio@nd.edu",
    nome: process.env.PIX_NOME || "HEITOR IMIDIO",
    cidade: process.env.PIX_CIDADE || "GOIANIRA",
  },
});

const lerCorpo = req => new Promise(resolve => {
  let bruto = "";
  req.on("data", p => {
    bruto += p;
    if (bruto.length > 1e6) req.destroy();   // não aceita corpo gigante
  });
  req.on("end", () => {
    try { resolve(bruto ? JSON.parse(bruto) : null); } catch { resolve(undefined); }
  });
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!SEM_API && url.pathname.startsWith("/api")) {
    const body = req.method === "GET" || req.method === "HEAD" ? null : await lerCorpo(req);
    if (body === undefined) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ erro: "corpo não é um JSON válido" }));
    }
    const r = await handler({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      ip: req.socket.remoteAddress || "local",
    });
    res.writeHead(r.status, r.headers);
    return res.end(r.body);
  }

  // arquivos estáticos do site
  let caminho = url.pathname === "/" ? "/index.html" : url.pathname;
  caminho = normalize(caminho).replace(/^(\.\.[/\\])+/, "");
  const arquivo = join(SITE, caminho);
  if (!arquivo.startsWith(SITE)) {
    res.writeHead(403); return res.end("proibido");
  }
  try {
    const dados = await readFile(arquivo);
    res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] || "application/octet-stream" });
    res.end(dados);
  } catch {
    // Hospedagem estática devolve o index.html para caminho que não existe —
    // inclusive para /api. É justamente esse caso que o --sem-api imita.
    try {
      const dados = await readFile(join(SITE, "index.html"));
      res.writeHead(200, { "content-type": TIPOS[".html"] });
      res.end(dados);
    } catch {
      res.writeHead(404); res.end("não encontrado");
    }
  }
}).listen(PORTA, () => {
  if (SEM_API) {
    console.log(`site SEM API em http://localhost:${PORTA} (imita hospedagem estática)`);
  } else {
    console.log(`backend + site em http://localhost:${PORTA}  (armazém: ${armazem.nome})`);
    console.log(`  GET  /api/status`);
    console.log(`  GET  /api/estado?rev=N`);
    console.log(`  POST /api/reservar  { presenteId, nome, recado }`);
  }
});
