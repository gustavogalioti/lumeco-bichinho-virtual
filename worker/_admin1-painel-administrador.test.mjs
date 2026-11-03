// ADMIN-1: o Jarbas como administrador do painel — janelas de verificação
// (determinístico + LLM ≤4/dia), resumo compacto no prompt, painel_gerenciar/
// painel_buscar/desfazer_acao_painel, e o botão "Verificar agora" (mode
// painel_verificar_janela).
import assert from "node:assert/strict";
import worker, {
  janelaEstaNaHoraCerta, devoRodarJanelaAgora, achadosItensEsquecidos, achadosContasVencendo,
  achadosConflitoAgenda, achadosDuplicados, avaliarPainelParaJanela, montarResumoPainelLine,
  selectToolsForMessage, companionPrompt,
} from "./index.js";

function fakeCtx() {
  const tasks = [];
  return { waitUntil: (p) => tasks.push(p), tasks };
}

function makeMockKv(storeInicial) {
  const store = new Map(Object.entries(storeInicial || {}));
  return {
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, value); },
    store,
  };
}

const HOJE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ---------- janelaEstaNaHoraCerta / devoRodarJanelaAgora (puras) ----------
{
  assert.equal(janelaEstaNaHoraCerta({ hour: 7, minute: 0 }, "07:00"), true);
  assert.equal(janelaEstaNaHoraCerta({ hour: 7, minute: 14 }, "07:00"), true, "dentro da tolerância de 15min");
  assert.equal(janelaEstaNaHoraCerta({ hour: 7, minute: 15 }, "07:00"), false, "fora da tolerância");
  assert.equal(janelaEstaNaHoraCerta({ hour: 6, minute: 59 }, "07:00"), false);
  assert.equal(janelaEstaNaHoraCerta({ hour: 7, minute: 0 }, "horario-invalido"), false, "nunca quebra com formato inválido");
}
console.log("janelaEstaNaHoraCerta: OK");

{
  assert.equal(devoRodarJanelaAgora("07:00", { hour: 7, minute: 5, dateStr: HOJE }, null), true, "nunca rodou -> roda");
  assert.equal(devoRodarJanelaAgora("07:00", { hour: 7, minute: 5, dateStr: HOJE }, `${HOJE}T07:00:00.000Z`), false, "já rodou hoje -> não roda de novo");
  assert.equal(devoRodarJanelaAgora("07:00", { hour: 7, minute: 5, dateStr: HOJE }, "2020-01-01T07:00:00.000Z"), true, "última execução foi outro dia -> roda");
  assert.equal(devoRodarJanelaAgora("07:00", { hour: 9, minute: 0, dateStr: HOJE }, null), false, "fora da janela -> não roda");
  assert.equal(devoRodarJanelaAgora("07:00", { hour: 9, minute: 0, dateStr: HOJE }, `${HOJE}T07:00:00.000Z`, { forcar: true }), true, "forcar ignora horário e já-rodou-hoje (botão Verificar agora)");
}
console.log("devoRodarJanelaAgora: OK");

// ---------- achados determinísticos (puros) ----------
{
  const resumo = { tarefa: { itens: [
    { titulo: "tarefa parada", status: "now", data: "2020-01-01", prioridade: "alta" },
    { titulo: "tarefa recente", status: "now", data: HOJE },
    { titulo: "tarefa feita", status: "done", data: "2020-01-01" },
  ] } };
  const achados = achadosItensEsquecidos(resumo, HOJE);
  assert.equal(achados.length, 1, "só a tarefa 'now' de muitos dias atrás conta, não a recente nem a concluída");
  assert.equal(achados[0].prioridadeAlta, true);
}
console.log("achadosItensEsquecidos: OK");

{
  const dia = Number(HOJE.slice(8, 10));
  const resumo = { conta: { itens: [
    { titulo: "Internet", status: "pendente", data: `dia ${dia}` },
    { titulo: "Já paga", status: "paga", data: `dia ${dia}` },
    { titulo: "Longe", status: "pendente", data: `dia ${((dia + 20 - 1) % 28) + 1}` },
  ] } };
  const achados = achadosContasVencendo(resumo, dia);
  assert.equal(achados.length, 1, "só a pendente vencendo hoje, não a já paga nem a distante");
  assert.equal(achados[0].diasRestantes, 0);
}
console.log("achadosContasVencendo: OK");

