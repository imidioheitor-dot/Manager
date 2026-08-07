import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { criarHandler, LIMITE, SERVICO, CHAVE_ESTADO } from "../src/handler.js";
import { armazemMemoria, armazemArquivo, armazemBlobs, armazemFirebase } from "../src/armazem.js";
import { atualizarDoc, ErroConcorrencia } from "../src/docs.js";
import { crc16, payloadValido } from "../src/pix.js";
import { porId } from "../src/gifts.js";

const PIX = { chave: "himidio@nd.edu", nome: "HEITOR IMIDIO", cidade: "GOIANIRA" };

const novo = (armazem = armazemMemoria()) =>
  ({ armazem, handler: criarHandler({ armazem, pix: PIX }) });

const post = (handler, body, ip = "1.1.1.1") =>
  handler({ method: "POST", path: "/api/reservar", body, ip });

const get = (handler, rota = "/api/estado", query = {}) =>
  handler({ method: "GET", path: rota, query });

const corpo = r => JSON.parse(r.body);

/* ------------------------------------------------------------------ */
describe("Pix", () => {
  test("CRC-16/CCITT-FALSE bate com o vetor de referência", () => {
    assert.equal(crc16("123456789"), "29B1");
  });
});

/* ------------------------------------------------------------------ */
describe("rotas básicas", () => {
  test("status responde e diz qual armazém está em uso", async () => {
    const { handler } = novo();
    const c = corpo(await get(handler, "/api/status"));
    assert.equal(c.ok, true);
    assert.equal(c.armazem, "memoria");
    assert.equal(c.presentes, 20);
  });

  test("/api e /api/saude também respondem status", async () => {
    const { handler } = novo();
    assert.equal((await get(handler, "/api")).status, 200);
    assert.equal((await get(handler, "/api/saude")).status, 200);
  });

  test("TODA resposta traz a marca do serviço", async () => {
    // É o que impede o site de confundir a nossa API com o index.html que uma
    // hospedagem sem funções devolve, com status 200, para qualquer caminho.
    const { handler } = novo();
    const respostas = [
      await get(handler, "/api/status"),
      await get(handler, "/api/estado"),
      await get(handler, "/api/nada"),
      await post(handler, { presenteId: "g01", nome: "Ana" }),
      await post(handler, { presenteId: "g01", nome: "Bia" }, "2.2.2.2"),
      await post(handler, { nome: "" }),
    ];
    for (const r of respostas) assert.equal(corpo(r).servico, SERVICO);
  });

  test("rota desconhecida devolve 404", async () => {
    const { handler } = novo();
    assert.equal((await get(handler, "/api/nada")).status, 404);
  });

  test("estado lista todos os presentes e nenhum reservado no início", async () => {
    const { handler } = novo();
    const c = corpo(await get(handler));
    assert.equal(c.presentes.length, 20);
    assert.equal(c.totais.reservados, 0);
    assert.equal(c.totais.arrecadado, 0);
    assert.equal(c.rev, 0);
    assert.ok(c.presentes.every(p => p.reservado === false));
  });
});

/* ------------------------------------------------------------------ */
describe("versão do estado (rev)", () => {
  test("rev sobe a cada reserva", async () => {
    const { handler } = novo();
    assert.equal(corpo(await get(handler)).rev, 0);
    await post(handler, { presenteId: "g01", nome: "Ana" });
    assert.equal(corpo(await get(handler)).rev, 1);
    await post(handler, { presenteId: "g02", nome: "Bia" }, "2.2.2.2");
    assert.equal(corpo(await get(handler)).rev, 2);
  });

  test("consulta com a rev atual devolve 'sem mudança', sem o estado inteiro", async () => {
    const { handler } = novo();
    await post(handler, { presenteId: "g01", nome: "Ana" });
    const atual = corpo(await get(handler));

    const curta = corpo(await get(handler, "/api/estado", { rev: String(atual.rev) }));
    assert.equal(curta.semMudanca, true);
    assert.equal(curta.rev, atual.rev);
    assert.equal(curta.presentes, undefined, "não deve mandar a lista de novo");
    assert.ok(JSON.stringify(curta).length < 200);
  });

  test("consulta com rev antiga devolve o estado completo", async () => {
    const { handler } = novo();
    await post(handler, { presenteId: "g01", nome: "Ana" });
    const c = corpo(await get(handler, "/api/estado", { rev: "0" }));
    assert.equal(c.semMudanca, undefined);
    assert.equal(c.presentes.length, 20);
    assert.equal(c.totais.reservados, 1);
  });
});

