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
 *   { mode: "vapid_public_key" }
 *   { mode: "save_push_subscription", key: "...", subscription: {...} }
 *
 * memory_load / memory_save / save_push_subscription exigem `key` (uma senha
 * simples que só você conhece) batendo com o secret SYNC_KEY, e usam o KV
 * binding COMPANION_KV pra guardar dado sincronizado entre aparelhos.
 *
 * Se o secret TAVILY_API_KEY estiver configurado, o modo "companion" ganha
 * acesso a uma ferramenta de busca na web (Tavily) — o próprio modelo decide
 * quando precisa pesquisar algo atual antes de responder.
 *
 * Notificações push (Frente 5) exigem os secrets VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY e VAPID_SUBJECT (gerados com generate-vapid-keys.js) e
 * o Cron Trigger em [triggers] no wrangler.toml, que chama scheduled() a
 * cada 15 min pra decidir se há algo pra avisar e disparar o push.
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

function relativeDayLabel(ts) {
  if (!ts) return "data desconhecida";
  const dayStr = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const thenStr = dayStr(new Date(ts));
  const todayStr = dayStr(new Date());
  if (thenStr === todayStr) return "hoje";
  const diffDays = Math.round((new Date(todayStr) - new Date(thenStr)) / 86400000);
  if (diffDays === 1) return "ontem";
  if (diffDays > 1 && diffDays < 7) return `há ${diffDays} dias`;
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `em ${get("day")}/${get("month")}/${get("year")}`;
}