{
  const resumo = { compromisso: { itens: [
    { titulo: "Reunião A", data: `${HOJE} 10:00` },
    { titulo: "Reunião B", data: `${HOJE} 10:00` },
    { titulo: "Dentista", data: `${HOJE} 15:00` },
  ] } };
  const achados = achadosConflitoAgenda(resumo, HOJE);
  assert.equal(achados.length, 1);
  assert.equal(achados[0].hoje, true);
  assert.ok(achados[0].texto.includes("Reunião A") && achados[0].texto.includes("Reunião B"));
}
console.log("achadosConflitoAgenda: OK");

{
  const resumo = { ideia: { itens: [{ titulo: "App de receitas" }, { titulo: "app de receitas" }, { titulo: "Outra coisa" }] } };
  const achados = achadosDuplicados(resumo);
  assert.equal(achados.length, 1, "case-insensitive/acentuação não importa pra achar duplicata");
}
console.log("achadosDuplicados: OK");

{
  const resumo = {};
  assert.deepEqual(avaliarPainelParaJanela(resumo, { hojeISO: HOJE, dayOfMonth: 1 }), [], "painel vazio -> nenhum achado, nunca quebra");
}
console.log("avaliarPainelParaJanela (painel vazio): OK");

// ---------- montarResumoPainelLine (pura) ----------
{
  assert.equal(montarResumoPainelLine(null), "", "sem cache -> vazio, nunca quebra");
  assert.equal(montarResumoPainelLine({ resumo: null }), "");

  const cache = {
    resumo: {
      tarefa: { itens: [{ titulo: "Comprar tinta", status: "now", data: HOJE }, { titulo: "Feita", status: "done", data: HOJE }] },
      compromisso: { itens: [{ titulo: "Dentista", status: null, data: `${HOJE} 15:00` }] },
    },
    ultimaLeitura: { horario: "07:00", em: new Date().toISOString(), texto: "Vi uma conta vencendo hoje." },
  };
  const linha = montarResumoPainelLine(cache);
  assert.ok(linha.includes("Comprar tinta"), "inclui tarefa ativa");
  assert.ok(!linha.includes("Feita"), "nunca inclui item concluído");
  assert.ok(linha.includes("Dentista"), "inclui agenda");
  assert.ok(linha.includes("Vi uma conta vencendo"), "inclui a última leitura do dia");
  assert.ok(linha.length <= 3600, "respeita o orçamento de caracteres");
}
console.log("montarResumoPainelLine: OK");

{
  // orçamento de caracteres é respeitado mesmo com muito conteúdo
  const muitosItens = Array.from({ length: 50 }, (_, i) => ({ titulo: `Item bem longo número ${i} com bastante texto repetido pra engordar o resumo de propósito`, status: "now", data: HOJE }));
  const cache = { resumo: { tarefa: { itens: muitosItens } } };
  const linha = montarResumoPainelLine(cache);
  assert.ok(linha.length <= 3600);
}
console.log("montarResumoPainelLine (corta no orçamento mesmo com muito conteúdo): OK");

// ---------- companionPrompt injeta resumoPainelLine ----------
{
  const prompt = companionPrompt({}, "", "", "", "", "Agenda próxima: Dentista (2026-01-01 15:00)");
  assert.ok(prompt.includes("Agenda próxima: Dentista"));
}
console.log("companionPrompt (injeta resumoPainelLine): OK");

// ---------- selectToolsForMessage oferece as ferramentas novas nos gatilhos certos ----------
{
  const nomes = (tools) => tools.map((t) => t.function.name);
  assert.ok(nomes(selectToolsForMessage("move essa tarefa pra hoje", false, true)).includes("painel_gerenciar"));
  assert.ok(nomes(selectToolsForMessage("marca a conta de luz como paga", false, true)).includes("painel_gerenciar"));
  assert.ok(nomes(selectToolsForMessage("arquiva as tarefas concluídas", false, true)).includes("painel_gerenciar"));
  assert.ok(nomes(selectToolsForMessage("desfaz isso", false, true)).includes("desfazer_acao_painel"));
  assert.ok(nomes(selectToolsForMessage("o que eu tenho sobre o dentista?", false, true)).includes("painel_buscar"));
  assert.ok(!nomes(selectToolsForMessage("oi, bom dia", false, true, {})).includes("painel_buscar"), "saudação simples não precisa de busca");
}
console.log("selectToolsForMessage (gatilhos do ADMIN-1): OK");

