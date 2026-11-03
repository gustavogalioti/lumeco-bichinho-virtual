// VOZ-4 PARTE C: cadeia de provedores de TTS (ordem configurável, escolha persistida
// vence a ordem padrão, fallback em cascata sem voltar pra voz do navegador a não ser
// que todos falhem) e o limitador de gasto diário por caracteres pros provedores pagos.
import assert from "node:assert/strict";
import worker, { buildTtsProviderChain, ttsDailyCapExceeded, synthesizeTtsWithProvider } from "./index.js";

// ---------- buildTtsProviderChain ----------
{
  const env = {}; // nenhuma chave -> só Edge (sempre disponível, gratuito)
  const chain = buildTtsProviderChain(env);
  assert.deepEqual(chain.map((p) => p.name), ["edge"], "sem nenhuma chave configurada, só Edge entra na cadeia");
}
{
  const env = { AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "r" };
  assert.deepEqual(buildTtsProviderChain(env).map((p) => p.name), ["azure", "edge"], "respeita a ordem padrão (elevenlabs,openai,azure,edge) pulando quem não tem chave");
}
{
  const env = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", OPENAI_API_KEY: "k2", AZURE_SPEECH_KEY: "k3", AZURE_SPEECH_REGION: "r" };
  assert.deepEqual(buildTtsProviderChain(env).map((p) => p.name), ["elevenlabs", "openai", "azure", "edge"], "ordem padrão completa quando tudo tem chave");
}
{
  const env = { TTS_PROVIDER_ORDER: "azure,elevenlabs", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", AZURE_SPEECH_KEY: "k3", AZURE_SPEECH_REGION: "r" };
  assert.deepEqual(buildTtsProviderChain(env).map((p) => p.name), ["azure", "elevenlabs", "edge"], "TTS_PROVIDER_ORDER troca a ordem; o que não foi citado (edge) entra no fim");
}
{
  // escolha persistida (vozPreferida) vence a ordem padrão, mas só se disponível
  const env = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", OPENAI_API_KEY: "k2" };
  assert.deepEqual(buildTtsProviderChain(env, { provedor: "openai" }).map((p) => p.name), ["openai", "elevenlabs", "edge"], "vozPreferida disponível vai pro topo da cadeia");
  assert.deepEqual(buildTtsProviderChain(env, { provedor: "azure" }).map((p) => p.name), ["elevenlabs", "openai", "edge"], "vozPreferida indisponível (sem chave) é ignorada, mantém a ordem padrão");
}
console.log("buildTtsProviderChain (ordem padrão, TTS_PROVIDER_ORDER, escolha persistida): OK");

// ---------- ttsDailyCapExceeded ----------
{
  const store = new Map();
  const env = {
    TTS_DAILY_CHARS_PAID: "100",
    COMPANION_KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); },
    },
  };
  assert.equal(await ttsDailyCapExceeded(env, "elevenlabs", 50, "2026-11-03"), false, "nada usado ainda -> nunca excede");
  store.set("tts:dailychars:elevenlabs:2026-11-03", "90");
  assert.equal(await ttsDailyCapExceeded(env, "elevenlabs", 5, "2026-11-03"), false, "90+5=95 <= 100 -> ainda não excede");
  assert.equal(await ttsDailyCapExceeded(env, "elevenlabs", 20, "2026-11-03"), true, "90+20=110 > 100 -> excede");
  assert.equal(await ttsDailyCapExceeded(env, "azure", 999999, "2026-11-03"), false, "Azure nunca é limitado por este teto (só os provedores pagos NOVOS)");
  assert.equal(await ttsDailyCapExceeded(env, "edge", 999999, "2026-11-03"), false, "Edge (gratuito) nunca é limitado");
  console.log("ttsDailyCapExceeded (teto diário só pros provedores pagos novos): OK");
}
{
  // padrão de 20.000 quando TTS_DAILY_CHARS_PAID não está configurado
  const env = { COMPANION_KV: { get: async () => "19999", put: async () => {} } };
  assert.equal(await ttsDailyCapExceeded(env, "openai", 1, "2026-11-03"), false, "19999+1=20000 <= 20000 (padrão) -> não excede");
  assert.equal(await ttsDailyCapExceeded(env, "openai", 2, "2026-11-03"), true, "19999+2=20001 > 20000 (padrão) -> excede");
  console.log("ttsDailyCapExceeded (padrão de 20.000 sem TTS_DAILY_CHARS_PAID configurado): OK");
}

