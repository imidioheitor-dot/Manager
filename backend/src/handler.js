/* ============================================================
   Roteador da API — sem dependência de framework.

   Fala Request/Response do padrão da web, então o mesmo código roda dentro de
   uma Netlify Function, num servidor Node local e direto num teste. Tudo o
   que precisa guardar passa pelo "armazém" (src/armazem.js).

   Rotas (todas sob /api):
     GET  /api/status    de pé? qual armazenamento? qual a versão do estado?
     GET  /api/estado    presentes, reservas, mural e totais (aceita ?rev=)
     POST /api/reservar  reserva um presente e devolve o código Pix
   ============================================================ */

import { PRESENTES, VALOR_LIVRE } from "./gifts.js";
import { validarReserva, ErroEntrada } from "./validate.js";
import { montarPayload } from "./pix.js";
import { lerDoc, atualizarDoc, ErroConcorrencia } from "./docs.js";

/* Marca em TODA resposta. É assim que o site sabe que falou com a nossa API,
 * e não com o index.html que uma hospedagem sem funções devolve — com status
 * 200 — para qualquer caminho que não existe. */
export const SERVICO = "aniversario-heitor";

/** Teto de reservas por IP, para um script não varrer a lista inteira. */
export const LIMITE = { max: 10, janelaMs: 10 * 60 * 1000 };

export const CHAVE_ESTADO = "estado";
export const ESTADO_VAZIO = { rev: 0, atualizadoEm: null, reservas: {}, recados: [] };

const MAX_RECADOS = 500;

const json = (status, dados) => ({
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
  body: JSON.stringify({ servico: SERVICO, ...dados }),
});

const erro = (status, mensagem, extra) =>
  json(status, { ok: false, erro: mensagem, ...(extra || {}) });

/* Contagem por IP em chave própria, best-effort de propósito.
 *
 * Ficar no mesmo documento do estado seria pior que inútil: cada reserva
 * faria duas escritas no mesmo lugar e as pessoas passariam a colidir umas
 * com as outras sem necessidade. E não vale pagar compare-and-set por um
 * limite que existe para conter script, não para contabilidade. */
async function contarTentativas(armazem, ip, janelaMs, agora) {
  const chave = "limites/" + Buffer.from(String(ip)).toString("base64url").slice(0, 40);
  let anteriores = [];
  try {
    const reg = await armazem.ler(chave);
    if (Array.isArray(reg?.valor)) anteriores = reg.valor;
  } catch { /* primeira vez desse IP */ }

  const recentes = anteriores.filter(t => agora - t < janelaMs);
  recentes.push(agora);
  try { await armazem.gravar(chave, recentes.slice(-50), {}); } catch { /* ignora */ }
  return recentes.length;
}

/**
 * @param {{armazem:object, pix:{chave:string,nome:string,cidade:string}, agora?:Function}} cfg
 */
