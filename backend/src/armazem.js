/* ============================================================
   Armazéns — a camada que guarda os dados da API.

   Contrato mínimo, igual para todos:
     ler(chave)                 -> { valor, etag } | null
     gravar(chave, valor, opts) -> { ok, etag }    (ok:false = alguém gravou antes)
     apagar(chave)

   `opts.etag` grava só se o valor guardado ainda for aquele. É um
   compare-and-set de verdade — e é o que impede duas pessoas de reservarem o
   mesmo presente no mesmo segundo. `opts.novo` grava só se a chave ainda não
   existir, para o primeiro acesso de todos.

   Quatro implementações com o mesmo contrato:
     armazemBlobs     Netlify Blobs   — produção, sem configuração nenhuma
     armazemArquivo   arquivos locais — servidor de desenvolvimento e testes
     armazemMemoria   memória         — testes unitários
     armazemFirebase  RTDB via REST   — opcional, para quem quer o dado fora
                                        da Netlify (precisa de credencial)
   ============================================================ */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash, createSign } from "node:crypto";
import path from "node:path";

const etagDe = valor =>
  createHash("sha1").update(JSON.stringify(valor)).digest("hex").slice(0, 16);

/* ---------- Netlify Blobs (produção) ----------
 *
 * Por que este é o padrão: no Netlify cada requisição pode cair numa
 * instância diferente da função. Guardar em memória daria a cada celular um
 * estado próprio — o site "funcionaria" e ninguém veria a mesma meta. O Blobs
 * é compartilhado por todas as instâncias e não pede chave, conta nem
 * variável de ambiente.
 */
export function armazemBlobs(store) {
  if (!store) throw new Error("armazemBlobs precisa do store do @netlify/blobs");
  return {
    nome: "netlify-blobs",

    async ler(chave) {
      // O `type:"json"` é obrigatório: sem ele o Blobs devolve texto e o
      // `valor` chegaria como string — o estado pareceria vazio para todo
      // mundo, silenciosamente.
      const reg = await store.getWithMetadata(chave, { type: "json", consistency: "strong" });
      if (!reg) return null;
      return { valor: reg.data, etag: reg.etag };
    },

    async gravar(chave, valor, { etag, novo } = {}) {
      const opcoes = etag ? { onlyIfMatch: etag } : novo ? { onlyIfNew: true } : {};
      const r = await store.setJSON(chave, valor, opcoes);
      return { ok: r?.modified !== false, etag: r?.etag };
    },

    async apagar(chave) {
      await store.delete(chave);
    },
  };
}

/* ---------- memória (testes) ---------- */
export function armazemMemoria(inicial = {}) {
  const mapa = new Map(
    Object.entries(inicial).map(([k, v]) => [k, { valor: v, etag: etagDe(v) }])
  );
  const copia = v => JSON.parse(JSON.stringify(v));

  return {
    nome: "memoria",

    async ler(chave) {
      const reg = mapa.get(chave);
      return reg ? { valor: copia(reg.valor), etag: reg.etag } : null;
    },

    async gravar(chave, valor, { etag, novo } = {}) {
      const atual = mapa.get(chave);
      if (novo && atual) return { ok: false };
      if (etag && (!atual || atual.etag !== etag)) return { ok: false };
      const proximo = etagDe(valor);
      mapa.set(chave, { valor: copia(valor), etag: proximo });
      return { ok: true, etag: proximo };
    },

    async apagar(chave) { mapa.delete(chave); },

    _mapa: mapa,
  };
}

/* ---------- arquivos locais (npm start e testes de ponta a ponta) ----------
 *
 * Guardar em arquivo — e não em memória — é o que faz o servidor local se
 * comportar como a produção: o estado sobrevive ao reinício e é o mesmo para
 * todas as abas. A fila por chave existe porque entre o `readFile` e o
 * `writeFile` há um `await`, e duas reservas simultâneas poderiam se
 * atropelar exatamente na janela que o compare-and-set deveria fechar.
 */
