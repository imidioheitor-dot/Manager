/* Validação e limpeza de tudo que chega do navegador.
 *
 * Regra da casa: nada que veio do cliente é confiável. Todo campo é checado
 * de tipo, tamanho e conteúdo antes de encostar no banco.
 */

import { porId, VALOR_LIVRE } from "./gifts.js";

export const LIMITES = {
  nome: 40,
  recado: 280,
};

/** Erro com status HTTP, para o handler traduzir direto na resposta. */
export class ErroEntrada extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

/**
 * Remove caracteres de controle (inclusive os invisíveis que quebram layout)
 * e normaliza espaços. Não escapamos HTML aqui: quem renderiza é que escapa,
 * e guardar o texto já escapado estragaria o dado.
 */
export function limparTexto(valor, maximo, campo) {
  if (valor == null) return "";
  if (typeof valor !== "string") {
    throw new ErroEntrada(`${campo} deve ser texto`);
  }
  const limpo = valor
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (limpo.length > maximo) {
    throw new ErroEntrada(`${campo} passa de ${maximo} caracteres`);
  }
  return limpo;
}

/**
 * Valida o corpo de uma reserva e devolve os dados já normalizados,
 * com o VALOR VINDO DO CATÁLOGO — nunca do cliente.
 */
export function validarReserva(corpo) {
  if (!corpo || typeof corpo !== "object") {
    throw new ErroEntrada("corpo da requisição inválido");
  }

  const { presenteId } = corpo;
  if (typeof presenteId !== "string" || !presenteId) {
    throw new ErroEntrada("presenteId é obrigatório");
  }

  let valor;
  let titulo;

  if (presenteId === VALOR_LIVRE.id) {
    // Único caso em que o cliente escolhe o valor — e ainda assim dentro de limites.
    const bruto = Number(corpo.valor);
    if (!Number.isFinite(bruto)) throw new ErroEntrada("valor inválido");
    valor = Math.round(bruto * 100) / 100;
    if (valor < VALOR_LIVRE.min || valor > VALOR_LIVRE.max) {
      throw new ErroEntrada(
        `valor livre deve ficar entre R$${VALOR_LIVRE.min} e R$${VALOR_LIVRE.max}`
      );
    }
    titulo = "Valor livre";
  } else {
    const presente = porId.get(presenteId);
    if (!presente) throw new ErroEntrada("presente não existe", 404);
    valor = presente.valor;   // ← o preço é do servidor
    titulo = presente.titulo;
  }

  const nome = limparTexto(corpo.nome, LIMITES.nome, "nome");
  if (!nome) throw new ErroEntrada("nome é obrigatório");

  const recado = limparTexto(corpo.recado, LIMITES.recado, "recado");

  return { presenteId, valor, titulo, nome, recado };
}
