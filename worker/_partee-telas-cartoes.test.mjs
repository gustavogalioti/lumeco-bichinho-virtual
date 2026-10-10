// PARTE E: telas ao redor do rosto (dados reais, sem IA) e cartões determinísticos.
import assert from "node:assert/strict";
import {
  construirTelasTarefas,
  construirTelasContas,
  calcularProximoEmMin,
  construirCardClima,
  construirCardAgendaHoje,
  parseAgendaTexto,
  montarTelasCached,
} from "./index.js";

// ---------- construirTelasTarefas ----------
{
  const r = construirTelasTarefas([
    { id: "1", status: "now" }, { id: "2", status: "now" }, { id: "3", status: "hoje" }, { id: "4", status: "pendente" },
  ]);
  assert.deepEqual(r, { porColuna: { now: 2, hoje: 1, pendente: 1 } }, "conta por status real, sem supor nomes fixos");
  assert.deepEqual(construirTelasTarefas([]), { porColuna: {} }, "vazio -> porColuna vazio, nunca quebra");
  assert.deepEqual(construirTelasTarefas(null), { porColuna: {} }, "null -> nunca quebra");
  console.log("construirTelasTarefas: OK");
}

// ---------- construirTelasContas ----------
{
  const contas = [
    { id: "1", status: "pendente", data: "5" }, // vence dia 5
    { id: "2", status: "pendente", data: "20" }, // vence dia 20 (não ainda)
    { id: "3", status: "paga", data: "5" }, // já paga, não conta
    { id: "4", status: "pendente", data: "10" }, // vence hoje (dia 10)
  ];
  const r = construirTelasContas(contas, 10);
  assert.deepEqual(r, { vencendo: 2, total: 4 }, "vencendo = pendentes com dia <= hoje; total = todas");
  assert.deepEqual(construirTelasContas([], 10), { vencendo: 0, total: 0 });
  assert.deepEqual(construirTelasContas(null, 10), { vencendo: 0, total: 0 }, "null -> nunca quebra");
  console.log("construirTelasContas: OK");
}

// ---------- calcularProximoEmMin ----------
{
  const agenda = [{ hora: "09:00", titulo: "A" }, { hora: "11:30", titulo: "B" }, { hora: "15:00", titulo: "C" }];
  assert.equal(calcularProximoEmMin(agenda, 8 * 60), 60, "8h -> próximo (9h) em 60min");
  assert.equal(calcularProximoEmMin(agenda, 10 * 60), 90, "10h -> próximo (11h30) em 90min, ignora o que já passou");
  assert.equal(calcularProximoEmMin(agenda, 16 * 60), null, "depois do último -> null (nada mais hoje)");
  assert.equal(calcularProximoEmMin([], 8 * 60), null, "agenda vazia -> null");
  assert.equal(calcularProximoEmMin(null, 8 * 60), null, "null -> nunca quebra");
  console.log("calcularProximoEmMin: OK");
}

// ---------- parseAgendaTexto + fatiamento das 4 primeiras (uso em montarTelasDados) ----------
{
  const texto = "09:00 Reunião; 11:30 Call; 15:00 Estudo; 19:30 Jantar; 21:00 Ligar pro Pedro";
  const itens = parseAgendaTexto(texto);
  assert.equal(itens.length, 5);
  assert.deepEqual(itens.slice(0, 4).map((i) => i.hora), ["09:00", "11:30", "15:00", "19:30"], "telas mostram só os 4 primeiros compromissos");
  console.log("parseAgendaTexto (fatiamento pras telas): OK");
}

// ---------- construirCardClima ----------
{
  const texto = "Em São Paulo agora: céu limpo, 22°C. Hoje: mínima 15°C, máxima 24°C, 10% de chance de chuva.";
  const card = construirCardClima(texto);
  assert.deepEqual(card, { tipo: "clima", titulo: "Clima", valor: "22°C", sub: "céu limpo" });
  assert.equal(construirCardClima(""), null, "vazio -> null");
  assert.equal(construirCardClima("Não encontrei a cidade \"xyz\"."), null, "sem temperatura -> null, nunca inventa");
  assert.equal(construirCardClima(null), null, "não-string -> nunca quebra");
  console.log("construirCardClima: OK");
}

