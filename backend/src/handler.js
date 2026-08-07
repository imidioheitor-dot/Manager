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

/* Um presente pode ser dado por mais de uma pessoa: `reservas[id]` é uma LISTA.
 *
 * Documentos gravados antes dessa mudança guardavam um registro só por
 * presente. Ler é o único lugar onde essa diferença importa, então ela morre
 * aqui: tudo que sai desta função é lista, e o resto do arquivo não precisa
 * saber que a forma antiga existiu. */
function listaDe(valor) {
  if (Array.isArray(valor)) return valor;
  return valor ? [valor] : [];
}

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
    // Só conta como reservado o presente que tem pelo menos uma pessoa.
    const listas = Object.fromEntries(
      Object.entries(reservas).map(([id, v]) => [id, listaDe(v)])
    );
    const reservados = new Set(
      Object.entries(listas).filter(([, l]) => l.length > 0).map(([id]) => id)
    );
    const arrecadado = Object.values(listas)
      .flat()
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
      // Só o que é público: quem deu, quando e por quanto. `nome`/`ts`/`valor`
      // descrevem a primeira pessoa e existem para quem só quer mostrar "já
      // reservado"; `pessoas` traz a lista inteira e `quantidade` o tamanho.
      reservas: Object.fromEntries(
        Object.entries(listas)
          .filter(([, l]) => l.length > 0)
          .map(([id, l]) => {
            const pessoas = l.map(r => ({
              nome: r?.nome ?? "", ts: r?.ts ?? 0, valor: r?.valor ?? 0,
            }));
            return [id, { ...pessoas[0], quantidade: pessoas.length, pessoas }];
          })
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
    const nominal = dados.presenteId !== VALOR_LIVRE.id;

    /* Ninguém é recusado por chegar depois.
     *
     * Um presente já escolhido continua aceitando gente: a lista cresce e as
     * duas contribuições contam. O compare-and-set do armazém segue sendo
     * essencial — agora não para dizer "não" ao segundo, mas justamente para
     * que o segundo não apague o primeiro quando os dois gravam ao mesmo
     * tempo. Reserva e recado vão na MESMA gravação, então nunca sobra um
     * recado no mural sem a contribuição correspondente. */
    const resultado = await atualizarDoc(armazem, CHAVE_ESTADO, ESTADO_VAZIO, doc => {
      const reservas = { ...doc.reservas };
      if (nominal) {
        reservas[dados.presenteId] = [...listaDe(reservas[dados.presenteId]), registro];
      }
      const recados = dados.recado
        ? [{ nome: dados.nome, texto: dados.recado, presente: dados.titulo, ts },
           ...(doc.recados ?? [])].slice(0, MAX_RECADOS)
        : [...(doc.recados ?? [])];
      return { doc: { ...doc, reservas, recados } };
    });

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
      // Quantas pessoas já escolheram este presente, contando esta. O site usa
      // para dizer "você é a 2ª pessoa a dar esse".
      quantidade: nominal
        ? listaDe(resultado.doc.reservas?.[dados.presenteId]).length
        : 1,
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
