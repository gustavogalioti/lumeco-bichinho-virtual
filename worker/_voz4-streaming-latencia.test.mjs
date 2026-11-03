// VOZ-4 PARTE B.2: parsing de SSE, extração incremental de campo JSON, streaming do
// primeiro LLM com fallback entre provedores, e a regra de esforço de raciocínio
// pós-ferramenta por tipo de ferramenta.
import assert from "node:assert/strict";
import {
  parseSseBuffer,
  extractJsonStringFieldSoFar,
  efeitoRaciocinioPosFerramenta,
  streamFirstLlmCall,
} from "./index.js";

// ---------- parseSseBuffer ----------
{
  const buf = 'data: {"choices":[{"delta":{"content":"Oi"}}]}\n\ndata: {"choices":[{"delta":{"content":" tudo"}}]}\n\ndata: [DONE]\n\n';
  const { events, remainder } = parseSseBuffer(buf);
  assert.equal(events.length, 2, "2 eventos completos, [DONE] é ignorado");
  assert.equal(events[0].choices[0].delta.content, "Oi");
  assert.equal(events[1].choices[0].delta.content, " tudo");
  assert.equal(remainder, "", "buffer totalmente consumido -> remainder vazio");

  // evento incompleto (sem \n\n final) fica no remainder pro próximo pedaço completar
  const parcial = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta"';
  const r2 = parseSseBuffer(parcial);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.remainder, 'data: {"choices":[{"delta"', "fragmento incompleto nunca é descartado, fica pro próximo read()");

  // fragmento malformado (JSON quebrado) nunca lança, só é ignorado
  const malformado = "data: {quebrado\n\ndata: [DONE]\n\n";
  assert.doesNotThrow(() => parseSseBuffer(malformado));
  assert.equal(parseSseBuffer(malformado).events.length, 0);
}
console.log("parseSseBuffer: OK");

// ---------- extractJsonStringFieldSoFar ----------
{
  assert.equal(extractJsonStringFieldSoFar('{"emo', "emotion"), null, "marcador do campo ainda não apareceu por completo -> null");

  const r1 = extractJsonStringFieldSoFar('{"emotion":"fel', "emotion");
  assert.deepEqual(r1, { value: "fel", complete: false }, "valor parcial, ainda sem aspas de fechamento");

  const r2 = extractJsonStringFieldSoFar('{"emotion":"feliz","reply":"Oi', "emotion");
  assert.deepEqual(r2, { value: "feliz", complete: true }, "valor completo quando a aspas de fechamento chega");

  assert.equal(extractJsonStringFieldSoFar('{"emotion":"feliz"', "reply"), null, "campo ainda não apareceu -> null");

  // escapes comuns
  const r3 = extractJsonStringFieldSoFar('{"reply":"Linha um\\nLinha dois"', "reply");
  assert.deepEqual(r3, { value: "Linha um\nLinha dois", complete: true });

  // \uXXXX completo
  const r4 = extractJsonStringFieldSoFar('{"reply":"caf\\u00e9"', "reply");
  assert.deepEqual(r4, { value: "café", complete: true });

  // \uXXXX CORTADO no meio (chegou só até "\\u00e") -- não quebra, só não inclui o
  // caractere ainda incompleto (vai completar no próximo pedaço do stream).
  const r5 = extractJsonStringFieldSoFar('{"reply":"caf\\u00e', "reply");
  assert.deepEqual(r5, { value: "caf", complete: false });

  // barra invertida sozinha no fim do buffer (ainda não sabemos o que ela escapa)
  const r6 = extractJsonStringFieldSoFar('{"reply":"ok\\', "reply");
  assert.deepEqual(r6, { value: "ok", complete: false });

  // chamadas incrementais simulando chunks chegando token a token convergem pro
  // mesmo valor final que uma extração de uma vez só.
  const full = '{"emotion":"feliz","reply":"Bom dia! Vai chover \\u00e0 tarde."}';
  let acc = "";
  let lastReply = "";
  for (const ch of full) {
    acc += ch;
    const rep = extractJsonStringFieldSoFar(acc, "reply");
    if (rep) lastReply = rep.value;
  }
  assert.equal(lastReply, "Bom dia! Vai chover à tarde.", "extração incremental char-a-char converge pro valor final certo");
}
console.log("extractJsonStringFieldSoFar: OK");

