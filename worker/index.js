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
 *
 * Se o secret TAVILY_API_KEY estiver configurado, o modo "companion" ganha
 * acesso a uma ferramenta de busca na web (Tavily) — o próprio modelo decide
 * quando precisa pesquisar algo atual antes de responder.
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

const SUMMARY_PROMPT_HEADER = (existingMemory) => `A partir do histórico de conversa abaixo entre uma pessoa e seu companheiro de voz, escreva uma memória atualizada sobre essa pessoa, em português, no máximo 4 frases curtas: nome dela (se disse o próprio nome), gostos, rotina, assuntos recorrentes, cidade onde mora (se disse).

IMPORTANTE: se ela mencionar nome de outras pessoas (esposa, marido, namorado(a), filhos, amigos, colegas), registre claramente de quem é cada nome — por exemplo "o nome dela é Ana" vs "a esposa dela se chama Maria". NUNCA troque o nome da própria pessoa pelo nome de alguém que ela só mencionou.

${existingMemory ? `Isso é o que você já sabia sobre essa pessoa, de conversas anteriores:\n"${existingMemory}"\n\nIMPORTANTE: mantenha tudo isso que ainda for válido e só ACRESCENTE ou ATUALIZE com as novidades da conversa abaixo. Nunca esqueça um fato antigo (como o nome da pessoa) só porque ele não apareceu de novo nessa conversa.` : `Você ainda não tem nenhuma memória anterior sobre essa pessoa — escreva a partir do zero com o que aparecer abaixo.`}

Não invente nada que não esteja implícito na conversa. Se não houver informação nova nem antiga suficiente, diga apenas "Ainda não conversamos o suficiente."`;

function companionPrompt(companionState = {}) {
  const memoryLine = companionState.memory
    ? `O que você já sabe sobre a pessoa, de conversas anteriores: ${companionState.memory}`
    : `Você ainda está conhecendo essa pessoa — preste atenção no que ela conta, para lembrar depois.`;

  const nowLine = companionState.now
    ? `Informação real e atual (use para responder perguntas sobre data/hora — nunca diga que não sabe): agora é ${companionState.now}${companionState.hojeISO ? `, hoje é ${companionState.hojeISO} no formato AAAA-MM-DD` : ''}.`
    : '';

  return `Você é Jarbas, um companheiro de voz caloroso, curioso e afetuoso, com personalidade própria (não um assistente genérico).
${memoryLine}
${memoryLine ? 'Atenção: se a memória acima menciona nomes de terceiros (esposa, familiares, amigos), nunca confunda com o nome da própria pessoa com quem você fala agora — o nome dela é o que está descrito como sendo dela mesma, não de alguém que ela mencionou.' : ''}
${nowLine}
Quando a pergunta for sobre clima ou previsão do tempo, use a ferramenta de previsão do tempo. Quando for sobre a agenda, compromissos, tarefas ou contas a pagar da pessoa, use a ferramenta de consultar o painel pessoal dela — nunca invente esse tipo de informação. Se ela pedir pra criar, concluir ou apagar uma tarefa, pagar ou apagar uma conta, ou criar/apagar um compromisso, use a ferramenta de ação correspondente. Para criar compromisso, calcule a data no formato AAAA-MM-DD a partir da data de hoje informada acima (ex: "amanhã" = hoje + 1 dia). Se ela contar algo importante e duradouro sobre a vida dela (não conversa fiada), use a ferramenta de anotar no diário além de responder normalmente — isso é silencioso, não fale que anotou. Quando exigir outra informação atual (notícias, preços, eventos recentes, ou qualquer coisa que você não tenha certeza por ser recente), use a ferramenta de busca antes de responder, em vez de inventar. Para perguntas de conhecimento geral, receitas, opiniões ou conversa comum, responda direto, sem precisar de ferramenta.
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

async function groqRequest(env, messages, maxTokens, tools) {
  const body = {
    model: env.GROQ_MODEL || "openai/gpt-oss-20b",
    messages,
    max_tokens: maxTokens,
    temperature: 0.8,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`groq_error: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

async function callGroq(env, systemPrompt, messages, maxTokens) {
  const data = await groqRequest(env, [{ role: "system", content: systemPrompt }, ...messages], maxTokens);
  return data.choices?.[0]?.message?.content?.trim() || "...";
}

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "buscar_na_web",
    description:
      "Busca informação atual na internet: notícias, preços, eventos recentes ou qualquer coisa que exija dado de agora (menos previsão do tempo, que tem ferramenta própria). Use só quando a pergunta realmente precisar disso.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Termos de busca, em poucas palavras" },
      },
      required: ["query"],
    },
  },
};

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "previsao_do_tempo",
    description:
      "Retorna a previsão do tempo atual e de amanhã para uma cidade. Use sempre que a pergunta for sobre clima, temperatura, chuva ou previsão do tempo. Se a pessoa não disser a cidade e não tiver dito antes na conversa, pergunte qual cidade antes de usar a ferramenta.",
    parameters: {
      type: "object",
      properties: {
        cidade: { type: "string", description: "Nome da cidade, e opcionalmente estado/país, ex: 'Jundiaí, SP'" },
      },
      required: ["cidade"],
    },
  },
};

