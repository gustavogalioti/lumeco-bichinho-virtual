// VOZ-4 PARTE A: o Worker marca (c) 1º token do LLM, (d) resposta completa do LLM e
// (e) 1ª frase pronta, e manda tudo num evento "timing" pouco antes do "done" — o app
// junta essas marcações com o que ele mesmo mede (envio, início da fala) pra montar a
// cadeia completa. Também testa o modo latencia_relatar (resumo agregado no Diário).
import assert from "node:assert/strict";
import worker, { handleCompanionStream } from "./index.js";

function sseStreamFrom(dataLines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of dataLines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function collectSseEvents(resp) {
  const text = await resp.text();
  const events = [];
  for (const rawEvent of text.split("\n\n")) {
    if (!rawEvent.trim()) continue;
    let event = "message", dataStr = "";
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (dataStr) events.push({ event, data: JSON.parse(dataStr) });
  }
  return events;
}

// ---------- handleCompanionStream: evento "timing" chega antes do "done", com c <= d ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: sseStreamFrom([
      'data: {"choices":[{"delta":{"content":"{\\"emotion\\":\\"feliz\\",\\"reply\\":\\"Tudo certo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" por aqui!\\"}"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  try {
    const env = { GROQ_API_KEY: "fake" }; // sem PAINEL_API_KEY/COMPANION_KV -> prepareCompanionTurn/flushLogBatch ficam de melhor esforço, sem rede
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    const resp = handleCompanionStream(env, ctx, [{ role: "user", content: "oi, tudo bem?", at: null }], {});
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    const events = await collectSseEvents(resp);
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes("timing"), "manda um evento \"timing\"");
    assert.ok(kinds.includes("done"), "manda um evento \"done\"");
    assert.ok(kinds.indexOf("timing") < kinds.indexOf("done"), "\"timing\" chega ANTES do \"done\" (o app já sabe os tempos antes de processar a resposta final)");
    const timing = events.find((e) => e.event === "timing").data;
    assert.equal(typeof timing.tReceived, "number");
    assert.equal(typeof timing.tFirstToken, "number");
    assert.equal(typeof timing.tLlmComplete, "number");
    assert.equal(typeof timing.tFirstSpeakable, "number");
    assert.ok(timing.tFirstToken >= timing.tReceived, "1º token nunca é antes do Worker receber a requisição");
    assert.ok(timing.tLlmComplete >= timing.tFirstToken, "resposta completa nunca é antes do 1º token");
    assert.ok(timing.tFirstSpeakable >= timing.tFirstToken, "1ª frase pronta nunca é antes do 1º token");
    await Promise.allSettled(waited);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("handleCompanionStream (evento timing antes do done, ordem c<=d e c<=e): OK");

// ---------- handleCompanionStream: atalho (sem chamar o LLM) ainda manda timing coerente ----------
{
  const env = { GROQ_API_KEY: "fake" };
  const ctx = { waitUntil: () => {} };
  const resp = handleCompanionStream(env, ctx, [{ role: "user", content: "oi", at: null }], { shortcuts: [{ gatilho: "oi", acao: "resposta_fixa", texto: "Olá!" }] });
  const events = await collectSseEvents(resp);
  const timing = events.find((e) => e.event === "timing");
  assert.ok(timing, "atalho também manda \"timing\" (mesmo sem passar pelo LLM)");
  assert.equal(typeof timing.data.tFirstToken, "number");
  const done = events.find((e) => e.event === "done");
  assert.equal(done.data.reply, "Olá!");
  console.log("handleCompanionStream (atalho ainda manda timing coerente): OK");
}

// ---------- mode: "latencia_relatar" -- grava UM evento agregado no Diário, nunca por fala ----------
{
  const originalFetch = globalThis.fetch;
  const logAppendCalls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("action=log_append")) {
      logAppendCalls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error("fetch inesperado: " + url);
  };
  try {
    const env = { SYNC_KEY: "segredo", PAINEL_API_KEY: "fake-painel" };
    const ctx = { waitUntil: (p) => p };
    const req = {
      method: "POST",
      json: async () => ({
        mode: "latencia_relatar",
        key: "segredo",
        amostras: 20,
        medianas: { redeIdaMs: 80, primeiroTokenMs: 350, llmCompletoMs: 900, primeiraFraseProntaMs: 420, ttsMs: 600, totalMs: 1500 },
      }),
    };
    const resp = await worker.fetch(req, env, ctx);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(logAppendCalls.length, 1, "UM evento só, nunca um por fala");
    const evento = logAppendCalls[0].eventos[0];
    assert.equal(evento.tipo, "leitura");
    assert.equal(evento.origem, "jarbas");
    assert.match(evento.resumo, /mediana das últimas 20 falas/);
    assert.match(evento.resumo, /1500ms/);
    assert.deepEqual(evento.detalhes.medianas.totalMs, 1500);

    // sem a chave certa -> nunca grava nada (mesma proteção dos outros modos sync)
    const reqSemChave = { method: "POST", json: async () => ({ mode: "latencia_relatar", key: "errada", amostras: 1, medianas: {} }) };
    const resp2 = await worker.fetch(reqSemChave, env, ctx);
    assert.equal(resp2.status, 401);
    assert.equal(logAppendCalls.length, 1, "chave errada nunca grava");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode latencia_relatar (resumo agregado no Diário, protegido por SYNC_KEY): OK");

console.log("_voz4-latencia-instrumentacao.test.mjs: todos os testes passaram");
