/**
 * Lumeco proxy — guarda a chave da Groq em segredo (via `wrangler secret`)
 * e conversa com o modelo em nome do site estático no GitHub Pages.
 *
 * Rotas: só existe uma, POST /, com body:
 *   { mode: "chat",    messages: [...], petState: {...} }
 *   { mode: "summary", messages: [...] }
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
    ? `O que você já sabe sobre seu dono, de conversas anteriores: ${petState.memory}`
    : `Você ainda está conhecendo seu dono — preste atenção no que ele conta.`;

  return `Você é ${petState.name || "Lumeco"}, um bichinho virtual bioluminescente de estimação.
Estágio atual: ${petState.stage}. Dia de vida: ${petState.day}.
Status atuais (0 a 100) — fome: ${petState.fome}, sono: ${petState.sono}, higiene: ${petState.higiene}, brilho: ${petState.brilho}.
${memoryLine}
Regras: fale sempre em português do Brasil, no máximo 2 frases curtas, de forma fofa, calorosa e levemente infantil.
Você é o próprio bichinho falando — nunca se refira a si mesmo como app, IA ou assistente.
Pode reagir aos seus próprios status quando fizer sentido (ex: se a fome estiver baixa, mencionar que está com fome).`;
}

const SUMMARY_PROMPT = `A partir do histórico de conversa abaixo entre uma pessoa e seu bichinho virtual de estimação, escreva um resumo de no máximo 3 frases curtas, em português, sobre a pessoa: nome (se disse), gostos, rotina, assuntos recorrentes.
Não invente nada que não esteja implícito na conversa. Se não houver informação suficiente, diga apenas "Ainda não conversamos o suficiente."`;

async function callGroq(env, systemPrompt, messages, maxTokens) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.GROQ_MODEL || "llama-3.1-8b-instant",
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

    const { mode = "chat", messages = [], petState = {} } = body;

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
      const reply = await callGroq(env, chatSystemPrompt(petState), trimmed, 120);
      return json({ reply });
    } catch (err) {
      return json({ error: "upstream_error", detail: String(err.message || err) }, 502);
    }
  },
};