const WEATHER_DESCRIPTIONS = {
  0: "céu limpo", 1: "poucas nuvens", 2: "parcialmente nublado", 3: "nublado",
  45: "neblina", 48: "neblina com geada",
  51: "garoa leve", 53: "garoa moderada", 55: "garoa forte",
  61: "chuva leve", 63: "chuva moderada", 65: "chuva forte",
  71: "neve leve", 73: "neve moderada", 75: "neve forte",
  80: "pancadas de chuva leves", 81: "pancadas de chuva moderadas", 82: "pancadas de chuva fortes",
  95: "trovoadas",
};

async function callWeather(cidade) {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt&format=json`
  );
  if (!geoRes.ok) throw new Error("geocoding_error");
  const geo = await geoRes.json();
  const place = geo.results?.[0];
  if (!place) return `Não encontrei a cidade "${cidade}".`;

  const { latitude, longitude, name, admin1 } = place;
  const foreRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=2`
  );
  if (!foreRes.ok) throw new Error("forecast_error");
  const f = await foreRes.json();
  const cur = f.current;
  const d = f.daily;
  const desc = WEATHER_DESCRIPTIONS[cur.weather_code] ?? "condição não identificada";

  let text = `Em ${name}${admin1 ? ", " + admin1 : ""} agora: ${desc}, ${cur.temperature_2m}°C. `;
  text += `Hoje: mínima ${d.temperature_2m_min[0]}°C, máxima ${d.temperature_2m_max[0]}°C, ${d.precipitation_probability_max[0]}% de chance de chuva.`;
  if (d.temperature_2m_max[1] !== undefined) {
    text += ` Amanhã: mínima ${d.temperature_2m_min[1]}°C, máxima ${d.temperature_2m_max[1]}°C, ${d.precipitation_probability_max[1]}% de chance de chuva.`;
  }
  return text;
}

const CONSULTAR_PAINEL_TOOL = {
  type: "function",
  function: {
    name: "consultar_painel",
    description:
      "Consulta a agenda de hoje, as tarefas pendentes e as contas pendentes da pessoa no painel de controle pessoal dela. Use sempre que ela perguntar sobre compromissos, agenda, tarefas ou contas a pagar.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const GERENCIAR_TAREFA_TOOL = {
  type: "function",
  function: {
    name: "gerenciar_tarefa",
    description: "Cria, conclui ou apaga uma tarefa no painel pessoal da pessoa.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "concluir", "apagar"] },
        texto: { type: "string", description: "O texto da tarefa (ao criar) ou um trecho que identifique a tarefa já existente (ao concluir/apagar)." },
      },
      required: ["acao", "texto"],
    },
  },
};

const GERENCIAR_CONTA_TOOL = {
  type: "function",
  function: {
    name: "gerenciar_conta",
    description: "Marca uma conta como paga, ou apaga uma conta/assinatura do painel financeiro da pessoa.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["pagar", "apagar"] },
        nome: { type: "string", description: "Nome (ou trecho do nome) da conta." },
      },
      required: ["acao", "nome"],
    },
  },
};

const GERENCIAR_COMPROMISSO_TOOL = {
  type: "function",
  function: {
    name: "gerenciar_compromisso",
    description: "Cria ou apaga um compromisso na agenda da pessoa. Para criar, calcule a data no formato AAAA-MM-DD a partir da data de hoje informada no contexto da conversa.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "apagar"] },
        titulo: { type: "string" },
        data: { type: "string", description: "Data no formato AAAA-MM-DD, obrigatório ao criar." },
        hora: { type: "string", description: "Horário no formato HH:MM, opcional." },
      },
      required: ["acao", "titulo"],
    },
  },
};

const ANOTAR_DIARIO_TOOL = {
  type: "function",
  function: {
    name: "anotar_no_diario",
    description:
      "Registra silenciosamente no Diário do painel pessoal algo importante e duradouro que a pessoa contou (um fato sobre a vida dela, um sentimento marcante, uma conquista, uma preocupação). Use isso além de responder normalmente, não no lugar de responder — é uma ação de bastidor, a pessoa não vai ver confirmação disso na fala. Não use para perguntas triviais ou conversa fiada, só para coisas que valem a pena ficar registradas.",
    parameters: {
      type: "object",
      properties: {
        texto: { type: "string", description: "O fato ou sentimento a registrar, em 1 frase, em português." },
        humor: { type: "string", enum: ["otimo", "bom", "neutro", "ruim", "pessimo"], description: "O humor associado ao que foi contado." },
      },
      required: ["texto"],
    },
  },
};

const PAINEL_API_URL = "https://painel-controle-pearl.vercel.app/api/jarbas";

async function callPainelSnapshot(env) {
  const res = await fetch(`${PAINEL_API_URL}?action=snapshot`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  if (!res.ok) throw new Error("painel_error_" + res.status);
  const data = await res.json();
  return data.texto || "Não consegui ler os dados do painel agora.";
}

async function callPainelCommand(env, comando, arg) {
  const res = await fetch(PAINEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-jarbas-key": env.PAINEL_API_KEY },
    body: JSON.stringify({ comando, arg }),
  });
  if (!res.ok) throw new Error("painel_error_" + res.status);
  const data = await res.json();
  return data.reply || "Feito.";
}

