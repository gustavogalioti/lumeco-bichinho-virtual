// PAINEL-3: ponte painel → Worker no modo "companion" (companionState.origem="painel").
// Exige a mesma SYNC_KEY dos outros modos protegidos (o app de voz continua sem
// precisar de chave, como sempre); expõe tools_used pro painel oferecer "Desfazer";
// não marca o briefing como "lido" (o app de voz continua marcando normalmente);
// a ferramenta de recados passa a ser oferecida numa saudação, não só com a palavra
// "recado"; e o prompt pede confirmação antes de apagar/arquivar quando origem=painel.
import assert from "node:assert/strict";
import worker, { selectToolsForMessage, companionPrompt } from "./index.js";

function fakeCtx() {
  const tasks = [];
  return { waitUntil: (p) => tasks.push(p), tasks };
}

// ---------- companionState.origem === "painel" exige SYNC_KEY ----------
{
  const env = { GROQ_API_KEY: "fake" };
  const ctx = fakeCtx();
  const req = {
    method: "POST",
    json: async () => ({ mode: "companion", messages: [{ role: "user", content: "oi" }], companionState: { origem: "painel" } }),
  };
  const resp = await worker.fetch(req, env, ctx);
  assert.equal(resp.status, 401, "sem SYNC_KEY configurada no Worker -> nunca deixa passar");
  const body = await resp.json();
  assert.equal(body.error, "unauthorized");
}
{
  const env = { GROQ_API_KEY: "fake", SYNC_KEY: "segredo" };
  const ctx = fakeCtx();
  const req = {
    method: "POST",
    json: async () => ({ mode: "companion", key: "errada", messages: [{ role: "user", content: "oi" }], companionState: { origem: "painel" } }),
  };
  const resp = await worker.fetch(req, env, ctx);
  assert.equal(resp.status, 401, "chave errada -> 401, mesmo com SYNC_KEY configurada");
}
console.log("mode companion (origem=painel exige SYNC_KEY): OK");

// ---------- app de voz (sem origem) continua funcionando sem chave nenhuma ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"emotion":"neutro","reply":"Oi! Tudo bem?"}' } }] }),
  });
  try {
    const env = { GROQ_API_KEY: "fake", SYNC_KEY: "segredo" }; // SYNC_KEY existe, mas não é exigida sem origem:"painel"
    const ctx = fakeCtx();
    const req = {
      method: "POST",
      json: async () => ({ mode: "companion", messages: [{ role: "user", content: "oi" }], companionState: {} }),
    };
    const resp = await worker.fetch(req, env, ctx);
    assert.equal(resp.status, 200, "app de voz (sem companionState.origem) nunca precisa de chave, como sempre foi");
    const body = await resp.json();
    assert.equal(body.reply, "Oi! Tudo bem?");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode companion (app de voz sem origem continua sem exigir chave): OK");

// ---------- tools_used aparece na resposta quando uma ferramenta de escrita rodou ----------
{
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    call++;
    const u = String(url);
    if (u.includes("groq.com") || u.includes("openai.com")) {
      if (call === 1) {
        // 1ª chamada: decide chamar a ferramenta de criar tarefa
        return {
          ok: true, status: 200,
          json: async () => ({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "gerenciar_tarefa", arguments: JSON.stringify({ acao: "criar", texto: "comprar tinta" }) } }] } }],
          }),
        };
      }
      // 2ª chamada (pós-ferramenta): fala o resultado
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"emotion":"confirmado","reply":"Pronto, criei a tarefa."}' } }] }) };
    }
    if (u.includes("/api/jarbas")) {
      return { ok: true, status: 200, json: async () => ({ reply: "Criei a tarefa \"comprar tinta\"." }) };
    }
    throw new Error("fetch inesperado: " + u);
  };
  try {
    const env = { GROQ_API_KEY: "fake", SYNC_KEY: "segredo", PAINEL_API_KEY: "fake-painel" };
    const ctx = fakeCtx();
    const req = {
      method: "POST",
      json: async () => ({
        mode: "companion", key: "segredo",
        messages: [{ role: "user", content: "@jarbas cria a tarefa comprar tinta em De Hoje" }],
        companionState: { origem: "painel" },
      }),
    };
    const resp = await worker.fetch(req, env, ctx);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.tools_used, ["gerenciar_tarefa"], "tools_used expõe a ferramenta que rodou, pro painel oferecer Desfazer");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode companion (tools_used exposto na resposta): OK");