export function criarHandler(cfg) {
  const { armazem, pix } = cfg;
  const agora = cfg.agora ?? (() => Date.now());

  /* ---------- GET /api/status ---------- */
  async function status() {
    const { doc } = await lerDoc(armazem, CHAVE_ESTADO, ESTADO_VAZIO);
    return json(200, {
      ok: true,
      armazem: armazem.nome,
      versao: 2,
      presentes: PRESENTES.length,
      rev: doc.rev || 0,
      atualizadoEm: doc.atualizadoEm,
    });
  }

  /* ---------- GET /api/estado ---------- */
  async function estado(req) {
    const { doc } = await lerDoc(armazem, CHAVE_ESTADO, ESTADO_VAZIO);
    const rev = doc.rev || 0;

    // Resposta curtinha quando o aparelho já está com a versão atual. É o que
    // deixa a consulta periódica barata no celular.
    const conhecido = req.query?.rev;
    if (conhecido != null && conhecido !== "" && Number(conhecido) === rev) {
      return json(200, { ok: true, rev, semMudanca: true, atualizadoEm: doc.atualizadoEm });
    }

    const reservas = doc.reservas ?? {};
    const reservados = new Set(Object.keys(reservas));
    const arrecadado = Object.values(reservas)
      .reduce((s, r) => s + (Number(r?.valor) || 0), 0);

    return json(200, {
      ok: true,
      armazem: armazem.nome,
      rev,
      atualizadoEm: doc.atualizadoEm,
      presentes: PRESENTES.map(p => ({
        id: p.id,
        code: p.code,
        titulo: p.titulo,
        valor: p.valor,
        reservado: reservados.has(p.id),
      })),
      // Só o que é público: quem reservou, quando e por quanto.
      reservas: Object.fromEntries(
        Object.entries(reservas).map(([id, r]) => [
          id,
          { nome: r?.nome ?? "", ts: r?.ts ?? 0, valor: r?.valor ?? 0 },
        ])
      ),
      recados: [...(doc.recados ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)),
      totais: {
        presentes: PRESENTES.length,
        reservados: reservados.size,
        arrecadado,
      },
    });
  }

  /* ---------- POST /api/reservar ---------- */
  async function reservar(req) {
    const dados = validarReserva(req.body);

    const tentativas = await contarTentativas(
      armazem, req.ip || "sem-ip", LIMITE.janelaMs, agora()
    );
    if (tentativas > LIMITE.max) {
      return erro(429, "muitas reservas seguidas desse endereço; espere alguns minutos");
    }

    const ts = agora();
    const registro = { nome: dados.nome, valor: dados.valor, titulo: dados.titulo, ts };
    const exclusivo = dados.presenteId !== VALOR_LIVRE.id;

    // Reserva e recado numa gravação só: menos disputa, e nunca acontece de
    // sobrar um recado no mural sem a reserva correspondente.
    let resultado;
    try {
      resultado = await atualizarDoc(armazem, CHAVE_ESTADO, ESTADO_VAZIO, doc => {
        if (exclusivo && doc.reservas?.[dados.presenteId]) {
          return { abortar: true, motivo: "ja_reservado" };
        }
        const reservas = exclusivo
          ? { ...doc.reservas, [dados.presenteId]: registro }
          : { ...doc.reservas };
        const recados = dados.recado
          ? [{ nome: dados.nome, texto: dados.recado, presente: dados.titulo, ts },
             ...(doc.recados ?? [])].slice(0, MAX_RECADOS)
          : [...(doc.recados ?? [])];
        return { doc: { ...doc, reservas, recados } };
      });
    } catch (e) {
      if (!(e instanceof ErroConcorrencia)) throw e;
      // Esgotou sob concorrência alta. Em vez de estourar um 500, relê e deixa
      // o estado real decidir: se o presente já saiu, isso é 409, não erro.
      const { doc } = await lerDoc(armazem, CHAVE_ESTADO, ESTADO_VAZIO);
      if (exclusivo && doc.reservas?.[dados.presenteId]) {
        return erro(409, "esse presente acabou de ser reservado por outra pessoa",
          { conflito: true, motivo: "ja_reservado" });
      }
      throw e;
    }

    if (resultado.abortar) {
      return erro(409, "esse presente acabou de ser reservado por outra pessoa",
        { conflito: true, motivo: resultado.motivo });
    }

    // O código Pix nasce aqui, com a chave e o valor que o SERVIDOR definiu.
    const payload = montarPayload({
      chave: pix.chave,
      nome: pix.nome,
      cidade: pix.cidade,
      valor: dados.valor,
      txid: dados.presenteId,
    });

    return json(201, {
      ok: true,
      presenteId: dados.presenteId,
      titulo: dados.titulo,
      valor: dados.valor,
      rev: resultado.doc.rev,
      pix: payload,
    });
  }

  /* ---------- roteamento ----------
   * Aceita /api/x e /.netlify/functions/api/x — o segundo só por segurança,
   * caso alguém chame o endpoint padrão da função. */
  const ROTAS = {
    "GET ": status,
    "GET status": status,
    "GET saude": status,
    "GET estado": estado,
    "POST reservar": reservar,
  };

  function recurso(caminho) {
    const limpo = String(caminho || "")
      .replace(/^\/\.netlify\/functions\/api/, "")
      .replace(/^\/api/, "");
    return limpo.split("/").filter(Boolean)[0] || "";
  }

  return async function handler(req) {
    if (req.method === "OPTIONS") return { status: 204, headers: {}, body: "" };

    const rota = ROTAS[`${req.method} ${recurso(req.path)}`];
    if (!rota) return erro(404, "rota não encontrada");

    try {
      return await rota(req);
    } catch (e) {
      if (e instanceof ErroEntrada) return erro(e.status, e.message);
      if (e instanceof ErroConcorrencia) {
        return erro(409, "muita gente reservando ao mesmo tempo; tente de novo");
      }
      // Erro nosso: registra, mas não vaza detalhe interno para o cliente.
      console.error("[api]", e);
      return erro(500, "erro interno");
    }
  };
}
