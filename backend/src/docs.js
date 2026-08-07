/* ============================================================
   Documentos versionados sobre o armazém.

   Todo o estado do site vive num documento só — `estado` — com um número de
   versão (`rev`) que cresce a cada gravação. Duas coisas saem disso de graça:

   1. O site pergunta "mudou alguma coisa desde a rev N?" e, quase sempre, a
      resposta é um "não" de 100 bytes. Consulta a cada poucos segundos no
      celular sem torrar dado nem bateria.

   2. A gravação é sempre condicional ao que foi lido. Se outra pessoa gravou
      no meio do caminho, o armazém recusa e nós refazemos a alteração sobre o
      estado novo. Ninguém apaga a reserva de ninguém.
   ============================================================ */

/** Estourou as tentativas de gravar sob concorrência. */
export class ErroConcorrencia extends Error {
  constructor() {
    super("não consegui gravar: muita gente escrevendo ao mesmo tempo");
    this.name = "ErroConcorrencia";
  }
}

const espera = ms => new Promise(r => setTimeout(r, ms));

/** Lê o documento, devolvendo o vazio (e `novo:true`) quando ainda não existe. */
export async function lerDoc(armazem, chave, vazio) {
  const reg = await armazem.ler(chave);
  if (!reg || !reg.valor) {
    return { doc: { ...vazio }, etag: reg ? reg.etag : undefined, novo: true };
  }
  return { doc: { ...vazio, ...reg.valor }, etag: reg.etag, novo: false };
}

/**
 * Lê, aplica `mutar` e grava condicionalmente. Repete se alguém gravou no meio.
 *
 * `mutar(doc)` devolve:
 *   { doc }                    → grava esse documento
 *   { abortar:true, ...extra } → não grava nada e devolve o extra
 *   { doc, extra }             → grava e devolve o extra junto
 *
 * @throws {ErroConcorrencia} quando as tentativas se esgotam
 */
export async function atualizarDoc(armazem, chave, vazio, mutar, { tentativas = 10 } = {}) {
  for (let i = 0; i < tentativas; i++) {
    const { doc, etag, novo } = await lerDoc(armazem, chave, vazio);
    const resultado = await mutar(doc);
    if (resultado && resultado.abortar) return resultado;

    const proximo = {
      ...(resultado && resultado.doc ? resultado.doc : doc),
      rev: (doc.rev || 0) + 1,
      atualizadoEm: new Date().toISOString(),
    };

    // Na primeira gravação vai `novo`; o etag segue junto porque o Firebase
    // tem etag até para nó vazio, e assim ele não precisa reler para gravar.
    const gravou = await armazem.gravar(chave, proximo, novo ? { etag, novo: true } : { etag });
    if (gravou.ok) return { doc: proximo, extra: resultado && resultado.extra };

    // Colidiu. Espera um instante variável antes de tentar de novo: sem isso
    // as requisições concorrentes voltam todas juntas e colidem em sincronia.
    if (i < tentativas - 1) await espera(5 + Math.floor(Math.random() * 25));
  }
  throw new ErroConcorrencia();
}