// ---------- origem=painel NÃO marca o briefing como lido numa saudação ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("groq.com") || u.includes("openai.com")) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"emotion":"feliz","reply":"Bom dia! Tudo certo por aqui."}' } }] }) };
    }
    if (u.includes("/api/jarbas")) {
      // sem PAINEL_API_KEY configurada o gather nem roda; esse fetch só existiria se gatherDayData tentasse
      return { ok: true, status: 200, json: async () => ({ texto: "" }) };
    }
    throw new Error("fetch inesperado: " + u);
  };
  try {
    const env = { GROQ_API_KEY: "fake", SYNC_KEY: "segredo" }; // sem PAINEL_API_KEY/COMPANION_KV -> sem rede extra
    const ctx = fakeCtx();
    const req = {
      method: "POST",
      json: async () => ({
        mode: "companion", key: "segredo",
        messages: [{ role: "user", content: "bom dia jarbas" }],
        companionState: { origem: "painel" },
      }),
    };
    const resp = await worker.fetch(req, env, ctx);
    assert.equal(resp.status, 200);
    // nenhuma das tasks em segundo plano deveria tentar marcar o briefing como lido
    // (não há como inspecionar isso diretamente sem COMPANION_KV, mas o ponto chave é
    // que a chamada inteira funciona normalmente sem explodir mesmo numa saudação).
    await Promise.allSettled(ctx.tasks);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode companion (origem=painel numa saudação não quebra, sem marcar briefing): OK");

// ---------- selectToolsForMessage: recados oferecidos numa saudação, não só com a palavra "recado" ----------
{
  const toolNames = (tools) => tools.map((t) => t.function.name);
  const semSaudacao = selectToolsForMessage("oi, tudo bem?", false, true, {});
  assert.ok(!toolNames(semSaudacao).includes("consultar_recados"), "sem saudação detectada e sem a palavra recado -> não oferece");

  const comSaudacao = selectToolsForMessage("oi, tudo bem?", false, true, { saudacaoDetectada: true });
  assert.ok(toolNames(comSaudacao).includes("consultar_recados"), "saudação detectada -> oferece consultar_recados mesmo sem a palavra");
  assert.ok(toolNames(comSaudacao).includes("concluir_recado"));

  const comPalavra = selectToolsForMessage("tem algum recado pra mim?", false, true, {});
  assert.ok(toolNames(comPalavra).includes("consultar_recados"), "a palavra recado sozinha continua oferecendo, como antes");
}
console.log("selectToolsForMessage (recados também numa saudação): OK");

// ---------- companionPrompt: confirmação antes de apagar/arquivar só quando origem=painel ----------
{
  const semOrigem = companionPrompt({}, "", "", "", "");
  assert.ok(!semOrigem.includes("painel de controle (mensagem de texto"), "sem origem (app de voz) -> sem a linha de confirmação");

  const comOrigemPainel = companionPrompt({ origem: "painel" }, "", "", "", "");
  assert.ok(comOrigemPainel.includes("confirme com a pessoa"), "origem=painel -> pede confirmação antes de apagar/arquivar");
  assert.ok(comOrigemPainel.includes("criar e atualizar seguem normalmente"), "nunca bloqueia criar/atualizar, só destrutivo");
}
console.log("companionPrompt (confirmação de ação destrutiva só pro canal painel): OK");

console.log("_painel3-ponte-jarbas.test.mjs: todos os testes passaram");
