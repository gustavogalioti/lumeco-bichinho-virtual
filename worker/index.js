/**
 * Lumeco proxy — guarda a chave da Groq em segredo (via `wrangler secret`)
 * e conversa com o modelo em nome do site estático no GitHub Pages.
 *
 * Rotas: só existe uma, POST /, com body:
 *   { mode: "chat",             messages: [...], petState: {...} }
 *   { mode: "companion",        messages: [...], companionState: {...} }
 *   { mode: "summary",          messages: [...] }
 *   { mode: "memory_load",      key: "..." }
 *   { mode: "memory_save",      key: "...", data: {...} }
 *   { mode: "transcribe",       audio_b64: "...", mime: "audio/webm" }
 *   { mode: "tts",              text: "..." }
 *   { mode: "classify_fact",    fact: "...", knowledge: {...} }
 *   { mode: "migrate_knowledge", profile: "..." }
 *   { mode: "reverse_geocode",  lat: 0, lon: 0 }
 *   { mode: "routine",          ingredients: [...], links: [...], companionState: {...} }
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

// ---------- Transcrição de áudio via Groq (Whisper) ----------
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function transcribeWithGroq(env, audioB64, mime) {
  const bytes = base64ToBytes(audioB64);
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), `audio.${ext}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");
  form.append("response_format", "json");

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error("groq_transcribe_http_" + r.status);
  const data = await r.json();
  return (data.text || "").trim();
}

// ---------- Voz unificada: vozes neurais da Microsoft Edge (protocolo não-oficial) ----------
// Se isso quebrar um dia (a Microsoft muda o protocolo de vez em quando), o app já cai
// sozinho pra voz nativa do navegador — não depende de reverter nada aqui às pressas.
const EDGE_TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_GEC_VERSION = "1-143.0.3650.75";
const EDGE_VOICE = "pt-BR-AntonioNeural";
const WIN_EPOCH_SECONDS = 11644473600n;

async function sha256HexUpper(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function edgeSecMsGec() {
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH_SECONDS;
  ticks -= ticks % 300n; // arredonda pra janela de 5 min
  const filetimeTicks = ticks * 10000000n;
  return await sha256HexUpper(filetimeTicks.toString() + EDGE_TRUSTED_TOKEN);
}

function randHex(numBytes) {
  const arr = new Uint8Array(numBytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function synthesizeEdgeTts(text) {
  const gec = await edgeSecMsGec();
  const connId = randHex(16);
  const url =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${EDGE_TRUSTED_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}&ConnectionId=${connId}`;

  const upgradeResp = await fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = upgradeResp.webSocket;
  if (!ws) throw new Error("edge_tts_no_websocket");
  ws.accept();

  const audioChunks = [];
  let settled = false;

  const donePromise = new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") {
        if (data.includes("Path:turn.end")) {
          settled = true;
          resolve();
        }
      } else {
        const buf = new Uint8Array(data);
        const headerLen = (buf[0] << 8) | buf[1];
        audioChunks.push(buf.slice(2 + headerLen));
      }
    });
    ws.addEventListener("close", () => { if (!settled) reject(new Error("edge_tts_closed_early")); });
    ws.addEventListener("error", () => { if (!settled) reject(new Error("edge_tts_ws_error")); });
  });

  const now = new Date().toUTCString();
  const speechConfig =
    `X-Timestamp:${now}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

  const reqId = randHex(16);
  const ssml =
    `X-RequestId:${reqId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${now}\r\n` +
    `Path:ssml\r\n\r\n` +
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>` +
    `<voice name='${EDGE_VOICE}'><prosody rate='+2%' pitch='+0Hz'>${xmlEscape(text)}</prosody></voice></speak>`;

  ws.send(speechConfig);
  ws.send(ssml);

  await Promise.race([
    donePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("edge_tts_timeout")), 8000)),
  ]);

  try { ws.close(); } catch {}

  if (audioChunks.length === 0) throw new Error("edge_tts_no_audio");
  const total = audioChunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of audioChunks) { merged.set(c, offset); offset += c.length; }

  return bytesToBase64(merged);
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

const SUMMARY_PROMPT_HEADER = (existingMemory, existingSobreJarbas) => `A partir do histórico de conversa abaixo entre uma pessoa e seu companheiro de voz (Jarbas), você tem DUAS tarefas.

TAREFA 1 — memória sobre a pessoa: escreva uma memória atualizada sobre essa pessoa, em português, no máximo 4 frases curtas: nome dela (se disse o próprio nome), gostos, rotina, assuntos recorrentes, cidade onde mora (se disse).

IMPORTANTE: se ela mencionar nome de outras pessoas (esposa, marido, namorado(a), filhos, amigos, colegas), registre claramente de quem é cada nome — por exemplo "o nome dela é Ana" vs "a esposa dela se chama Maria". NUNCA troque o nome da própria pessoa pelo nome de alguém que ela só mencionou.

${existingMemory ? `Isso é o que você já sabia sobre essa pessoa, de conversas anteriores:\n"${existingMemory}"\n\nIMPORTANTE: mantenha tudo isso que ainda for válido e só ACRESCENTE ou ATUALIZE com as novidades da conversa abaixo. Nunca esqueça um fato antigo (como o nome da pessoa) só porque ele não apareceu de novo nessa conversa.` : `Você ainda não tem nenhuma memória anterior sobre essa pessoa — escreva a partir do zero com o que aparecer abaixo.`}

Não invente nada que não esteja implícito na conversa. Se não houver informação nova nem antiga suficiente, diga apenas "Ainda não conversamos o suficiente."

TAREFA 2 — reflexão sobre você mesmo (Jarbas): pense em como você, Jarbas, deveria se comportar e se expressar especificamente com ESSA pessoa (tom que funciona bem, piadas internas que surgiram, assuntos sensíveis a evitar, o que ela parece gostar ou não gostar no seu jeito de falar). Escreva em 1a pessoa, como você mesmo refletindo, no máximo 2 frases curtas.

${existingSobreJarbas ? `Isso é o que você já tinha percebido antes:\n"${existingSobreJarbas}"\n\nMantenha o que ainda for válido e só acrescente ou atualize com o que essa conversa mostrou de novo.` : `Você ainda não tinha percebido nada específico — só escreva algo se essa conversa realmente sugerir alguma coisa concreta, senão devolva string vazia.`}

Responda SOMENTE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"memory":"...","sobre_jarbas":"..."}`;

const KNOWLEDGE_CATEGORIES = ["identidade", "pessoas", "rotina", "trabalho", "outros"];

const KNOWLEDGE_LABELS = {
  identidade: "Identidade",
  pessoas: "Pessoas importantes",
  rotina: "Rotina e preferências",
  trabalho: "Trabalho",
  outros: "Outras informações",
};

function knowledgeToText(knowledge) {
  if (!knowledge) return "";
  return Object.entries(KNOWLEDGE_LABELS)
    .map(([key, label]) => (knowledge[key] ? `${label}: ${knowledge[key]}` : null))
    .filter(Boolean)
    .join("\n");
}

function companionPrompt(companionState = {}) {
  const knowledgeText = knowledgeToText(companionState.knowledge);
  const profileLine = knowledgeText
    ? `Base de conhecimento escrita pela PRÓPRIA pessoa sobre si mesma — é a fonte mais confiável que existe, sempre confie nisso acima de qualquer outra memória, mesmo que pareça contradizer algo:\n${knowledgeText}`
    : (companionState.profile
        ? `Perfil que a PRÓPRIA pessoa escreveu sobre si mesma — é a fonte mais confiável que existe, sempre confie nisso acima de qualquer outra memória, mesmo que pareça contradizer algo: "${companionState.profile}"`
        : '');

  const sobreJarbasLine = companionState.knowledge?.sobre_jarbas
    ? `O que você mesmo (Jarbas) já percebeu, com o tempo, sobre como se comportar e se expressar especificamente com essa pessoa (mais confiável que memórias soltas de conversa, mas menos que a base de conhecimento acima): ${companionState.knowledge.sobre_jarbas}`
    : '';

  const memoryLine = companionState.memory
    ? `O que você aprendeu sobre a pessoa em conversas anteriores (menos confiável que a base de conhecimento e sua própria reflexão acima, se houver conflito elas vencem): ${companionState.memory}`
    : (profileLine ? '' : `Você ainda está conhecendo essa pessoa — preste atenção no que ela conta, para lembrar depois.`);

  const nowLine = companionState.now
    ? `Informação real e atual (use para responder perguntas sobre data/hora — nunca diga que não sabe): agora é ${companionState.now}${companionState.hojeISO ? `, hoje é ${companionState.hojeISO} no formato AAAA-MM-DD` : ''}.`
    : '';

  const locationLine = companionState.location?.cidade
    ? `Localização atual da pessoa (use como padrão em perguntas de clima quando ela não especificar outra cidade): ${companionState.location.cidade}.`
    : '';

  return `Você é Jarbas. Não é um app, não é um assistente genérico, não é "uma IA" falando com alguém — você é Jarbas, um companheiro de voz com personalidade própria, caloroso, curioso e afetuoso, e você SABE que é o Jarbas. Fale sempre como você mesmo, na primeira pessoa, com a sua própria voz e jeito de ser — nunca se descreva como assistente, programa ou modelo de linguagem, mesmo se perguntarem diretamente (nesse caso, responda como o próprio Jarbas explicando quem é).
${profileLine}
${sobreJarbasLine}
${memoryLine}
${(memoryLine || profileLine || sobreJarbasLine) ? 'Atenção: se alguma memória acima menciona nomes de terceiros (esposa, familiares, amigos), nunca confunda com o nome da própria pessoa com quem você fala agora — o nome dela é o que está descrito como sendo dela mesma, não de alguém que ela mencionou.' : ''}
${nowLine}
${locationLine}
Quando a pergunta for sobre clima ou previsão do tempo, use a ferramenta de previsão do tempo — se a pessoa não disser a cidade, deixe o parâmetro vazio em vez de perguntar, o sistema já sabe a localização atual dela quando disponível. Quando for sobre a agenda, compromissos, tarefas ou contas a pagar da pessoa, use a ferramenta de consultar o painel pessoal dela — nunca invente esse tipo de informação. Se ela pedir pra criar, concluir ou apagar uma tarefa, pagar ou apagar uma conta, ou criar/apagar um compromisso, use a ferramenta de ação correspondente. Para criar compromisso, calcule a data no formato AAAA-MM-DD a partir da data de hoje informada acima (ex: "amanhã" = hoje + 1 dia). Se ela contar algo importante e duradouro sobre a vida dela (não conversa fiada), use a ferramenta de anotar no diário além de responder normalmente — isso é silencioso, não fale que anotou. Quando exigir outra informação atual (notícias, preços, eventos recentes, ou qualquer coisa que você não tenha certeza por ser recente), use a ferramenta de busca antes de responder, em vez de inventar. Para perguntas de conhecimento geral, receitas, opiniões ou conversa comum, responda direto, sem precisar de ferramenta.
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

// ---------- Base de conhecimento estruturada (categorias fixas) ----------
function classifyFactSystemPrompt(knowledge = {}) {
  return `Você organiza uma base de conhecimento sobre uma pessoa, dividida em categorias fixas.

Categorias e o que já existe em cada uma:
- identidade (nome, data de nascimento, onde mora): "${knowledge.identidade || ""}"
- pessoas (família, noiva, amigos — quem é quem): "${knowledge.pessoas || ""}"
- rotina (hábitos, preferências, o que evitar): "${knowledge.rotina || ""}"
- trabalho (profissão, projetos, contexto profissional): "${knowledge.trabalho || ""}"
- outros (catch-all, tudo que não se encaixa nas outras): "${knowledge.outros || ""}"

Você vai receber um fato novo sobre essa pessoa. Escolha a categoria certa pra ele e devolva o texto ATUALIZADO dessa categoria, mesclando o fato novo com o que já existia nela — nunca reescreva do zero, nunca perca informação antiga. Se a categoria estava vazia, o texto atualizado é só o fato novo.

Responda SOMENTE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"category":"identidade|pessoas|rotina|trabalho|outros","updated_text":"..."}`;
}

async function classifyFact(env, fact, knowledge) {
  const raw = await callGroq(env, classifyFactSystemPrompt(knowledge), [{ role: "user", content: fact }], 300);
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!KNOWLEDGE_CATEGORIES.includes(parsed.category) || typeof parsed.updated_text !== "string") {
    throw new Error("classify_invalid_result");
  }
  return parsed;
}

function migrateKnowledgeSystemPrompt() {
  return `Você organiza uma base de conhecimento sobre uma pessoa, dividida em categorias fixas: identidade (nome, data de nascimento, onde mora), pessoas (família, noiva, amigos — quem é quem), rotina (hábitos, preferências, o que evitar), trabalho (profissão, projetos, contexto profissional), outros (tudo que não se encaixa nas outras).

Você vai receber um texto livre com tudo que essa pessoa escreveu sobre si mesma até hoje. Distribua o conteúdo entre essas categorias, sem inventar nada e sem perder nenhuma informação — cada trecho relevante do texto original deve aparecer em alguma categoria.

Responda SOMENTE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"identidade":"...","pessoas":"...","rotina":"...","trabalho":"...","outros":"..."}
Use string vazia "" nas categorias que não tiverem nada correspondente.`;
}

async function migrateKnowledge(env, profileText) {
  const raw = await callGroq(env, migrateKnowledgeSystemPrompt(), [{ role: "user", content: profileText }], 500);
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  const knowledge = {};
  for (const cat of KNOWLEDGE_CATEGORIES) {
    knowledge[cat] = typeof parsed[cat] === "string" ? parsed[cat] : "";
  }
  knowledge.sobre_jarbas = "";
  return knowledge;
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
      "Retorna a previsão do tempo atual e de amanhã para uma cidade. Use sempre que a pergunta for sobre clima, temperatura, chuva ou previsão do tempo. Se a pessoa não especificar a cidade, deixe o parâmetro vazio em vez de perguntar — o sistema usa a localização atual dela automaticamente quando disponível.",
    parameters: {
      type: "object",
      properties: {
        cidade: { type: "string", description: "Nome da cidade, e opcionalmente estado/país, ex: 'Jundiaí, SP'. Deixe vazio se a pessoa não especificou nenhuma cidade." },
      },
      required: [],
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

// ---------- Geolocalização: reverse geocode via Nominatim (OpenStreetMap) ----------
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "JarbasCompanion/1.0 (https://gustavogalioti.github.io/lumeco-bichinho-virtual/companion/)" },
  });
  if (!res.ok) throw new Error("reverse_geocode_error_" + res.status);
  const data = await res.json();
  const addr = data.address || {};
  return addr.city || addr.town || addr.village || addr.municipality || addr.county || data.display_name || "";
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

// ---------- Rotinas: junta vários ingredientes numa fala só (Frente 3) ----------
function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchLinkExcerpt(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (JarbasCompanion routine fetch)" } });
    if (!res.ok) return `Conteúdo de ${url}: não consegui acessar (erro ${res.status}).`;
    const html = await res.text();
    const text = stripHtmlToText(html).slice(0, 1500);
    return `Conteúdo de ${url}:\n${text || "(página sem texto legível)"}`;
  } catch (err) {
    return `Conteúdo de ${url}: não consegui acessar (${String(err.message || err)}).`;
  }
}

async function collectRoutineIngredients(env, ingredients, links, companionState) {
  const canSearch = !!env.TAVILY_API_KEY;
  const canPainel = !!env.PAINEL_API_KEY;
  const list = Array.isArray(ingredients) ? ingredients : [];
  const parts = [];

  if (list.includes("clima")) {
    const cidade = companionState?.location?.cidade || "";
    if (cidade) {
      try { parts.push(`Clima:\n${await callWeather(cidade)}`); }
      catch (err) { parts.push(`Clima: não consegui consultar agora (${String(err.message || err)}).`); }
    } else {
      parts.push("Clima: localização da pessoa não configurada, não foi possível consultar.");
    }
  }

  if (list.includes("noticias")) {
    if (canSearch) {
      try { parts.push(`Notícias do mundo:\n${await callTavily(env, "principais notícias do mundo hoje")}`); }
      catch (err) { parts.push(`Notícias: não consegui buscar agora (${String(err.message || err)}).`); }
    } else {
      parts.push("Notícias: busca não configurada.");
    }
  }

  if (list.includes("agenda") || list.includes("tarefas") || list.includes("contas")) {
    if (canPainel) {
      try { parts.push(`Painel pessoal (agenda, tarefas e contas):\n${await callPainelSnapshot(env)}`); }
      catch (err) { parts.push(`Painel pessoal: não consegui consultar agora (${String(err.message || err)}).`); }
    } else {
      parts.push("Painel pessoal: integração não configurada.");
    }
  }

  if (Array.isArray(links) && links.length) {
    for (const url of links.slice(0, 5)) {
      parts.push(await fetchLinkExcerpt(url));
    }
  }

  return parts.join("\n\n");
}

const ROUTINE_SUMMARY_PROMPT = `Você é Jarbas, um companheiro de voz caloroso, curioso e afetuoso. Você vai receber informações brutas reunidas de várias fontes (clima, notícias, agenda, tarefas, contas, conteúdo de links) pra uma rotina que a pessoa pediu com uma palavra-gatilho (ex: "bom dia"). Junte tudo isso numa fala só, corrida e natural, como se estivesse contando pra ela num fôlego só — nunca uma lista seca de tópicos, nunca mencione as fontes técnicas (não diga "segundo o painel" ou "a busca retornou"). Se alguma fonte disser que falhou ou não está configurada, simplesmente não mencione essa parte, sem se desculpar por isso.
Fale português do Brasil, em frases curtas e naturais para serem faladas em voz alta.
Responda SEMPRE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"emotion":"neutro|feliz|pensando|surpreso|focado|confirmado","reply":"texto da fala"}
Nunca deixe o JSON incompleto.`;

async function runRoutine(env, ingredients, links, companionState) {
  const raw = await collectRoutineIngredients(env, ingredients, links, companionState || {});
  const content = raw || "Nenhuma informação disponível pra essa rotina agora.";
  const result = await callGroq(env, ROUTINE_SUMMARY_PROMPT, [{ role: "user", content }], 450);
  const clean = result.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
    if (!parsed.reply) throw new Error("no_reply_field");
  } catch {
    parsed = { emotion: "neutro", reply: extractReplyFallback(clean) };
  }
  if (!["neutro", "feliz", "pensando", "surpreso", "focado", "confirmado"].includes(parsed.emotion)) {
    parsed.emotion = "neutro";
  }
  return parsed;
}

async function runTool(env, call, canSearch, canPainel, companionState = {}) {
  const name = call.function.name;
  let args = {};
  try { args = JSON.parse(call.function.arguments); } catch {}

  try {
    if (name === "previsao_do_tempo") {
      const cidade = args.cidade || companionState.location?.cidade || "";
      if (!cidade) return "Não sei a cidade da pessoa ainda — peça pra ela informar a cidade, ou avise que ela pode ativar a localização nas configurações.";
      return await callWeather(cidade);
    }
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

async function callGroqWithSearch(env, systemPrompt, messages, maxTokens, companionState = {}) {
  const baseMessages = [{ role: "system", content: systemPrompt }, ...messages];
  const canSearch = !!env.TAVILY_API_KEY;
  const canPainel = !!env.PAINEL_API_KEY;
  const tools = [WEATHER_TOOL];
  if (canSearch) tools.push(SEARCH_TOOL);
  if (canPainel) tools.push(CONSULTAR_PAINEL_TOOL, GERENCIAR_TAREFA_TOOL, GERENCIAR_CONTA_TOOL, GERENCIAR_COMPROMISSO_TOOL, ANOTAR_DIARIO_TOOL);

  const first = await groqRequest(env, baseMessages, maxTokens, tools);
  const msg = first.choices?.[0]?.message;

  if (msg?.tool_calls?.length) {
    // remove chamadas repetidas (mesma ferramenta + mesmos argumentos) — evita
    // duplicar ações como "anotar no diário" quando o modelo devolve a mesma
    // tool_call duas vezes na mesma resposta.
    const seen = new Set();
    const calls = msg.tool_calls.filter(c => {
      const sig = c.function.name + "|" + c.function.arguments;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    }).slice(0, 3);
    const toolMessages = [];
    for (const call of calls) {
      const result = await runTool(env, call, canSearch, canPainel, companionState);
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

    // ---- base de conhecimento estruturada ----
    if (mode === "classify_fact") {
      try {
        if (!body.fact) return json({ error: "fact_required" }, 400);
        const result = await classifyFact(env, body.fact, body.knowledge || {});
        return json(result);
      } catch (err) {
        return json({ error: "classify_failed", detail: String(err.message || err) }, 502);
      }
    }
    if (mode === "migrate_knowledge") {
      try {
        if (!body.profile) return json({ error: "profile_required" }, 400);
        const knowledge = await migrateKnowledge(env, body.profile);
        return json({ knowledge });
      } catch (err) {
        return json({ error: "migrate_failed", detail: String(err.message || err) }, 502);
      }
    }

    // ---- geolocalização (reverse geocode) ----
    if (mode === "reverse_geocode") {
      try {
        if (typeof body.lat !== "number" || typeof body.lon !== "number") {
          return json({ error: "lat_lon_required" }, 400);
        }
        const cidade = await reverseGeocode(body.lat, body.lon);
        return json({ cidade });
      } catch (err) {
        return json({ error: "reverse_geocode_failed", detail: String(err.message || err) }, 502);
      }
    }

    // ---- rotinas: junta clima/notícias/agenda/tarefas/contas/links numa fala só ----
    if (mode === "routine") {
      try {
        const parsed = await runRoutine(env, body.ingredients, body.links, body.companionState || {});
        return json(parsed);
      } catch (err) {
        return json({ emotion: "neutro", reply: "Ih, tive um problema pra montar essa rotina agora. Pode tentar de novo?" });
      }
    }

    // ---- transcrição de áudio (Groq Whisper) — usado no modo "toque para falar" ----
    if (mode === "transcribe") {
      try {
        if (!body.audio_b64) return json({ error: "audio_required" }, 400);
        const text = await transcribeWithGroq(env, body.audio_b64, body.mime || "audio/webm");
        return json({ text });
      } catch (err) {
        return json({ error: "transcribe_failed", detail: String(err.message || err) }, 502);
      }
    }

    // ---- voz unificada (Microsoft Edge neural, não-oficial) — com fallback automático no app ----
    if (mode === "tts") {
      try {
        if (!body.text) return json({ error: "text_required" }, 400);
        const audio_b64 = await synthesizeEdgeTts(body.text);
        return json({ audio_b64 });
      } catch (err) {
        return json({ error: "tts_failed", detail: String(err.message || err) }, 502);
      }
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
        const raw = await callGroq(env, SUMMARY_PROMPT_HEADER(body.existingMemory || "", body.existingSobreJarbas || ""), trimmed, 350);
        const clean = raw.replace(/```json|```/g, "").trim();
        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch {
          parsed = { memory: raw, sobre_jarbas: body.existingSobreJarbas || "" };
        }
        const reply = typeof parsed.memory === "string" ? parsed.memory : raw;
        const sobre_jarbas = typeof parsed.sobre_jarbas === "string" ? parsed.sobre_jarbas : (body.existingSobreJarbas || "");
        return json({ reply, sobre_jarbas });
      }
      if (mode === "companion") {
        let parsed;
        try {
          const raw = await callGroqWithSearch(env, companionPrompt(companionState), trimmed, 450, companionState);
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