// ---------- executarJanelaDeVerificacao (integração, com KV e fetch mockados) ----------
{
  const kv = makeMockKv();
  const env = { COMPANION_KV: kv, PAINEL_API_KEY: "chave-worker", GROQ_API_KEY: "fake" };
  let memState = { config: {}, painelLeitura: {}, insights: [] };
  const dueDay = Number(HOJE.slice(8, 10));

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("action=painel_resumo")) {
      return { ok: true, status: 200, json: async () => ({
        tarefa: { itens: [{ titulo: "tarefa parada", status: "now", data: "2020-01-01" }], hash: "h1" },
        conta: { itens: [{ titulo: "Internet", status: "pendente", data: `dia ${dueDay}` }], hash: "h2" },
      }) };
    }
    if (u.includes("action=jarbas_memory")) {
      return { ok: true, status: 200, json: async () => ({ data: memState }) };
    }
    if (u.includes("groq.com") || u.includes("openai.com")) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Eu vejo uma conta vencendo e uma tarefa parada — eu priorizaria resolver a conta primeiro." } }] }) };
    }
    // jarbas_memory_save (comando POST) e outros
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body.comando === "jarbas_memory_save") { memState = body.arg.data; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const originalFetch = globalThis.fetch;
  try {
    const { executarJanelaDeVerificacao } = await import("./index.js");
    const logBatch = [];
    const cronMetrics = { llmCalls: 0 };
    const r1 = await executarJanelaDeVerificacao(env, logBatch, cronMetrics, { forcar: true, janelaId: "07:00" });
    assert.equal(r1.rodou, true);
    assert.equal(r1.janelas.length, 1);
    assert.ok(r1.janelas[0].achados.length >= 2, "achou a tarefa parada e a conta vencendo");
    assert.equal(r1.janelas[0].llmUsado, true, "achou algo e mudou (primeira vez) -> chama o LLM");
    assert.ok(memState.painelLeitura["07:00"]?.texto, "gravou a leitura em mem.painelLeitura");
    assert.equal(memState.insights.length, 1, "gravou em mem.insights");
    assert.equal(r1.achadosUrgentesPush.length, 0, "achados de tarefa/conta NUNCA viram candidato a push (evita duplicar o aviso de 15min)");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("executarJanelaDeVerificacao (achados + leitura com LLM, nunca duplica push de tarefa/conta): OK");

{
  // conflito de agenda HOJE -> achadosUrgentesPush não fica vazio
  const kv = makeMockKv();
  const env = { COMPANION_KV: kv, PAINEL_API_KEY: "chave-worker", GROQ_API_KEY: "fake" };
  let memState = { config: {}, painelLeitura: {}, insights: [] };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("action=painel_resumo")) {
      return { ok: true, status: 200, json: async () => ({
        compromisso: { itens: [{ titulo: "A", data: `${HOJE} 10:00` }, { titulo: "B", data: `${HOJE} 10:00` }], hash: "h1" },
      }) };
    }
    if (u.includes("action=jarbas_memory")) return { ok: true, status: 200, json: async () => ({ data: memState }) };
    if (u.includes("groq.com") || u.includes("openai.com")) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Tem um conflito de agenda hoje." } }] }) };
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body.comando === "jarbas_memory_save") { memState = body.arg.data; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const originalFetch = globalThis.fetch;
  try {
    const { executarJanelaDeVerificacao } = await import("./index.js");
    const r = await executarJanelaDeVerificacao(env, [], { llmCalls: 0 }, { forcar: true, janelaId: "12:00" });
    assert.equal(r.achadosUrgentesPush.length, 1, "conflito de agenda HOJE é o único tipo que vira candidato a push");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("executarJanelaDeVerificacao (conflito de agenda hoje -> candidato a push): OK");

{
  // orçamento de LLM: a 5ª chamada do dia não chama o LLM, mesmo achando algo novo
  const kv = makeMockKv();
  const env = { COMPANION_KV: kv, PAINEL_API_KEY: "chave-worker", GROQ_API_KEY: "fake" };
  await kv.put(`janela:llm_usage:${HOJE}`, "4");
  let memState = { config: {}, painelLeitura: {}, insights: [] };
  let llmChamadas = 0;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("action=painel_resumo")) return { ok: true, status: 200, json: async () => ({ tarefa: { itens: [{ titulo: "parada", status: "now", data: "2020-01-01" }], hash: "nova" } }) };
    if (u.includes("action=jarbas_memory")) return { ok: true, status: 200, json: async () => ({ data: memState }) };
    if (u.includes("groq.com") || u.includes("openai.com")) { llmChamadas++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const originalFetch = globalThis.fetch;
  try {
    const { executarJanelaDeVerificacao } = await import("./index.js");
    const r = await executarJanelaDeVerificacao(env, [], { llmCalls: 0 }, { forcar: true, janelaId: "16:00" });
    assert.equal(llmChamadas, 0, "orçamento de 4/dia já esgotado -> nenhuma chamada de LLM");
    assert.equal(r.janelas[0].llmUsado, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("executarJanelaDeVerificacao (orçamento de 4 LLM/dia respeitado): OK");

// ---------- mode: painel_verificar_janela (botão "Verificar agora") ----------
{
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("action=painel_resumo")) return { ok: true, status: 200, json: async () => ({}) };
    if (u.includes("action=jarbas_memory")) return { ok: true, status: 200, json: async () => ({ data: {} }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const originalFetch = globalThis.fetch;
  try {
    const env = { SYNC_KEY: "segredo", PAINEL_API_KEY: "chave-worker", COMPANION_KV: makeMockKv() };
    const ctx = fakeCtx();
    const reqSemChave = { method: "POST", json: async () => ({ mode: "painel_verificar_janela" }) };
    const respSemChave = await worker.fetch(reqSemChave, env, ctx);
    assert.equal(respSemChave.status, 401);

    const req = { method: "POST", json: async () => ({ mode: "painel_verificar_janela", key: "segredo", janelaId: "20:00" }) };
    const resp = await worker.fetch(req, env, ctx);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.rodou, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode painel_verificar_janela (botão Verificar agora, protegido por SYNC_KEY): OK");

// ---------- tool painel_gerenciar via conversa completa (fluxo ponta a ponta) ----------
{
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("groq.com") || u.includes("openai.com")) {
      call++;
      if (call === 1) {
        return { ok: true, status: 200, json: async () => ({
          choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "painel_gerenciar", arguments: JSON.stringify({ dominio: "tarefa", acao: "mover", params: { id: "1", status: "today" } }) } }] } }],
        }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"emotion":"confirmado","reply":"Pronto, movi pra Hoje."}' } }] }) };
    }
    if (u.includes("/api/jarbas")) {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.comando === "painel_gerenciar") return { ok: true, status: 200, json: async () => ({ ok: true, reply: "Moveu tarefa #1.", undoId: "u1" }) };
      return { ok: true, status: 200, json: async () => ({ texto: "" }) };
    }
    throw new Error("fetch inesperado: " + u);
  };
  const originalFetch = globalThis.fetch;
  try {
    const env = { GROQ_API_KEY: "fake", PAINEL_API_KEY: "chave-painel" };
    const ctx = fakeCtx();
    const req = { method: "POST", json: async () => ({ mode: "companion", messages: [{ role: "user", content: "move a tarefa 1 pra hoje" }], companionState: {} }) };
    const resp = await worker.fetch(req, env, ctx);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.reply, "Pronto, movi pra Hoje.");
    assert.ok(body.tools_used?.includes("painel_gerenciar"), "tools_used surge pro painel poder oferecer Desfazer");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("painel_gerenciar (fluxo completo via conversa, tools_used surge na resposta): OK");

console.log("_admin1-painel-administrador.test.mjs: todos os testes passaram");
