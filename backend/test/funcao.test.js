/* Exercita a Netlify Function de verdade — o arquivo que sobe para produção —
 * com a biblioteca real do @netlify/blobs falando HTTP com um servidor de
 * Blobs de mentira rodando aqui na máquina.
 *
 * É o mais perto que dá para chegar da produção sem implantar: passa pelo
 * roteamento por path, pelo `type:"json"` da leitura e, principalmente, pela
 * escrita condicional (`onlyIfMatch`) implementada pela própria biblioteca.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const dados = new Map();     // chave -> { corpo, etag }
let servidor, api, api2;

/* Imita o suficiente da API do Netlify Blobs para a biblioteca funcionar:
 * GET devolve corpo + ETag; PUT respeita if-match e if-none-match. */
function criarBlobsFalso() {
  return http.createServer(async (req, res) => {
    const chave = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const reg = dados.get(chave);

    if (req.method === "GET" || req.method === "HEAD") {
      if (!reg) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { etag: reg.etag, "content-type": "application/json" });
      return res.end(req.method === "HEAD" ? undefined : reg.corpo);
    }
    if (req.method === "PUT") {
      const partes = [];
      for await (const p of req) partes.push(p);
      const seCasar = req.headers["if-match"];
      const seNovo = req.headers["if-none-match"];
      if (seCasar && (!reg || reg.etag !== seCasar)) { res.writeHead(412); return res.end(); }
      if (seNovo === "*" && reg) { res.writeHead(412); return res.end(); }
      const etag = `"e${dados.size}-${Date.now()}-${Math.random()}"`;
      dados.set(chave, { corpo: Buffer.concat(partes).toString(), etag });
      res.writeHead(200, { etag });
      return res.end();
    }
    res.writeHead(405); res.end();
  });
}

before(async () => {
  servidor = criarBlobsFalso();
  await new Promise(r => servidor.listen(0, r));
  const porta = servidor.address().port;

  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
    edgeURL: `http://127.0.0.1:${porta}`,
    uncachedEdgeURL: `http://127.0.0.1:${porta}`,
    token: "token-de-teste",
    siteID: "site-de-teste",
    primaryRegion: "us-east-1",
  })).toString("base64");

  ({ default: api } = await import("../netlify/functions/api.mjs"));
  // Uma SEGUNDA instância da função, como acontece em serverless.
  ({ default: api2 } = await import("../netlify/functions/api.mjs?instancia=2"));
});

after(() => servidor?.close());

const chamar = async (caminho, { ip = "1.2.3.4", corpo, funcao } = {}) => {
  const r = await (funcao || api)(
    new Request("https://exemplo.netlify.app" + caminho, corpo === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
    { ip }
  );
  return { status: r.status, corpo: await r.json() };
};

describe("a função da Netlify, com o @netlify/blobs de verdade", () => {
  test("status responde e diz que está no Blobs", async () => {
    const r = await chamar("/api/status");
    assert.equal(r.status, 200);
    assert.equal(r.corpo.armazem, "netlify-blobs");
    assert.equal(r.corpo.servico, "aniversario-heitor");
  });

  test("reserva grava no Blobs e o preço é do servidor", async () => {
    const r = await chamar("/api/reservar", {
      corpo: { presenteId: "g12", nome: "Producao", recado: "oi", valor: 1 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.corpo.valor, 1000, "pediu R$1 na bike de R$1.000");
    assert.match(r.corpo.pix, /^00020126/);

    const e = await chamar("/api/estado");
    assert.equal(e.corpo.totais.reservados, 1);
    assert.equal(e.corpo.totais.arrecadado, 1000);
  });

  test("com a rev atual a resposta é curta", async () => {
    const { corpo: cheio } = await chamar("/api/estado");
    const { corpo: curto } = await chamar(`/api/estado?rev=${cheio.rev}`);
    assert.equal(curto.semMudanca, true);
    assert.equal(curto.presentes, undefined);
  });

  test("OUTRA instância da função vê o mesmo estado", async () => {
    // É isto que faz todos os aparelhos verem a mesma meta: o estado não
    // mora na instância, mora no Blobs.
    const r = await chamar("/api/estado", { funcao: api2, ip: "5.5.5.5" });
    assert.equal(r.corpo.totais.reservados, 1);
    assert.equal(r.corpo.recados[0].texto, "oi");
  });

  test("oito aparelhos no mesmo presente ao mesmo tempo: as oito entram", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      chamar("/api/reservar", {
        ip: "10.0.0." + i,
        corpo: { presenteId: "g07", nome: "Aparelho " + i },
        funcao: i % 2 ? api2 : api,     // metade em cada instância
      })
    ));
    assert.equal(rs.filter(r => r.status === 201).length, 8);
    assert.equal(rs.filter(r => r.status >= 500).length, 0, "nada pode virar erro de servidor");

    const e = await chamar("/api/estado");
    assert.ok(e.corpo.reservas.g12, "a reserva anterior continua lá");
    // Oito gravações concorrentes vindas de DUAS instâncias da função, e as
    // oito sobrevivem: é o compare-and-set do Blobs refazendo cada colisão.
    assert.equal(e.corpo.reservas.g07.quantidade, 8);
    assert.equal(
      new Set(e.corpo.reservas.g07.pessoas.map(p => p.nome)).size, 8,
      "ninguém pode ter sido sobrescrito por outro"
    );
  });

  test("o limite por IP mora em chave própria, longe do estado", async () => {
    const chaves = [...dados.keys()];
    assert.ok(chaves.some(k => k.endsWith("/estado")));
    assert.ok(chaves.some(k => k.includes("/limites/")));
  });

  test("corpo que não é JSON devolve 400 com a marca do serviço", async () => {
    const r = await api(new Request("https://exemplo.netlify.app/api/reservar", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{isso nao e json",
    }), { ip: "1.2.3.4" });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).servico, "aniversario-heitor");
  });
});
