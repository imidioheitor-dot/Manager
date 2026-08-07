/* Gerador de BR Code (padrão EMV / Banco Central) — lado servidor.
 *
 * Gerar o payload aqui, e não no navegador, garante que a chave e o valor
 * cobrados são sempre os que o servidor decidiu. O cliente recebe o código
 * pronto e não tem como alterá-lo sem invalidar o CRC.
 */

/** CRC-16/CCITT-FALSE. Valor de referência: crc16("123456789") === "29B1". */
export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Campo TLV: id (2) + tamanho (2) + valor. */
export const tlv = (id, valor) =>
  id + String(valor.length).padStart(2, "0") + valor;

/** O BR Code não aceita acento; nome e cidade vão sem, em maiúsculas. */
export const semAcento = (s, max) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .toUpperCase()
    .trim()
    .slice(0, max);

/**
 * Monta o payload Pix completo, já com CRC.
 * @param {{chave:string,nome:string,cidade:string,valor:number,txid?:string}} p
 */
export function montarPayload({ chave, nome, cidade, valor, txid }) {
  if (!chave) throw new Error("chave Pix ausente");
  if (!(valor > 0)) throw new Error("valor deve ser positivo");

  const merchant = tlv("00", "BR.GOV.BCB.PIX") + tlv("01", chave);

  let payload =
    tlv("00", "01") +                                  // formato
    tlv("26", merchant) +                              // conta Pix
    tlv("52", "0000") +                                // categoria
    tlv("53", "986") +                                 // moeda BRL
    tlv("54", valor.toFixed(2)) +                      // valor
    tlv("58", "BR") +                                  // país
    tlv("59", semAcento(nome, 25) || "RECEBEDOR") +
    tlv("60", semAcento(cidade, 15) || "BRASIL") +
    tlv("62", tlv("05", semAcento(txid, 25) || "***"));

  payload += "6304";
  return payload + crc16(payload);
}

/** Confere se um payload recebido está íntegro (CRC + varredura TLV). */
export function payloadValido(payload) {
  if (typeof payload !== "string" || payload.length < 20) return false;
  if (crc16(payload.slice(0, -4)) !== payload.slice(-4).toUpperCase()) return false;
  let i = 0;
  while (i < payload.length) {
    const len = parseInt(payload.substr(i + 2, 2), 10);
    if (Number.isNaN(len)) return false;
    i += 4 + len;
  }
  return i === payload.length;
}