// ---------- synthesizeTtsWithProvider: dispatcher + fallback em cascata no mode 'tts' ----------
{
  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    attempts.push(u);
    if (u.includes("elevenlabs.io")) return { ok: false, status: 429, text: async () => "rate limited" };
    if (u.includes("api.openai.com/v1/audio/speech")) return { ok: false, status: 402, text: async () => "quota exceeded" };
    if (u.includes("tts.speech.microsoft.com")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode("audio-azure").buffer };
    throw new Error("fetch inesperado: " + u);
  };
  try {
    const env = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", OPENAI_API_KEY: "k2", AZURE_SPEECH_KEY: "k3", AZURE_SPEECH_REGION: "r" };
    const ctx = { waitUntil: (p) => p };
    const req = { method: "POST", json: async () => ({ mode: "tts", text: "Oi, tudo bem com você hoje?" }) };
    const resp = await worker.fetch(req, env, ctx);
    const body = await resp.json();
    assert.equal(body.provider, "azure", "ElevenLabs (429) e OpenAI (402) falharam -- cai pro próximo (Azure), que respondeu");
    assert.ok(attempts.some((a) => a.includes("elevenlabs.io")), "tentou ElevenLabs primeiro (ordem padrão)");
    assert.ok(attempts.some((a) => a.includes("openai.com")), "depois tentou OpenAI");
    assert.ok(attempts.some((a) => a.includes("microsoft.com")), "e só então Azure, que deu certo");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode 'tts' (fallback em cascata: ElevenLabs 429 -> OpenAI 402 -> Azure OK): OK");

// ---------- mode 'tts': teto diário pula o provedor pago sem quebrar a cadeia ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("tts.speech.microsoft.com")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode("audio-azure").buffer };
    throw new Error("não deveria chamar ElevenLabs com o teto esgotado: " + u);
  };
  try {
    const store = new Map();
    store.set("tts:dailychars:elevenlabs:__hoje__", "19999999"); // bem acima de qualquer teto plausível
    const env = {
      ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", AZURE_SPEECH_KEY: "k3", AZURE_SPEECH_REGION: "r",
      TTS_DAILY_CHARS_PAID: "100",
      COMPANION_KV: {
        get: async (k) => { // simula "hoje" com qualquer data (o teste só confere que ElevenLabs nunca é chamado)
          if (k.startsWith("tts:dailychars:elevenlabs:")) return "19999999";
          return null;
        },
        put: async () => {},
      },
    };
    const ctx = { waitUntil: (p) => p };
    const req = { method: "POST", json: async () => ({ mode: "tts", text: "Oi" }) };
    const resp = await worker.fetch(req, env, ctx);
    const body = await resp.json();
    assert.equal(body.provider, "azure", "ElevenLabs pulado (teto esgotado) -- cadeia segue pro próximo, nunca quebra");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode 'tts' (teto diário esgotado pula o provedor pago, cadeia continua): OK");

// ---------- mode 'tts': todos falham -> erro (só então o APP decide usar a voz do navegador) ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "erro" });
  try {
    const env = { AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "r" }; // Edge também vai falhar (sem WebSocket real aqui)
    const ctx = { waitUntil: (p) => p };
    // texto único (nunca usado em outro teste deste arquivo) -- evita bater no cache em
    // memória do Azure, que faria essa chamada "funcionar" sem de fato testar a falha.
    const req = { method: "POST", json: async () => ({ mode: "tts", text: "Frase única só deste teste de falha total XYZ123" }) };
    const resp = await worker.fetch(req, env, ctx);
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error, "tts_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode 'tts' (todos os provedores falham -> erro claro, nunca trava): OK");

// ---------- mode 'tts_sample': chama direto um provedor específico, sem cadeia/teto ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("elevenlabs.io")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode("voz-elevenlabs").buffer };
    throw new Error("fetch inesperado: " + u);
  };
  try {
    const env = { SYNC_KEY: "segredo", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" };
    const ctx = { waitUntil: (p) => p };
    const req = { method: "POST", json: async () => ({ mode: "tts_sample", key: "segredo", provider: "elevenlabs" }) };
    const resp = await worker.fetch(req, env, ctx);
    const body = await resp.json();
    assert.equal(body.provider, "elevenlabs");
    assert.ok(body.audio_b64);

    // provedor sem chave -> erro claro, nunca tenta outro da cadeia (é um teste direto)
    const req2 = { method: "POST", json: async () => ({ mode: "tts_sample", key: "segredo", provider: "openai" }) };
    const resp2 = await worker.fetch(req2, env, ctx);
    assert.equal(resp2.status, 400);

    // sem a chave certa -> nunca executa nada
    const req3 = { method: "POST", json: async () => ({ mode: "tts_sample", key: "errada", provider: "elevenlabs" }) };
    const resp3 = await worker.fetch(req3, env, ctx);
    assert.equal(resp3.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log("mode 'tts_sample' (laboratório de voz: um provedor específico, autenticado): OK");

// ---------- mode 'tts_providers_disponiveis' ----------
{
  const env = { SYNC_KEY: "segredo", AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "r", TTS_PROVIDER_ORDER: "openai,azure,elevenlabs,edge" };
  const ctx = { waitUntil: (p) => p };
  const req = { method: "POST", json: async () => ({ mode: "tts_providers_disponiveis", key: "segredo" }) };
  const resp = await worker.fetch(req, env, ctx);
  const body = await resp.json();
  assert.deepEqual(body.disponiveis.sort(), ["azure", "edge"], "só lista quem tem chave de verdade (edge é sempre disponível)");
  assert.deepEqual(body.ordemPadrao, ["openai", "azure", "elevenlabs", "edge"]);
  console.log("mode 'tts_providers_disponiveis' (só lista quem está configurado): OK");
}

console.log("_voz4-voz-unificada.test.mjs: todos os testes passaram");