/* ------------------------------------------------------------------ */
describe("reserva", () => {
  test("reserva válida devolve 201 e um Pix íntegro", async () => {
    const { handler } = novo();
    const r = await post(handler, { presenteId: "g01", nome: "Julianna", recado: "Voa alto!" });
    assert.equal(r.status, 201);
    const c = corpo(r);
    assert.equal(c.valor, 50);
    assert.ok(payloadValido(c.pix), "payload Pix deve passar no CRC e na varredura TLV");
    assert.ok(c.pix.includes("himidio@nd.edu"));
    assert.ok(c.pix.includes("5405" + "50.00"));
  });

  test("O PREÇO É DO SERVIDOR: cliente mandando valor menor é ignorado", async () => {
    const { handler } = novo();
    // g12 é a bike, R$1.000 — o cliente tenta pagar R$1
    const c = corpo(await post(handler, { presenteId: "g12", nome: "Espertinho", valor: 1 }));
    assert.equal(c.valor, porId.get("g12").valor);
    assert.equal(c.valor, 1000);
    assert.ok(c.pix.includes("1000.00"));
  });

  test("o mesmo presente não pode ser reservado duas vezes", async () => {
    const { handler } = novo();
    assert.equal((await post(handler, { presenteId: "g05", nome: "Ana" })).status, 201);
    const segunda = await post(handler, { presenteId: "g05", nome: "Bruno" }, "2.2.2.2");
    assert.equal(segunda.status, 409);
    assert.equal(corpo(segunda).motivo, "ja_reservado");
    assert.equal(corpo(segunda).conflito, true);
  });

  test("reservas simultâneas do mesmo presente: só uma vence", async () => {
    const { handler } = novo();
    const respostas = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(handler, { presenteId: "g07", nome: `P${i}` }, `10.0.0.${i}`))
    );
    assert.equal(respostas.filter(r => r.status === 201).length, 1);
    assert.equal(respostas.filter(r => r.status === 409).length, 7);
  });

  test("presente inexistente devolve 404", async () => {
    const { handler } = novo();
    assert.equal((await post(handler, { presenteId: "g99", nome: "X" })).status, 404);
  });

  test("estado reflete a reserva e soma o arrecadado", async () => {
    const { handler } = novo();
    await post(handler, { presenteId: "g05", nome: "Ana" });            // 500
    await post(handler, { presenteId: "g12", nome: "Bia" }, "3.3.3.3"); // 1000
    const c = corpo(await get(handler));
    assert.equal(c.totais.reservados, 2);
    assert.equal(c.totais.arrecadado, 1500);
    assert.ok(c.presentes.find(p => p.id === "g05").reservado);
  });

  test("reserva e recado entram na MESMA gravação", async () => {
    // Se fossem duas, dava para sobrar recado no mural sem a reserva —
    // e cada reserva disputaria o documento duas vezes à toa.
    const { armazem, handler } = novo();
    await post(handler, { presenteId: "g03", nome: "Vô", recado: "Orgulho!" });
    const { valor } = await armazem.ler(CHAVE_ESTADO);
    assert.equal(valor.rev, 1, "uma reserva com recado deve gerar UMA versão");
    assert.ok(valor.reservas.g03);
    assert.equal(valor.recados.length, 1);
  });
});

/* ------------------------------------------------------------------ */
describe("validação de entrada", () => {
  test("nome é obrigatório", async () => {
    const { handler } = novo();
    assert.equal((await post(handler, { presenteId: "g01" })).status, 400);
    assert.equal((await post(handler, { presenteId: "g01", nome: "   " })).status, 400);
  });

  test("nome longo demais é recusado", async () => {
    const { handler } = novo();
    const r = await post(handler, { presenteId: "g01", nome: "a".repeat(41) });
    assert.equal(r.status, 400);
    assert.match(corpo(r).erro, /nome/);
  });

  test("recado longo demais é recusado", async () => {
    const { handler } = novo();
    assert.equal((await post(handler, { presenteId: "g01", nome: "Ana", recado: "x".repeat(281) })).status, 400);
  });

  test("campos com tipo errado não passam", async () => {
    const { handler } = novo();
    assert.equal((await post(handler, { presenteId: "g01", nome: { a: 1 } })).status, 400);
    assert.equal((await post(handler, { presenteId: 42, nome: "Ana" })).status, 400);
    assert.equal((await post(handler, null)).status, 400);
  });

  test("caracteres de controle são removidos do texto", async () => {
    const { handler } = novo();
    await post(handler, { presenteId: "g01", nome: "A n​a", recado: "oi" });
    const c = corpo(await get(handler));
    assert.equal(c.recados[0].nome, "A n a");
    assert.equal(c.recados[0].texto, "oi");
  });

  test("o recado entra no mural com o presente", async () => {
    const { handler } = novo();
    await post(handler, { presenteId: "g03", nome: "Vô", recado: "Orgulho!" });
    const c = corpo(await get(handler));
    assert.equal(c.recados.length, 1);
    assert.equal(c.recados[0].texto, "Orgulho!");
    assert.match(c.recados[0].presente, /meias/);
  });

  test("reserva sem recado não cria entrada no mural", async () => {
    const { handler } = novo();
    await post(handler, { presenteId: "g01", nome: "Ana" });
    assert.equal(corpo(await get(handler)).recados.length, 0);
  });
});

