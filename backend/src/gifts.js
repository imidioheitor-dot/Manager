/* Catálogo de presentes — FONTE DA VERDADE DO SERVIDOR.
 *
 * O valor de cada presente vive aqui, não no navegador. É isso que impede
 * alguém de abrir o console e reservar a bike de R$1.000 dizendo que pagou
 * R$1: o cliente manda apenas o id, e o servidor decide o preço.
 *
 * ARQUIVO GERADO — não edite à mão. Rode `npm run sync-catalogo`.
 */

export const PRESENTES = [
  { id: "g01",   code: "ND-101",   valor: 50,    titulo: "Um café na Starbucks" },
  { id: "g02",   code: "ND-102",   valor: 60,    titulo: "Um almoço no aeroporto" },
  { id: "g03",   code: "ND-103",   valor: 80,    titulo: "Um par de meias pro frio de Notre Dame" },
  { id: "g04",   code: "ND-104",   valor: 40,    titulo: "Um lenço de lágrimas pra mamãe" },
  { id: "g05",   code: "ND-105",   valor: 500,   titulo: "Ingresso pro jogo no estádio de Notre Dame" },
  { id: "g06",   code: "ND-106",   valor: 300,   titulo: "Um power bank pras 300 mensagens diárias da mãe" },
  { id: "g07",   code: "ND-107",   valor: 200,   titulo: "Um cobertor quentinho pro dormitório" },
  { id: "g08",   code: "ND-108",   valor: 200,   titulo: "Um par de pantufas bem \"lá ele\"" },
  { id: "g09",   code: "ND-109",   valor: 100,   titulo: "Uma ajudinha pra voltar no Ano Novo dos Imídio" },
  { id: "g10",   code: "ND-110",   valor: 500,   titulo: "Uma passagem de trem pra curtir a vista" },
  { id: "g11",   code: "ND-111",   valor: 200,   titulo: "Um capacete de futebol americano" },
  { id: "g12",   code: "ND-112",   valor: 1000,  titulo: "Uma bike pra andar no campus" },
  { id: "g13",   code: "ND-113",   valor: 120,   titulo: "Flores pra namorada, uma vez por mês" },
  { id: "g14",   code: "ND-114",   valor: 1990,  titulo: "Um iPad pra encher de conta de matemática" },
  { id: "g15",   code: "ND-115",   valor: 50,    titulo: "Uma garrafa de água pra não passar sede" },
  { id: "g16",   code: "ND-116",   valor: 90,    titulo: "Ticket da lavanderia do dormitório" },
  { id: "g17",   code: "ND-117",   valor: 200,   titulo: "Camiseta do time de futebol americano" },
  { id: "g18",   code: "ND-118",   valor: 250,   titulo: "Um livro de física com problemas super “fáceis”" },
  { id: "g19",   code: "ND-119",   valor: 150,   titulo: "Um kit de material escolar" },
  { id: "g20",   code: "ND-120",   valor: 700,   titulo: "Bagagem extra na volta, pra trazer presentes" }
];

export const porId = new Map(PRESENTES.map(p => [p.id, p]));

/** Valor livre: quem quiser doar outra quantia (em reais). */
export const VALOR_LIVRE = { id: "livre", min: 10, max: 50000 };