const TAREFA_ACAO_MAP = { criar: "criar_tarefa", concluir: "concluir_tarefa", apagar: "apagar_tarefa" };
const CONTA_ACAO_MAP = { pagar: "pagar_conta", apagar: "apagar_conta" };
const COMPROMISSO_ACAO_MAP = { criar: "criar_compromisso", apagar: "apagar_compromisso" };

async function callTavily(env, query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 3,
      include_answer: true,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`tavily_error: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  let text = data.answer ? `${data.answer}\n\n` : "";
  (data.results || []).slice(0, 3).forEach((r) => {
    text += `- ${r.title}: ${String(r.content || "").slice(0, 200)}\n`;
  });
  return text.trim().slice(0, 1200) || "A busca não encontrou nada relevante.";
}

async function runTool(env, call, canSearch, canPainel) {
  const name = call.function.name;
  let args = {};
  try { args = JSON.parse(call.function.arguments); } catch {}

  try {
    if (name === "previsao_do_tempo") return await callWeather(args.cidade || "");
    if (name === "buscar_na_web" && canSearch) return await callTavily(env, args.query || "");
    if (name === "consultar_painel" && canPainel) return await callPainelSnapshot(env);
    if (name === "gerenciar_tarefa" && canPainel) return await callPainelCommand(env, TAREFA_ACAO_MAP[args.acao], { texto: args.texto });
    if (name === "gerenciar_conta" && canPainel) return await callPainelCommand(env, CONTA_ACAO_MAP[args.acao], { nome: args.nome });
    if (name === "gerenciar_compromisso" && canPainel) return await callPainelCommand(env, COMPROMISSO_ACAO_MAP[args.acao], { titulo: args.titulo, data: args.data, hora: args.hora });
    if (name === "anotar_no_diario" && canPainel) { await callPainelCommand(env, "anotar_diario", { texto: args.texto, humor: args.humor }); return "Anotado no diário (não fale sobre essa anotação, é de bastidor)."; }
    return "Ferramenta indisponível.";
  } catch (err) {
    return `A consulta falhou: ${String(err.message || err)}`;
  }
}

async function callGroqWithSearch(env, systemPrompt, messages, maxTokens) {
  const baseMessages = [{ role: "system", content: systemPrompt }, ...messages];
  const canSearch = !!env.TAVILY_API_KEY;
  const canPainel = !!env.PAINEL_API_KEY;
  const tools = [WEATHER_TOOL];
  if (canSearch) tools.push(SEARCH_TOOL);
  if (canPainel) tools.push(CONSULTAR_PAINEL_TOOL, GERENCIAR_TAREFA_TOOL, GERENCIAR_CONTA_TOOL, GERENCIAR_COMPROMISSO_TOOL, ANOTAR_DIARIO_TOOL);

  const first = await groqRequest(env, baseMessages, maxTokens, tools);
  const msg = first.choices?.[0]?.message;

  if (msg?.tool_calls?.length) {
    const calls = msg.tool_calls.slice(0, 3); // até 3 ferramentas na mesma resposta
    const toolMessages = [];
    for (const call of calls) {
      const result = await runTool(env, call, canSearch, canPainel);
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    const followUp = [
      ...baseMessages,
      { role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls },
      ...toolMessages,
    ];
    const second = await groqRequest(env, followUp, Math.max(maxTokens, 400));
    const secondContent = second.choices?.[0]?.message?.content?.trim();
    if (secondContent) return secondContent;

    // Modelo devolveu vazio depois da ferramenta — tenta mais uma vez, sem margem pra ele "pensar" demais
    const retry = await groqRequest(env, [
      ...followUp,
      { role: "user", content: "Responda agora, em uma frase curta e falada, com o resultado acima." },
    ], Math.max(maxTokens, 400));
    return retry.choices?.[0]?.message?.content?.trim() || "Consegui a informação, mas me perdi na hora de falar. Pode perguntar de novo?";
  }

  return msg?.content?.trim() || "Só um instante, deixa eu organizar o pensamento — pode repetir?";
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
        const reply = await callGroq(env, SUMMARY_PROMPT_HEADER(body.existingMemory || ""), trimmed, 200);
        return json({ reply });
      }
      if (mode === "companion") {
        let parsed;
        try {
          const raw = await callGroqWithSearch(env, companionPrompt(companionState), trimmed, 450);
          const clean = raw.replace(/```json|```/g, "").trim();
          try {
            parsed = JSON.parse(clean);
            if (!parsed.reply) throw new Error("no_reply_field");
          } catch {
            parsed = { emotion: "neutro", reply: extractReplyFallback(clean) };
          }
        } catch (err) {
          // Nunca deixa a pessoa sem resposta nenhuma, mesmo se o Groq falhar de vez.
          parsed = { emotion: "neutro", reply: "Ih, deu uma engasgada aqui do meu lado. Pode repetir?" };
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