export function armazemArquivo(pasta) {
  const caminho = chave =>
    path.join(pasta, `${String(chave).replace(/[^a-z0-9/_-]/gi, "_")}.json`);

  const filas = new Map();
  const emFila = (chave, tarefa) => {
    const anterior = filas.get(chave) ?? Promise.resolve();
    const atual = anterior.then(tarefa, tarefa);
    filas.set(chave, atual.catch(() => {}));
    return atual;
  };

  async function lerCru(chave) {
    try {
      const valor = JSON.parse(await readFile(caminho(chave), "utf8"));
      return { valor, etag: etagDe(valor) };
    } catch {
      return null;
    }
  }

  return {
    nome: "arquivo",

    ler: lerCru,

    gravar(chave, valor, { etag, novo } = {}) {
      return emFila(chave, async () => {
        const atual = await lerCru(chave);
        if (novo && atual) return { ok: false };
        if (etag && (!atual || atual.etag !== etag)) return { ok: false };
        const alvo = caminho(chave);
        await mkdir(path.dirname(alvo), { recursive: true });
        await writeFile(alvo, JSON.stringify(valor, null, 2));
        return { ok: true, etag: etagDe(valor) };
      });
    },

    async apagar(chave) { await rm(caminho(chave), { force: true }); },
  };
}

/* ---------- Firebase Realtime Database (opcional) ----------
 *
 * Só entra em cena se FIREBASE_DATABASE_URL e uma credencial estiverem
 * definidas. Serve para quem prefere o dado num banco próprio em vez do
 * Blobs. O compare-and-set vem do par ETag + if-match do próprio RTDB: se
 * alguém gravou entre a nossa leitura e a nossa escrita, volta 412 e nós
 * tentamos de novo — nunca sobrescrevemos.
 *
 * A credencial fica em variável de ambiente, nunca no HTML.
 */
const ESCOPO = "https://www.googleapis.com/auth/firebase.database " +
               "https://www.googleapis.com/auth/userinfo.email";

let cacheToken = { valor: null, expiraEm: 0 };

const base64url = buf =>
  Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Assina um JWT RS256 com a chave da conta de serviço e troca por um access token. */
async function tokenViaContaDeServico(contaJson, fetchImpl) {
  const agora = Math.floor(Date.now() / 1000);
  if (cacheToken.valor && agora < cacheToken.expiraEm - 60) return cacheToken.valor;

  const conta = typeof contaJson === "string" ? JSON.parse(contaJson) : contaJson;
  const cabecalho = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = base64url(JSON.stringify({
    iss: conta.client_email,
    scope: ESCOPO,
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  }));

  const assinador = createSign("RSA-SHA256");
  assinador.update(`${cabecalho}.${corpo}`);
  const jwt = `${cabecalho}.${corpo}.${base64url(assinador.sign(conta.private_key))}`;

  const resp = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`falha ao obter token do Google (${resp.status})`);

  const dados = await resp.json();
  cacheToken = { valor: dados.access_token, expiraEm: agora + (dados.expires_in ?? 3600) };
  return cacheToken.valor;
}

export function armazemFirebase(cfg) {
  const { databaseURL, serviceAccount, dbSecret } = cfg;
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  if (!databaseURL) throw new Error("databaseURL é obrigatório");
  if (!serviceAccount && !dbSecret) {
    throw new Error("defina FIREBASE_SERVICE_ACCOUNT ou FIREBASE_DB_SECRET");
  }
  const raiz = databaseURL.replace(/\/+$/, "");

  async function url(chave) {
    const caminho = String(chave).split("/").map(encodeURIComponent).join("/");
    if (dbSecret) return `${raiz}/${caminho}.json?auth=${encodeURIComponent(dbSecret)}`;
    const token = await tokenViaContaDeServico(serviceAccount, fetchImpl);
    return `${raiz}/${caminho}.json?access_token=${encodeURIComponent(token)}`;
  }

  async function lerComEtag(chave) {
    const resp = await fetchImpl(await url(chave), { headers: { "X-Firebase-ETag": "true" } });
    if (!resp.ok) throw new Error(`falha ao ler ${chave} (${resp.status})`);
    return { valor: await resp.json(), etag: resp.headers.get("ETag") };
  }

  return {
    nome: "firebase",

    async ler(chave) {
      const { valor, etag } = await lerComEtag(chave);
      // Devolve o etag mesmo quando o nó está vazio: é ele que permite a
      // primeira gravação ser condicional também.
      return { valor: valor ?? null, etag: etag ?? undefined };
    },

    async gravar(chave, valor, { etag, novo } = {}) {
      let condicao = etag;
      if (!condicao && novo) condicao = (await lerComEtag(chave)).etag;

      const resp = await fetchImpl(await url(chave), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(condicao ? { "if-match": condicao } : {}),
        },
        body: JSON.stringify(valor),
      });
      if (resp.status === 412) return { ok: false };   // alguém gravou antes
      if (!resp.ok) throw new Error(`falha ao gravar ${chave} (${resp.status})`);
      return { ok: true, etag: resp.headers.get("ETag") ?? undefined };
    },

    async apagar(chave) {
      await fetchImpl(await url(chave), { method: "DELETE" });
    },
  };
}