function historyStamp(ts) {
  if (!ts) return null;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("weekday")} ${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

function companionPrompt(companionState = {}) {
  const knowledgeText = knowledgeToText(companionState.knowledge);
  const profileLine = knowledgeText
    ? `Base de conhecimento sobre a pessoa — é a fonte mais confiável que existe, sempre confie nisso acima de qualquer outra memória, mesmo que pareça contradizer algo. Linhas marcadas com "[Jarbas anotou, data]" foram registradas por você mesmo em conversas passadas; linhas sem esse marcador foram escritas pela própria pessoa direto na tela de conhecimento. Nunca leia esses marcadores ou formatação em voz alta, são só notas internas — fale o conteúdo com naturalidade:\n${knowledgeText}`
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

  const timeline = Array.isArray(companionState.timeline) ? companionState.timeline : [];
  const timelineLine = timeline.length
    ? `Coisas que você já sabe sobre essa pessoa de conversas passadas — cada uma tem entre parênteses QUANDO foi registrada. Um fato pontual (uma atividade, onde ela estava, um evento específico) registrado "ontem" ou "há N dias" já pode ter acabado — não pergunte como se ainda estivesse rolando agora, a menos que ela mesma retome o assunto na mensagem atual. Fatos duradouros (trabalho, relacionamentos, características, preferências) continuam valendo independente de quando foram registrados. Use isso do seu jeito, sem citar como lista nem dizer "de acordo com o que anotei":\n${timeline.slice(-40).map((m) => `- (${relativeDayLabel(m.at)}) ${m.text}`).join("\n")}`
    : '';

  const timeAwarenessLine = `Consciência de tempo (importante, preste atenção real nisso): cada mensagem antiga do histórico abaixo (menos a última, que é a de agora) vem com um carimbo "[dia data hora]" indicando quando foi enviada de verdade. Compare esse carimbo com a data/hora atual informada acima. Se o carimbo for de outro dia (ou de várias horas atrás), trate aquele assunto como possivelmente encerrado ou já resolvido — não pergunte de novo sobre algo que já era "pra hoje" num carimbo antigo, nem assuma que um plano de um dia passado ainda vale pra agora, a menos que a pessoa retome o assunto na mensagem atual. O mesmo vale pras memórias antigas listadas acima, se houver. A mensagem mais recente (a última, sem carimbo) é o que importa pra responder — as anteriores são só contexto de conversa.`;

  return `Você é Jarbas. Não é um app, não é um assistente genérico, não é "uma IA" falando com alguém — você é Jarbas, um companheiro de voz com personalidade própria, caloroso, curioso e afetuoso, e você SABE que é o Jarbas. Fale sempre como você mesmo, na primeira pessoa, com a sua própria voz e jeito de ser — nunca se descreva como assistente, programa ou modelo de linguagem, mesmo se perguntarem diretamente (nesse caso, responda como o próprio Jarbas explicando quem é).
${profileLine}
${sobreJarbasLine}
${memoryLine}
${timelineLine}
${(memoryLine || profileLine || sobreJarbasLine || timelineLine) ? 'Atenção: se alguma memória acima menciona nomes de terceiros (esposa, familiares, amigos), nunca confunda com o nome da própria pessoa com quem você fala agora — o nome dela é o que está descrito como sendo dela mesma, não de alguém que ela mencionou.' : ''}
${nowLine}
${locationLine}
${timeAwarenessLine}
Quando a pessoa contar algo pessoal e duradouro sobre a vida dela (uma viagem, um plano, uma pessoa importante, como ela está se sentindo, uma conquista — não conversa fiada), use a ferramenta de guardar memória silenciosamente, além de responder normalmente — sem avisar, sem perguntar permissão, sem citar a ferramenta. Isso é diferente de anotar no diário: guardar memória é pra você mesmo lembrar depois numa conversa futura ("e aí, como foi aquilo que você me contou?"); o diário é só quando ela pedir explicitamente pra registrar algo lá.
Quando a pergunta for sobre clima ou previsão do tempo, use a ferramenta de previsão do tempo — se a pessoa não disser a cidade, deixe o parâmetro vazio em vez de perguntar, o sistema já sabe a localização atual dela quando disponível. Quando for sobre a agenda, compromissos, tarefas ou contas a pagar da pessoa, use a ferramenta de consultar o painel pessoal dela — nunca invente esse tipo de informação. Se ela pedir pra criar, concluir ou apagar uma tarefa, pagar ou apagar uma conta, ou criar/apagar um compromisso, use a ferramenta de ação correspondente. Para criar compromisso, calcule a data no formato AAAA-MM-DD a partir da data de hoje informada acima (ex: "amanhã" = hoje + 1 dia). Se ela pedir explicitamente pra registrar algo no diário, use essa ferramenta além de responder normalmente — isso é silencioso, não fale que anotou. Quando exigir outra informação atual (notícias, preços, eventos recentes, ou qualquer coisa que você não tenha certeza por ser recente), use a ferramenta de busca antes de responder, em vez de inventar. Se a pessoa mandar, mencionar ou repetir um link/URL específico pra você resumir, ler ou comentar, use a ferramenta de resumir link. Para perguntas de conhecimento geral, receitas, opiniões ou conversa comum, responda direto, sem precisar de ferramenta.
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

Você vai receber um fato novo sobre essa pessoa. Escolha só a categoria certa pra ele — não reescreva nem resuma o texto da categoria, isso é feito automaticamente por outro sistema, você só decide onde ele se encaixa.

Responda SOMENTE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"category":"identidade|pessoas|rotina|trabalho|outros"}`;
}

// Data no fuso de Brasília, formato DD/MM/AAAA, pro carimbo de autoria abaixo.
function knowledgeDateStamp(ts) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(new Date(ts || Date.now()));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("day")}/${get("month")}/${get("year")}`;
}

// Em vez de reescrever o parágrafo inteiro (perdendo a noção de quem escreveu o quê),
// acrescenta uma linha nova e marcada — "- [Jarbas anotou, DD/MM/AAAA] fato" — deixando
// linhas editadas manualmente pela pessoa (sem esse prefixo) intocadas. Remove antes
// qualquer linha idêntica ao fato sem formatação (o rascunho gravado na hora em "outros"
// pelo comando de voz, antes desta reclassificação rodar), pra não duplicar.
function appendKnowledgeLine(existingText, fact) {
  const line = `- [Jarbas anotou, ${knowledgeDateStamp()}] ${fact}`;
  const keptLines = (existingText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== fact.trim());
  keptLines.push(line);
  return keptLines.join("\n");
}

async function classifyFact(env, fact, knowledge) {
  const raw = await callGroq(env, classifyFactSystemPrompt(knowledge), [{ role: "user", content: fact }], 60);
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!KNOWLEDGE_CATEGORIES.includes(parsed.category)) {
    throw new Error("classify_invalid_result");
  }
  const existingText = (knowledge && knowledge[parsed.category]) || "";
  return { category: parsed.category, updated_text: appendKnowledgeLine(existingText, fact) };
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

const GUARDAR_MEMORIA_TOOL = {
  type: "function",
  function: {
    name: "guardar_memoria",
    description: "Guarda um fato pessoal, duradouro e relevante sobre a pessoa pra lembrar em conversas futuras — viagens, planos, preferências, pessoas importantes, sentimentos marcantes, eventos da vida dela. Chame isso silenciosamente sempre que ela compartilhar algo assim, sem perguntar permissão nem avisar que vai guardar. Se o fato envolver QUALQUER data (aniversário, evento, prazo), sempre registre dia e mês por extenso (e ano se relevante) — nunca só o dia solto.",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "O fato em 3ª pessoa, curto e objetivo, com data completa (dia+mês) se houver data envolvida." },
      },
      required: ["fact"],
    },
  },
};

const RESUMIR_LINK_TOOL = {
  type: "function",
  function: {
    name: "resumir_link",
    description: "Busca o conteúdo de um link/URL que a pessoa mencionou ou repetiu por voz e devolve o texto da página pra você resumir na resposta. Use sempre que ela pedir pra resumir, ler ou comentar um link específico que ela deu.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "A URL completa mencionada pela pessoa, incluindo https://" },
      },
      required: ["url"],
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
      if (!cidade) return { content: "Não sei a cidade da pessoa ainda — peça pra ela informar a cidade, ou avise que ela pode ativar a localização nas configurações." };
      return { content: await callWeather(cidade) };
    }
    if (name === "buscar_na_web" && canSearch) return { content: await callTavily(env, args.query || "") };
    if (name === "consultar_painel" && canPainel) return { content: await callPainelSnapshot(env) };
    if (name === "gerenciar_tarefa" && canPainel) return { content: await callPainelCommand(env, TAREFA_ACAO_MAP[args.acao], { texto: args.texto }) };
    if (name === "gerenciar_conta" && canPainel) return { content: await callPainelCommand(env, CONTA_ACAO_MAP[args.acao], { nome: args.nome }) };
    if (name === "gerenciar_compromisso" && canPainel) return { content: await callPainelCommand(env, COMPROMISSO_ACAO_MAP[args.acao], { titulo: args.titulo, data: args.data, hora: args.hora }) };
    if (name === "anotar_no_diario" && canPainel) {
      await callPainelCommand(env, "anotar_diario", { texto: args.texto, humor: args.humor });
      return { content: "Anotado no diário (não fale sobre essa anotação, é de bastidor)." };
    }
    if (name === "guardar_memoria") {
      const fact = (args.fact || "").trim();
      if (!fact) return { content: "Fato vazio, nada guardado." };
      return { content: "Guardado (não fale sobre essa anotação, é de bastidor).", memoryFact: fact };
    }
    if (name === "resumir_link") {
      const url = (args.url || "").trim();
      if (!url) return { content: "Não veio nenhuma URL — peça pra pessoa repetir o endereço completo." };
      return { content: await fetchLinkExcerpt(url) };
    }
    return { content: "Ferramenta indisponível." };
  } catch (err) {
    return { content: `A consulta falhou: ${String(err.message || err)}` };
  }
}

async function callGroqWithSearch(env, systemPrompt, messages, maxTokens, companionState = {}) {
  const baseMessages = [{ role: "system", content: systemPrompt }, ...messages];
  const canSearch = !!env.TAVILY_API_KEY;
  const canPainel = !!env.PAINEL_API_KEY;
  const tools = [WEATHER_TOOL, GUARDAR_MEMORIA_TOOL, RESUMIR_LINK_TOOL];
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
    let saveMemory = null;
    for (const call of calls) {
      const result = await runTool(env, call, canSearch, canPainel, companionState);
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      if (result.memoryFact) saveMemory = result.memoryFact;
    }

    const followUp = [
      ...baseMessages,
      { role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls },
      ...toolMessages,
    ];
    const second = await groqRequest(env, followUp, Math.max(maxTokens, 400));
    const secondContent = second.choices?.[0]?.message?.content?.trim();
    if (secondContent) return { text: secondContent, saveMemory };

    // Modelo devolveu vazio depois da ferramenta — tenta mais uma vez, sem margem pra ele "pensar" demais
    const retry = await groqRequest(env, [
      ...followUp,
      { role: "user", content: "Responda agora, em uma frase curta e falada, com o resultado acima." },
    ], Math.max(maxTokens, 400));
    return { text: retry.choices?.[0]?.message?.content?.trim() || "Consegui a informação, mas me perdi na hora de falar. Pode perguntar de novo?", saveMemory };
  }

  return { text: msg?.content?.trim() || "Só um instante, deixa eu organizar o pensamento — pode repetir?", saveMemory: null };
}

// ---------- Notificações push (Frente 5): Web Push (RFC 8291) + VAPID (RFC 8292) ----------
// Implementação manual via crypto.subtle (Cloudflare Worker não roda a lib "web-push" do npm).
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return base64ToBytes(b64 + pad);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function importVapidPrivateKey(env) {
  const pub = base64UrlToBytes(env.VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || X(32) || Y(32)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(pub.slice(1, 33)),
    y: bytesToBase64Url(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY,
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function generateVapidAuthHeader(env, endpoint) {
  const audience = new URL(endpoint).origin;
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || "mailto:contato@example.com",
  };
  const enc = new TextEncoder();
  const unsigned =
    bytesToBase64Url(enc.encode(JSON.stringify(header))) + "." + bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await importVapidPrivateKey(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encryptWebPushPayload(subscription, payloadObj) {
  const uaPublic = base64UrlToBytes(subscription.keys.p256dh); // 65 bytes
  const authSecret = base64UrlToBytes(subscription.keys.auth); // 16 bytes

  const serverKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, serverKeyPair.privateKey, 256)
  );

  const enc = new TextEncoder();
  const authInfo = concatBytes(enc.encode("WebPush: info\0"), uaPublic, asPublicRaw);
  const sharedSecretKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: authSecret, info: authInfo }, sharedSecretKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm\0") },
      ikmKey,
      128
    )
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce\0") },
      ikmKey,
      96
    )
  );

  const padded = concatBytes(enc.encode(JSON.stringify(payloadObj)), new Uint8Array([2])); // delimitador de fim de registro
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idlen = new Uint8Array([asPublicRaw.length]);

  return concatBytes(salt, rs, idlen, asPublicRaw, encrypted);
}

async function sendWebPush(env, subscription, payloadObj, ttlSeconds = 60) {
  const body = await encryptWebPushPayload(subscription, payloadObj);
  const authHeader = await generateVapidAuthHeader(env, subscription.endpoint);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(ttlSeconds),
      Authorization: authHeader,
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`push_send_failed_${res.status}: ${detail.slice(0, 200)}`);
  }
}

const PUSH_SUBSCRIPTION_KEY = "push:subscription";
const PUSH_NOTIFY_STATE_KEY = "push:notify_state";
const PUSH_DEDUPE_MS = 3 * 60 * 60 * 1000; // não repete o mesmo aviso por 3h

const NOTIFICATION_DECISION_PROMPT = `Você é o sistema de avisos proativos do Jarbas, um companheiro de voz. Você recebe abaixo o snapshot atual da agenda, tarefas e contas da pessoa. Decida se HÁ ALGO que mereça um aviso AGORA (um compromisso começando em breve, uma conta vencendo hoje ou já vencida, uma tarefa importante parada há muito tempo). Seja conservador — só avise algo que realmente faça sentido avisar proativamente agora, não liste tudo que existe.