// ---------- efeitoRaciocinioPosFerramenta ----------
{
  assert.equal(efeitoRaciocinioPosFerramenta([]), "low", "nenhuma ferramenta usada -> esforço baixo");
  assert.equal(efeitoRaciocinioPosFerramenta(["consultar_agenda"]), "low", "ferramenta de leitura simples -> esforço baixo");
  assert.equal(efeitoRaciocinioPosFerramenta(["buscar_na_web"]), "medium", "ferramenta que precisa sintetizar texto longo -> esforço médio");
  assert.equal(efeitoRaciocinioPosFerramenta(["resumir_link"]), "medium");
  assert.equal(efeitoRaciocinioPosFerramenta(["consultar_email"]), "medium");
  assert.equal(efeitoRaciocinioPosFerramenta(["consultar_agenda", "buscar_na_web"]), "medium", "basta UMA ferramenta de síntese pra subir o esforço");
  assert.equal(efeitoRaciocinioPosFerramenta(null), "low", "nunca quebra com entrada inválida");
}
console.log("efeitoRaciocinioPosFerramenta: OK");

// ---------- streamFirstLlmCall: stream de conteúdo + fallback entre provedores ----------
function sseStreamFrom(dataLines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of dataLines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

{
  const originalFetch = globalThis.fetch;
  const env = { GROQ_API_KEY: "fake-groq", LLM_ORDER: "groq,openai" };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: sseStreamFrom([
      'data: {"choices":[{"delta":{"content":"Oi, "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"tudo bem?"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  try {
    let got = "";
    const result = await streamFirstLlmCall(env, [{ role: "user", content: "oi" }], 220, null, "low", (chunk) => { got += chunk; });
    assert.equal(got, "Oi, tudo bem?", "onContentDelta recebe os pedaços na ordem, concatenados = texto completo");
    assert.equal(result.providerUsed, "groq");
    assert.equal(result.first.choices[0].message.content, "Oi, tudo bem?");
    assert.equal(result.first.choices[0].message.tool_calls, undefined, "sem tool_calls no stream -> undefined (igual ao formato não-streaming)");
    assert.equal(typeof result.latencyMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("streamFirstLlmCall (conteúdo em stream): OK");

{
  // fallback: 1º provedor (groq) falha com 500 ANTES de mandar qualquer byte de
  // conteúdo -> cai pro 2º (openai) sem que o app tenha recebido nada do primeiro.
  const originalFetch = globalThis.fetch;
  const env = { GROQ_API_KEY: "fake-groq", OPENAI_API_KEY: "fake-openai", LLM_ORDER: "groq,openai" };
  let call = 0;
  globalThis.fetch = async (url) => {
    call++;
    if (String(url).includes("groq.com")) {
      return { ok: false, status: 500, text: async () => "erro interno" };
    }
    return {
      ok: true,
      status: 200,
      body: sseStreamFrom(['data: {"choices":[{"delta":{"content":"Resposta da reserva."}}]}\n\n', "data: [DONE]\n\n"]),
    };
  };
  try {
    let got = "";
    const result = await streamFirstLlmCall(env, [{ role: "user", content: "oi" }], 220, null, "low", (chunk) => { got += chunk; });
    assert.equal(result.providerUsed, "openai", "fallback aconteceu pro segundo provedor da cadeia");
    assert.equal(got, "Resposta da reserva.", "só o conteúdo do provedor que respondeu de verdade chega ao app");
    assert.ok(call >= 2, "tentou pelo menos os dois provedores");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("streamFirstLlmCall (fallback entre provedores antes de qualquer byte): OK");

{
  // tool_calls fragmentados em vários pedaços do stream, por índice -- precisa
  // reconstruir nome+arguments concatenando cada fragmento na ordem certa.
  const originalFetch = globalThis.fetch;
  const env = { GROQ_API_KEY: "fake-groq" };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: sseStreamFrom([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"consul","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"tar_agenda","arguments":"{\\"qu"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ando\\":\\"hoje\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  try {
    let gotContent = "";
    const result = await streamFirstLlmCall(env, [{ role: "user", content: "o que tenho hoje?" }], 220, [{ type: "function", function: { name: "consultar_agenda" } }], "low", (chunk) => { gotContent += chunk; });
    assert.equal(gotContent, "", "tool_calls não geram conteúdo falável nenhum");
    const tc = result.first.choices[0].message.tool_calls;
    assert.equal(tc.length, 1);
    assert.equal(tc[0].id, "call_1");
    assert.equal(tc[0].function.name, "consultar_agenda", "nome reconstruído a partir de fragmentos concatenados");
    assert.equal(tc[0].function.arguments, '{"quando":"hoje"}', "arguments reconstruído a partir de fragmentos concatenados");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("streamFirstLlmCall (tool_calls fragmentados por índice): OK");

{
  // sem nenhum provedor configurado -> erro claro, nunca trava
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("não deveria chamar fetch sem provedor"); };
  try {
    await assert.rejects(() => streamFirstLlmCall({}, [{ role: "user", content: "oi" }], 220, null, "low", () => {}), /llm_no_provider_configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("streamFirstLlmCall (sem provedor configurado): OK");

console.log("_voz4-streaming-latencia.test.mjs: todos os testes passaram");
