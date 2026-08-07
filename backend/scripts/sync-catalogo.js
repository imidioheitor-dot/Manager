/* Regenera src/gifts.js a partir de site/index.html.
 *
 * O catálogo precisa existir nos dois lugares: no site, para desenhar os
 * cartões; no servidor, para decidir o preço. Este script mantém o segundo
 * derivado do primeiro, para os dois não divergirem em silêncio.
 *
 *   npm run sync-catalogo            → grava src/gifts.js
 *   npm run sync-catalogo -- --check → só confere se está em dia (CI)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const AQUI = fileURLToPath(new URL(".", import.meta.url));
const HTML = join(AQUI, "..", "..", "site", "index.html");
const DESTINO = join(AQUI, "..", "src", "gifts.js");
const conferir = process.argv.includes("--check");

const html = readFileSync(HTML, "utf8");

const inicio = html.indexOf("const GIFTS = [");
if (inicio < 0) throw new Error("não achei o array GIFTS em site/index.html");

// Varre equilibrando colchetes, para não parar num "]" dentro de um texto.
let profundidade = 0, fim = -1;
const abre = html.indexOf("[", inicio);
for (let i = abre; i < html.length; i++) {
  if (html[i] === "[") profundidade++;
  else if (html[i] === "]" && --profundidade === 0) { fim = i; break; }
}
if (fim < 0) throw new Error("array GIFTS não fecha");

const bruto = html.slice(abre, fim + 1);
const itens = [...bruto.matchAll(/\{id:"(g\d+)",code:"([^"]+)",t:([\s\S]+?),v:(\d+),/g)];
if (!itens.length) throw new Error("nenhum presente reconhecido");

const desaspar = t => {
  t = t.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t.replace(/\\u201c/g, "“").replace(/\\u201d/g, "”").replace(/\\"/g, '"');
};

const presentes = itens.map(([, id, code, t, v]) => ({
  id, code, titulo: desaspar(t), valor: Number(v),
}));

const linhas = presentes
  .map(p => `  { id: ${JSON.stringify(p.id).padEnd(7)} code: ${(JSON.stringify(p.code) + ",").padEnd(11)} valor: ${(p.valor + ",").padEnd(6)} titulo: ${JSON.stringify(p.titulo)} }`
    .replace(`${JSON.stringify(p.id)} `, `${JSON.stringify(p.id)}, `))
  .join(",\n");

const saida = `/* Catálogo de presentes — FONTE DA VERDADE DO SERVIDOR.
 *
 * O valor de cada presente vive aqui, não no navegador. É isso que impede
 * alguém de abrir o console e reservar a bike de R$1.000 dizendo que pagou
 * R$1: o cliente manda apenas o id, e o servidor decide o preço.
 *
 * ARQUIVO GERADO — não edite à mão. Rode \`npm run sync-catalogo\`.
 */

export const PRESENTES = [
${linhas}
];

export const porId = new Map(PRESENTES.map(p => [p.id, p]));

/** Valor livre: quem quiser doar outra quantia (em reais). */
export const VALOR_LIVRE = { id: "livre", min: 10, max: 50000 };
`;

if (conferir) {
  const atual = readFileSync(DESTINO, "utf8");
  if (atual.trim() !== saida.trim()) {
    console.error("gifts.js está desatualizado — rode: npm run sync-catalogo");
    process.exit(1);
  }
  console.log(`catálogo em dia (${presentes.length} presentes)`);
} else {
  writeFileSync(DESTINO, saida);
  const total = presentes.reduce((s, p) => s + p.valor, 0);
  console.log(`src/gifts.js atualizado: ${presentes.length} presentes, R$${total} no total`);
}
