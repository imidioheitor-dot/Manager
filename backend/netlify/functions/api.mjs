/* ============================================================
   Netlify Function (v2) — a API compartilhada do site.

   Sobe na mesma implantação do site, então o navegador chama /api/... na
   própria origem: sem CORS, sem domínio extra e sem credencial no cliente.

   A função declara os próprios caminhos logo abaixo, em `config.path`. Por
   causa disso ela DEIXA de atender em /.netlify/functions/api — e um redirect
   de /api/* para lá, no netlify.toml, apontaria para algo que não existe
   mais, derrubando a API inteira com 404. Não acrescente esse redirect.
   ============================================================ */

import { criarHandler, SERVICO } from "../../src/handler.js";
import { armazemBlobs, armazemFirebase } from "../../src/armazem.js";

const NOME_STORE = process.env.BLOBS_STORE || "aniversario-heitor";

/* Onde os dados ficam.
 *
 * Em serverless cada requisição pode cair numa instância diferente da função.
 * Se o armazenamento não for compartilhado, cada celular enxerga uma meta
 * diferente — o site parece funcionar e ninguém vê a mesma coisa. Por isso
 * NÃO existe queda para memória aqui: sem armazenamento compartilhado a API
 * responde 503 e o site avisa, em vez de mentir. */
async function montarArmazem() {
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  const credencial = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_DB_SECRET;
  if (databaseURL && credencial) {
    return armazemFirebase({
      databaseURL,
      serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
      dbSecret: process.env.FIREBASE_DB_SECRET,
    });
  }
  // Padrão: Netlify Blobs. Compartilhado entre todas as instâncias e sem
  // configuração nenhuma — nem chave, nem conta, nem variável de ambiente.
  const { getStore } = await import("@netlify/blobs");
  return armazemBlobs(getStore({ name: NOME_STORE, consistency: "strong" }));
}

const pix = {
  chave: process.env.PIX_CHAVE || "himidio@nd.edu",
  nome: process.env.PIX_NOME || "HEITOR IMIDIO",
  cidade: process.env.PIX_CIDADE || "GOIANIRA",
};

let handler;

async function obterHandler() {
  // Montado sob demanda (e não no topo do módulo) para que uma falha do
  // armazenamento vire uma resposta 503 honesta, em vez de uma função que
  // nem chega a subir.
  if (!handler) handler = criarHandler({ armazem: await montarArmazem(), pix });
  return handler;
}

const resposta = (status, dados) =>
  new Response(JSON.stringify({ servico: SERVICO, ...dados }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export default async function api(request, context) {
  const url = new URL(request.url);

  let corpo = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const texto = await request.text();
    if (texto) {
      try {
        corpo = JSON.parse(texto);
      } catch {
        return resposta(400, { ok: false, erro: "corpo não é um JSON válido" });
      }
    }
  }

  let executar;
  try {
    executar = await obterHandler();
  } catch (e) {
    // Armazenamento compartilhado fora do ar (Blobs desligado no site, por
    // exemplo). O site continua de pé em modo local — e mostra o aviso.
    console.error("[api] armazenamento indisponível", e);
    return resposta(503, {
      ok: false,
      erro: "Armazenamento compartilhado indisponível. As reservas não estão sendo salvas.",
    });
  }

  const r = await executar({
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body: corpo,
    ip: context?.ip
      || request.headers.get("x-nf-client-connection-ip")
      || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || "sem-ip",
  });

  return new Response(r.body, { status: r.status, headers: r.headers });
}

export const config = { path: ["/api", "/api/*"] };
