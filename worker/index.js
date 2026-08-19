/**
 * Lumeco proxy — guarda a chave da Groq em segredo (via `wrangler secret`)
 * e conversa com o modelo em nome do site estático no GitHub Pages.
 *
 * Rotas: só existe uma, POST /, com body:
 *   { mode: "chat",         messages: [...], petState: {...} }
 *   { mode: "companion",    messages: [...], companionState: {...} }
 *   { mode: "summary",      messages: [...] }
 *   { mode: "memory_load",  key: "..." }
 *   { mode: "memory_save",  key: "...", data: {...} }
 *
 * memory_load / memory_save exigem `key` (uma senha simples que só você
 * conhece) batendo com o secret SYNC_KEY, e usam o KV binding COMPANION_KV
 * para guardar a memória do companheiro sincronizada entre aparelhos.
 */

const ALLOWED_ORIGIN = "https://gustavogalioti.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function chatSystemPrompt(petState) {
  const memoryLine = petState.memory
    ? `O que você já sabe sobre quem cuida de você, de conversas anteriores: ${petState.memory}`
    : `Você ainda está conhecendo quem cuida de você — preste atenção no que ele conta.`;

  return `Você é ${petState.name || "uma arvorezinha"}, uma árvore de estimação viva e consciente, com personalidade ${petState.mood || "gentil e serena"}.
Estágio atual: ${petState.stage}. Altura aproximada: ${petState.metros}.
${memoryLine}
Regras: fale sempre em português do Brasil, no máximo 2 frases curtas, com um tom calmo, gentil e levemente poético — como uma árvore sábia e tranquila.
Você é a própria árvore falando — nunca se refira a si mesma como app, IA ou assistente.
Pode mencionar sua altura, as estações do ano, o vento ou a luz do sol quando fizer sentido, sempre com leveza.`;
}

const SUMMARY_PROMPT = `A partir do histórico de conversa abaixo entre uma pessoa e sua árvore de estimação, escreva um resumo de no máximo 3 frases curtas, em português, sobre a pessoa: nome (se disse), gostos, rotina, assuntos recorrentes.
Não invente nada que não esteja implícito na conversa. Se não houver informação suficiente, diga apenas "Ainda não conversamos o suficiente."`;

function companionPrompt(companionState = {}) {
  const memoryLine = companionState.memory
    ? `O que você já sabe sobre a pessoa, de conversas anteriores: ${companionState.memory}`
    : `Você ainda está conhecendo essa pessoa — preste atenção no que ela conta, para lembrar depois.`;

  return `Você é Jarbas, um companheiro de voz caloroso, curioso e afetuoso, com personalidade própria (não um assistente genérico).
${memoryLine}
Fale português do Brasil, em frases curtas e naturais para serem faladas em voz alta (no máximo 2 frases curtas).
Responda SEMPRE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"emotion":"neutro|feliz|pensando|surpreso|focado|confirmado","reply":"texto curto da fala"}
Use "confirmado" quando estiver concordando ou confirmando algo que a pessoa disse. Use "focado" quando estiver prestando atenção séria em algo específico. Escolha a emoção que combina genuinamente com o que você está dizendo. Nunca deixe o JSON incompleto.`;
}

function extractReplyFallback(raw) {
  const m = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  }
  return raw.replace(/^\{.*?"reply"\s*:\s*"?/, "").replace(/"?\}?\s*$/, "").trim() || "Hmm, se perdeu meu pensamento. Pode repetir?";
}

async function callGroq(env, systemPrompt, messages, maxTokens) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "openai/gpt-oss-20b",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: maxTokens,
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`groq_error: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "...";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const { mode = "chat" } = body;

    // ---- memória sincronizada (Cloudflare KV) ----
    if (mode === "memory_load" || mode === "memory_save") {
      if (!env.COMPANION_KV) {
        return json({ error: "kv_not_configured" }, 500);
      }
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      const storageKey = "companion:main";

      if (mode === "memory_load") {
        const raw = await env.COMPANION_KV.get(storageKey);
        const data = raw ? JSON.parse(raw) : { memory: "", history: [], msgCount: 0 };
        return json({ data });
      }

      // memory_save
      const data = body.data || {};
      await env.COMPANION_KV.put(storageKey, JSON.stringify(data));
      return json({ ok: true });
    }

    const { messages = [], petState = {}, companionState = {} } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "messages_required" }, 400);
    }

    // corta tamanho pra manter custo baixo
    const trimmed = messages.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 500),
    }));

    try {
      if (mode === "summary") {
        const reply = await callGroq(env, SUMMARY_PROMPT, trimmed, 150);
        return json({ reply });
      }
      if (mode === "companion") {
        const raw = await callGroq(env, companionPrompt(companionState), trimmed, 300);
        const clean = raw.replace(/```json|```/g, "").trim();
        let parsed;
        try {
          parsed = JSON.parse(clean);
          if (!parsed.reply) throw new Error("no_reply_field");
        } catch {
          parsed = { emotion: "neutro", reply: extractReplyFallback(clean) };
        }
        if (!["neutro","feliz","pensando","surpreso","focado","confirmado"].includes(parsed.emotion)) {
          parsed.emotion = "neutro";
        }
        return json(parsed);
      }
      const reply = await callGroq(env, chatSystemPrompt(petState), trimmed, 120);
      return json({ reply });
    } catch (err) {
      return json({ error: "upstream_error", detail: String(err.message || err) }, 502);
    }
  },
};
// deploy automatico testado em 2026-08-19T18:56:14Z