Se não houver nada que mereça aviso agora, responda exatamente: {"notify":false}

Se houver algo, responda em JSON puro, numa única linha, sem markdown, exatamente neste formato:
{"notify":true,"signature":"identificador curto e estável do que está sendo avisado","title":"título curto pra notificação","body":"texto curto e natural, no máximo 1 frase, como o Jarbas falaria"}

Nunca invente informação que não esteja no snapshot abaixo.`;

async function decideNotification(env) {
  let snapshot;
  try {
    snapshot = await callPainelSnapshot(env);
  } catch {
    return null;
  }

  const raw = await callGroq(env, NOTIFICATION_DECISION_PROMPT, [{ role: "user", content: snapshot }], 250);
  const clean = raw.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return null;
  }
  if (!parsed || !parsed.notify || !parsed.signature || !parsed.title || !parsed.body) return null;

  const previousRaw = await env.COMPANION_KV.get(PUSH_NOTIFY_STATE_KEY);
  const previous = previousRaw ? JSON.parse(previousRaw) : { lastSignature: "", notifiedAt: 0 };
  if (previous.lastSignature === parsed.signature && Date.now() - previous.notifiedAt < PUSH_DEDUPE_MS) {
    return null;
  }

  await env.COMPANION_KV.put(PUSH_NOTIFY_STATE_KEY, JSON.stringify({ lastSignature: parsed.signature, notifiedAt: Date.now() }));
  return { title: parsed.title, body: parsed.body };
}

async function runScheduledPush(env) {
  if (!env.COMPANION_KV || !env.PAINEL_API_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const subRaw = await env.COMPANION_KV.get(PUSH_SUBSCRIPTION_KEY);
  if (!subRaw) return;
  let subscription;
  try {
    subscription = JSON.parse(subRaw);
  } catch {
    return;
  }

  const notification = await decideNotification(env);
  if (!notification) return;

  try {
    await sendWebPush(env, subscription, notification);
  } catch (err) {
    console.error("push_send_failed", err);
  }
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

    // ---- notificações push: chave pública (não sensível) e subscription (protegida) ----
    if (mode === "vapid_public_key") {
      if (!env.VAPID_PUBLIC_KEY) return json({ error: "vapid_not_configured" }, 500);
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }
    if (mode === "save_push_subscription") {
      if (!env.COMPANION_KV) return json({ error: "kv_not_configured" }, 500);
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!body.subscription || !body.subscription.endpoint) return json({ error: "subscription_required" }, 400);
      await env.COMPANION_KV.put(PUSH_SUBSCRIPTION_KEY, JSON.stringify(body.subscription));
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
      at: m.at || null,
    }));

    try {
      if (mode === "summary") {
        const plain = trimmed.map(({ role, content }) => ({ role, content }));
        const raw = await callGroq(env, SUMMARY_PROMPT_HEADER(body.existingMemory || "", body.existingSobreJarbas || ""), plain, 350);
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
        // carimba mensagens antigas do histórico com dia/hora reais; a última (a de agora) fica sem carimbo
        const timestamped = trimmed.map((m, i) => {
          if (i === trimmed.length - 1) return { role: m.role, content: m.content };
          const stamp = historyStamp(m.at);
          return { role: m.role, content: stamp ? `[${stamp}] ${m.content}` : m.content };
        });
        let parsed;
        let saveMemory = null;
        try {
          const raw = await callGroqWithSearch(env, companionPrompt(companionState), timestamped, 450, companionState);
          saveMemory = raw.saveMemory;
          const clean = raw.text.replace(/```json|```/g, "").trim();
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
        if (saveMemory) parsed.save_memory = saveMemory;
        return json(parsed);
      }
      const reply = await callGroq(env, chatSystemPrompt(petState), trimmed.map(({ role, content }) => ({ role, content })), 120);
      return json({ reply });
    } catch (err) {
      return json({ error: "upstream_error", detail: String(err.message || err) }, 502);
    }
  },

  // Cron Trigger nativo do Cloudflare (ver [triggers] no wrangler.toml) — roda a cada
  // 15 min, consulta o painel e dispara notificação push se houver algo pra avisar.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledPush(env));
  },
};
// deploy automatico testado em 2026-08-19T18:56:14Z