/* ------------------------------------------------------------------ */
describe("valor livre", () => {
  test("aceita valor dentro da faixa e pode repetir", async () => {
    const { handler } = novo();
    const a = await post(handler, { presenteId: "livre", nome: "Ana", valor: 75.5 });
    assert.equal(a.status, 201);
    assert.equal(corpo(a).valor, 75.5);
    // não é exclusivo: outra pessoa também pode doar valor livre
    assert.equal((await post(handler, { presenteId: "livre", nome: "Bia", valor: 30 }, "4.4.4.4")).status, 201);
  });

  test("recusa abaixo do mínimo, acima do máximo e não-numérico", async () => {
    const { handler } = novo();
    for (const valor of [1, 999999, "muito", NaN, null]) {
      assert.equal((await post(handler, { presenteId: "livre", nome: "Ana", valor })).status, 400,
        `valor ${valor} deveria ser recusado`);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("limite por IP", () => {
  test(`bloqueia depois de ${LIMITE.max} reservas do mesmo endereço`, async () => {
    const { handler } = novo();
    const ip = "9.9.9.9";
    let ultimo;
    for (let i = 0; i < LIMITE.max + 2; i++) {
      ultimo = await post(handler, { presenteId: "livre", nome: "Bot", valor: 10 }, ip);
    }
    assert.equal(ultimo.status, 429);
    // outro IP continua livre
    assert.equal((await post(handler, { presenteId: "livre", nome: "Gente", valor: 10 }, "8.8.8.8")).status, 201);
  });

  test("o contador do IP não disputa o documento do estado", async () => {
    const { armazem, handler } = novo();
    await post(handler, { presenteId: "g01", nome: "Ana" }, "7.7.7.7");
    const chaves = [...armazem._mapa.keys()];
    assert.ok(chaves.includes(CHAVE_ESTADO));
    assert.ok(chaves.some(k => k.startsWith("limites/")), "o limite mora em chave própria");
  });
});

/* ------------------------------------------------------------------ */
describe("concorrência no documento", () => {
  test("gravação concorrente repete o CAS sem apagar o dado alheio", async () => {
    const armazem = armazemMemoria();
    // Alguém grava g02 exatamente entre a nossa leitura e a nossa escrita.
    let intrometeu = false;
    const gravarOriginal = armazem.gravar.bind(armazem);
    armazem.gravar = async (chave, valor, opcoes) => {
      if (!intrometeu && chave === CHAVE_ESTADO) {
        intrometeu = true;
        await gravarOriginal(chave, {
          rev: 9, reservas: { g02: { nome: "Intruso", valor: 60, ts: 1 } }, recados: [],
        }, {});
      }
      return gravarOriginal(chave, valor, opcoes);
    };

    const handler = criarHandler({ armazem, pix: PIX });
    assert.equal((await post(handler, { presenteId: "g01", nome: "Ana" })).status, 201);

    const c = corpo(await get(handler));
    assert.ok(c.reservas.g01, "a nossa reserva entrou");
    assert.ok(c.reservas.g02, "a reserva do outro NÃO foi apagada pela repetição");
  });

  test("armazém que sempre recusa a escrita estoura ErroConcorrencia", async () => {
    const teimoso = { nome: "teimoso", async ler() { return null; }, async gravar() { return { ok: false }; } };
    await assert.rejects(
      () => atualizarDoc(teimoso, "x", { rev: 0 }, doc => ({ doc }), { tentativas: 3 }),
      ErroConcorrencia
    );
  });

  test("esgotar as tentativas com o presente já tomado vira 409, não 500", async () => {
    const armazem = armazemMemoria();
    await armazem.gravar(CHAVE_ESTADO, {
      rev: 1, reservas: { g01: { nome: "Quem chegou antes", valor: 50, ts: 1 } }, recados: [],
    }, {});
    // A escrita nunca passa: só a releitura pode dizer o que aconteceu.
    armazem.gravar = async () => ({ ok: false });

    const handler = criarHandler({ armazem, pix: PIX });
    const r = await post(handler, { presenteId: "g01", nome: "Atrasada" });
    assert.equal(r.status, 409);
    assert.equal(corpo(r).motivo, "ja_reservado");
  });
});

/* ------------------------------------------------------------------ */
describe("Netlify Blobs (o armazenamento da produção)", () => {
  /** Imita o Blobs: chave -> {valor, etag}, respeitando onlyIfMatch/onlyIfNew.
   *  `texto:true` imita o erro clássico de esquecer o type:"json". */
  function fakeBlobs({ texto = false } = {}) {
    const dados = new Map();
    let n = 0, colisoes = 0;
    return {
      colisoes: () => colisoes,
      pedidos: [],
      async getWithMetadata(chave, opcoes) {
        this.pedidos.push(opcoes);
        const reg = dados.get(chave);
        if (reg == null) return null;
        const bruto = reg.bruto;
        return { data: texto && opcoes?.type !== "json" ? bruto : JSON.parse(bruto), etag: reg.etag };
      },
      async setJSON(chave, valor, opcoes = {}) {
        const atual = dados.get(chave);
        if (opcoes.onlyIfMatch && opcoes.onlyIfMatch !== atual?.etag) { colisoes++; return { modified: false }; }
        if (opcoes.onlyIfNew && atual != null) { colisoes++; return { modified: false }; }
        dados.set(chave, { bruto: JSON.stringify(valor), etag: "e" + (++n) });
        return { modified: true, etag: "e" + n };
      },
      async delete(chave) { dados.delete(chave); },
    };
  }

  const comBlobs = (op) => {
    const b = fakeBlobs(op);
    const armazem = armazemBlobs(b);
    return { b, armazem, handler: criarHandler({ armazem, pix: PIX }) };
  };

  test("reserva grava e aparece no estado", async () => {
    const { handler } = comBlobs();
    assert.equal((await post(handler, { presenteId: "g01", nome: "Ana", recado: "oi" })).status, 201);
    const c = corpo(await get(handler));
    assert.equal(c.armazem, "netlify-blobs");
    assert.equal(c.totais.reservados, 1);
    assert.equal(c.totais.arrecadado, 50);
    assert.equal(c.recados.length, 1);
  });

  test("a leitura pede type:json — sem isso o estado chegaria como texto", async () => {
    const { b, handler } = comBlobs({ texto: true });
    await post(handler, { presenteId: "g01", nome: "Ana" });
    assert.equal(corpo(await get(handler)).totais.reservados, 1);
    assert.ok(b.pedidos.every(p => p?.type === "json"));
  });

  test("o mesmo presente não pode ser reservado duas vezes", async () => {
    const { handler } = comBlobs();
    assert.equal((await post(handler, { presenteId: "g05", nome: "Ana" })).status, 201);
    assert.equal((await post(handler, { presenteId: "g05", nome: "Bruno" }, "2.2.2.2")).status, 409);
  });

  test("oito reservas simultâneas do mesmo presente: só uma vence", async () => {
    const { b, handler } = comBlobs();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post(handler, { presenteId: "g07", nome: `P${i}` }, `10.0.0.${i}`)));
    assert.equal(rs.filter(r => r.status === 201).length, 1);
    assert.equal(rs.filter(r => r.status === 409).length, 7);
    assert.ok(b.colisoes() > 0, "a escrita condicional precisa ter barrado alguém");
  });

  test("duas instâncias da função leem o mesmo estado", async () => {
    const b = fakeBlobs();
    const h1 = criarHandler({ armazem: armazemBlobs(b), pix: PIX });
    const h2 = criarHandler({ armazem: armazemBlobs(b), pix: PIX });

    await post(h1, { presenteId: "g12", nome: "Celular", recado: "do celular" });
    const visto = corpo(await get(h2));
    assert.equal(visto.totais.reservados, 1);
    assert.equal(visto.totais.arrecadado, 1000);
    assert.equal(visto.recados[0].texto, "do celular");
    assert.ok(visto.presentes.find(p => p.id === "g12").reservado);
  });
});

/* ------------------------------------------------------------------ */
describe("armazém em arquivo (servidor local)", () => {
  test("o estado sobrevive a uma nova instância do servidor", async () => {
    const pasta = await mkdtemp(join(tmpdir(), "aniversario-"));
    try {
      const h1 = criarHandler({ armazem: armazemArquivo(pasta), pix: PIX });
      await post(h1, { presenteId: "g12", nome: "Antes", recado: "fica gravado" });

      // Outro processo, mesma pasta.
      const h2 = criarHandler({ armazem: armazemArquivo(pasta), pix: PIX });
      const c = corpo(await get(h2));
      assert.equal(c.totais.reservados, 1);
      assert.equal(c.recados[0].texto, "fica gravado");
      assert.equal((await post(h2, { presenteId: "g12", nome: "Depois" }, "5.5.5.5")).status, 409);
    } finally {
      await rm(pasta, { recursive: true, force: true });
    }
  });

  test("reservas simultâneas no arquivo: só uma vence", async () => {
    const pasta = await mkdtemp(join(tmpdir(), "aniversario-"));
    try {
      const handler = criarHandler({ armazem: armazemArquivo(pasta), pix: PIX });
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        post(handler, { presenteId: "g07", nome: `P${i}` }, `10.0.1.${i}`)));
      assert.equal(rs.filter(r => r.status === 201).length, 1);
    } finally {
      await rm(pasta, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
describe("armazém Firebase (fetch simulado)", () => {
  /** Simula o RTDB com ETag e if-match, incluindo o 412 de conflito. */
  function fakeFirebase({ conflitarNaEscrita = false } = {}) {
    const dados = new Map();
    let n = 0;
    const resp = (status, corpoResp, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: k => headers[k.toLowerCase()] ?? null },
      json: async () => corpoResp,
    });

    const fetchImpl = async (url, opcoes = {}) => {
      const u = new URL(url);
      const chave = u.pathname.replace(/^\//, "").replace(/\.json$/, "");
      const metodo = opcoes.method || "GET";
      const reg = dados.get(chave);

      if (metodo === "GET") {
        return resp(200, reg ? reg.valor : null, { etag: reg ? reg.etag : "etag-vazio" });
      }
      if (metodo === "PUT") {
        if (conflitarNaEscrita && chave === "estado") return resp(412, null);
        const esperado = opcoes.headers?.["if-match"];
        const atual = reg ? reg.etag : "etag-vazio";
        if (esperado && esperado !== atual) return resp(412, null);
        const etag = "e" + (++n);
        dados.set(chave, { valor: JSON.parse(opcoes.body), etag });
        return resp(200, null, { etag });
      }
      return resp(405, null);
    };
    return { fetchImpl, dados };
  }

  const comFirebase = (op, cred = { dbSecret: "segredo" }) => {
    const fb = fakeFirebase(op);
    const armazem = armazemFirebase({
      databaseURL: "https://exemplo.firebaseio.com",
      fetchImpl: fb.fetchImpl,
      ...cred,
    });
    return { fb, armazem, handler: criarHandler({ armazem, pix: PIX }) };
  };

  test("reserva grava e depois aparece no estado", async () => {
    const { fb, handler } = comFirebase();
    assert.equal((await post(handler, { presenteId: "g02", nome: "Tia", recado: "oi" })).status, 201);
    assert.equal(fb.dados.get("estado").valor.reservas.g02.valor, 60);

    const c = corpo(await get(handler));
    assert.equal(c.armazem, "firebase");
    assert.equal(c.totais.reservados, 1);
    assert.equal(c.recados.length, 1);
  });

  test("412 do if-match vira 409, sem sobrescrever quem chegou antes", async () => {
    const { handler } = comFirebase({ conflitarNaEscrita: true });
    const r = await post(handler, { presenteId: "g01", nome: "Atrasado" });
    assert.equal(r.status, 409);
  });

  test("a escrita usa if-match — é isso que dá a atomicidade", async () => {
    const capturadas = [];
    const fb = fakeFirebase();
    const armazem = armazemFirebase({
      databaseURL: "https://exemplo.firebaseio.com",
      dbSecret: "s",
      fetchImpl: async (url, opcoes = {}) => {
        if (opcoes.method === "PUT") capturadas.push(opcoes.headers);
        return fb.fetchImpl(url, opcoes);
      },
    });
    await post(criarHandler({ armazem, pix: PIX }), { presenteId: "g01", nome: "Ana" });
    assert.ok(capturadas.some(h => h && h["if-match"]), "o PUT precisa mandar if-match");
  });

  test("o segredo nunca aparece na resposta ao cliente", async () => {
    const { handler } = comFirebase({}, { dbSecret: "SEGREDO-SUPER-SECRETO" });
    const r = await post(handler, { presenteId: "g01", nome: "Ana" });
    assert.ok(!r.body.includes("SEGREDO-SUPER-SECRETO"));
    const e = await get(handler);
    assert.ok(!e.body.includes("SEGREDO-SUPER-SECRETO"));
  });
});