// ---------- construirCardAgendaHoje ----------
{
  const texto = "09:00 Reunião com o time; 11:30 Call com cliente; 15:00 Estudo; 19:30 Jantar; 21:00 Extra";
  const card = construirCardAgendaHoje(texto, "hoje");
  assert.equal(card.tipo, "lista");
  assert.equal(card.titulo, "Agenda de hoje");
  assert.deepEqual(card.linhas, ["09:00 Reunião com o time", "11:30 Call com cliente", "15:00 Estudo", "19:30 Jantar"], "no máximo 4 linhas");

  assert.equal(construirCardAgendaHoje(texto, "amanha"), null, "só agenda de HOJE vira cartão determinístico");
  assert.equal(construirCardAgendaHoje("", "hoje"), null, "fonte vazia -> null, nunca inventa");
  assert.equal(construirCardAgendaHoje("Agenda: não consegui consultar agora (timeout).", "hoje"), null, "texto de erro sem horários -> null");
  console.log("construirCardAgendaHoje: OK");
}

// ---------- montarTelasCached: formato da resposta e cache de 5 min no KV ----------
{
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url) => {
    fetchCalls++;
    const u = String(url);
    if (u.includes("action=agenda")) {
      return { ok: true, json: async () => ({ texto: "09:00 Reunião; 11:30 Call; 15:00 Estudo; 19:30 Jantar; 21:00 Extra" }) };
    }
    if (u.includes("action=mudancas")) {
      return {
        ok: true,
        json: async () => ({
          tarefas: { itens: [{ id: "1", status: "now" }, { id: "2", status: "hoje" }] },
          contas: { itens: [{ id: "1", status: "pendente", data: "1" }] },
        }),
      };
    }
    return { ok: true, json: async () => ({ texto: "" }) };
  };
  const store = new Map();
  const env = {
    PAINEL_API_KEY: "fake",
    COMPANION_KV: {
      get: async (key) => (store.has(key) ? store.get(key) : null),
      put: async (key, value) => { store.set(key, value); },
    },
  };

  try {
    const dados = await montarTelasCached(env, {});
    assert.ok(Array.isArray(dados.agenda), "agenda é uma lista");
    assert.ok(dados.agenda.length <= 4, "no máximo 4 compromissos");
    assert.ok("proximoEmMin" in dados);
    assert.ok(dados.tarefas && typeof dados.tarefas.porColuna === "object", "formato tarefas.porColuna");
    assert.ok(dados.contas && typeof dados.contas.vencendo === "number" && typeof dados.contas.total === "number", "formato contas.vencendo/total");
    assert.deepEqual(dados.noticias, [], "sem fonte configurada -> lista vazia, nunca dado de exemplo");
    assert.deepEqual(dados.mercado, [], "sem fonte configurada -> lista vazia, nunca dado de exemplo");

    const callsAfterFirst = fetchCalls;
    assert.ok(callsAfterFirst > 0, "primeira chamada bate no painel");

    // segunda chamada imediata -> serve do cache, não bate no painel de novo
    const dados2 = await montarTelasCached(env, {});
    assert.equal(fetchCalls, callsAfterFirst, "cache de 5min: segunda chamada não bate no painel de novo");
    assert.deepEqual(dados2, dados, "serve exatamente o mesmo dado cacheado");

    // cache expirado (mais de 5min) -> bate no painel de novo
    const cached = JSON.parse(store.get("telas:cache"));
    cached.cachedAt = Date.now() - 6 * 60 * 1000;
    store.set("telas:cache", JSON.stringify(cached));
    await montarTelasCached(env, {});
    assert.ok(fetchCalls > callsAfterFirst, "cache expirado -> busca de novo no painel");
    console.log("montarTelasCached (formato + cache de 5min): OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("_partee-telas-cartoes.test.mjs: todos os testes passaram");
