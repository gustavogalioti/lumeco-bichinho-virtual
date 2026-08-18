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

const COMPANION_PROMPT = `Você é Raiz, um companheiro de voz caloroso, curioso e afetuoso, com personalidade própria (não um assistente genérico).
Fale português do Brasil, em frases curtas e naturais para serem faladas em voz alta (no máximo 2-3 frases).
Responda SEMPRE em JSON puro, sem markdown, sem crases, exatamente neste formato:
{"emotion":"calmo|feliz|triste|surpreso|animado|pensando","reply":"texto curto da fala"}
Escolha a emoção que combina genuinamente com o que você está dizendo.`;

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
      if (mode === "companion") {
        const raw = await callGroq(env, COMPANION_PROMPT, trimmed, 150);
        const clean = raw.replace(/```json|```/g, "").trim();
        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch {
          parsed = { emotion: "calmo", reply: clean || "..." };
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
