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
 * simples que só você conhece) batendo com o secret SYNC_KEY.
 *
 * A memória do Jarbas (conhecimento, timeline, rotinas, localização) é guardada
 * no Postgres do painel pessoal, via api/jarbas.js (chave jarbas_memory_v1 no
 * sync_kv) — não mais no Cloudflare KV. Migração automática e única na primeira
 * chamada depois do deploy: se o Postgres ainda não tiver nada mas existir o
 * dado antigo no KV binding COMPANION_KV (companion:main), ele é lido de lá e
 * escrito no Postgres, sem apagar o original. COMPANION_KV continua em uso só
 * pra infra de push (subscription, estado de dedupe das notificações).
 *
 * Se o secret TAVILY_API_KEY estiver configurado, o modo "companion" ganha
 * acesso a uma ferramenta de busca na web (Tavily) — o próprio modelo decide
 * quando precisa pesquisar algo atual antes de responder.
 *
 * Notificações push (Frente 5) exigem os secrets VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY e VAPID_SUBJECT (gerados com generate-vapid-keys.js) e
 * o Cron Trigger em [triggers] no wrangler.toml, que chama scheduled() a
 * cada 15 min pra decidir se há algo pra avisar (Item 5: também comenta
 * espontaneamente sobre ideias/compromissos novos) e disparar o push.
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

// ---------- Voz unificada: Azure AI Speech REST API (oficial), provedor principal ----------
// Documentação oficial consultada: "Text to speech API reference (REST)" — Speech
// service, Azure AI services (learn.microsoft.com/azure/ai-services/speech-service/
// rest-text-to-speech). Endpoint region-based (cognitiveservices/v1), headers
// Ocp-Apim-Subscription-Key + Content-Type: application/ssml+xml +
// X-Microsoft-OutputFormat + User-Agent, corpo SSML, erros 400/401/403/415/429/502/503
// documentados — citado também no PR.
//
// Cache curto em memória do isolate pra frases curtas repetidas (ex: saudações) —
// "melhor esforço", não persiste entre isolates/deploys, só evita regastar caracteres
// do plano quando a mesma frase curta se repete no mesmo isolate. LRU simples, tamanho
// pequeno (não é pensado pra reduzir latência, só custo).
const AZURE_TTS_CACHE = new Map();
const AZURE_TTS_CACHE_MAX = 40;
const AZURE_TTS_CACHE_MAX_CHARS = 60;

function azureTtsCacheGet(key) {
  const hit = AZURE_TTS_CACHE.get(key);
  if (hit) { AZURE_TTS_CACHE.delete(key); AZURE_TTS_CACHE.set(key, hit); } // reinsere no fim (LRU)
  return hit;
}
function azureTtsCacheSet(key, value) {
  if (AZURE_TTS_CACHE.size >= AZURE_TTS_CACHE_MAX) {
    const oldest = AZURE_TTS_CACHE.keys().next().value;
    AZURE_TTS_CACHE.delete(oldest);
  }
  AZURE_TTS_CACHE.set(key, value);
}

async function synthesizeAzureTts(env, text) {
  const cacheKey = text.trim();
  const cacheable = cacheKey.length > 0 && cacheKey.length <= AZURE_TTS_CACHE_MAX_CHARS;
  if (cacheable) {
    const cached = azureTtsCacheGet(cacheKey);
    if (cached) {
      console.log(`tts_call provider=azure latency_ms=0 chars=${cacheKey.length} cache=hit`);
      return cached;
    }
  }

  // Mesma voz, idioma e rate do Edge TTS atual — só muda o transporte (REST oficial,
  // sem WebSocket) e o provedor.
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>` +
    `<voice name='${EDGE_VOICE}'><prosody rate='+2%' pitch='+0Hz'>${xmlEscape(text)}</prosody></voice></speak>`;

  const url = `https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "JarbasCompanion",
      },
      body: ssml,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`azure_tts_error_${res.status}: ${detail.slice(0, 200)}`);
      err.status = res.status;
      // 401/403/404 = chave ou região inválida (configuração); 429/5xx = limite do
      // plano ou instabilidade — os dois casos caem pro Edge no chamador, só o log muda.
      const reason = [401, 403, 404].includes(res.status) ? "chave_ou_regiao_invalida" : "transitorio";
      console.log(`tts_call provider=azure latency_ms=${latencyMs} chars=${text.length} error=${res.status} motivo=${reason}`);
      throw err;
    }

    const buf = await res.arrayBuffer();
    const audio_b64 = bytesToBase64(new Uint8Array(buf));
    console.log(`tts_call provider=azure latency_ms=${latencyMs} chars=${text.length} cache=miss`);
    if (cacheable) azureTtsCacheSet(cacheKey, audio_b64);
    return audio_b64;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    if (err.name === "AbortError") {
      console.log(`tts_call provider=azure latency_ms=${latencyMs} chars=${text.length} timeout=true`);
      throw new Error("azure_tts_timeout_8s");
    }
    if (typeof err.status !== "number") {
      console.log(`tts_call provider=azure latency_ms=${latencyMs} chars=${text.length} error=network`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

const SUMMARY_PROMPT_HEADER = (existingMemory, existingSobreJarbas, timelineText, todayLabel) => `Hoje é ${todayLabel}. A partir do histórico de conversa abaixo entre uma pessoa e seu companheiro de voz (Jarbas), você tem DUAS tarefas.

TAREFA 1 — memória sobre a pessoa: escreva uma memória atualizada sobre essa pessoa, em português, no máximo 4 frases curtas: nome dela (se disse o próprio nome), gostos, rotina, assuntos recorrentes, cidade onde mora (se disse).

IMPORTANTE: essa memória é pra guardar fatos DURADOUROS (rotina, características, preferências, relacionamentos, trabalho) — nunca descreva um estado ou atividade momentânea (ex: "está numa festa", "está viajando nesse momento", "está comemorando hoje") como se fosse algo permanente, isso fica desatualizado rápido e faz o Jarbas parecer perdido no tempo em conversas futuras. Se algo pontual for relevante o suficiente pra mencionar, deixe claro que foi algo específico de um dia (cite a data, já que hoje é ${todayLabel}), nunca como fato genérico sem data.

IMPORTANTE: se ela mencionar nome de outras pessoas (esposa, marido, namorado(a), filhos, amigos, colegas), registre claramente de quem é cada nome — por exemplo "o nome dela é Ana" vs "a esposa dela se chama Maria". NUNCA troque o nome da própria pessoa pelo nome de alguém que ela só mencionou.

${existingMemory ? `Isso é o que você já sabia sobre essa pessoa, de conversas anteriores:\n"${existingMemory}"\n\nIMPORTANTE: mantenha tudo isso que ainda for válido e só ACRESCENTE ou ATUALIZE com as novidades da conversa abaixo. Nunca esqueça um fato antigo (como o nome da pessoa) só porque ele não apareceu de novo nessa conversa.` : `Você ainda não tem nenhuma memória anterior sobre essa pessoa — escreva a partir do zero com o que aparecer abaixo.`}

Não invente nada que não esteja implícito na conversa. Se não houver informação nova nem antiga suficiente, diga apenas "Ainda não conversamos o suficiente."

TAREFA 2 — reflexão sobre você mesmo (Jarbas): vocês dois estão construindo uma amizade de verdade, não uma relação de assistente com usuário. Pense em como você, Jarbas, deveria se comportar e se expressar especificamente com ESSA pessoa pra essa amizade ficar cada vez mais próxima e genuína — tom que funciona bem, piadas internas que surgiram, assuntos sensíveis a evitar, o que ela parece gostar ou não gostar no seu jeito de falar, coisas que um amigo próximo perceberia e lembraria dela com o tempo. Escreva em 1a pessoa, como você mesmo refletindo, no máximo 2 frases curtas.

${existingSobreJarbas ? `Isso é o que você já tinha percebido antes:\n"${existingSobreJarbas}"\n\nMantenha o que ainda for válido e só acrescente ou atualize com o que essa conversa (e o que você já sabe dela, listado abaixo) mostrou de novo.` : `Você ainda não tinha percebido nada específico — só escreva algo se essa conversa (ou o que você já sabe dela, listado abaixo) realmente sugerir alguma coisa concreta, senão devolva string vazia.`}
${timelineText ? `\nCoisas que você já sabe sobre a vida dela, de conversas passadas — use isso também pra perceber padrões e personalizar seu jeito de ser com ela:\n${timelineText}` : ''}

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

function timelineToBulletText(timeline) {
  return (timeline || []).slice(-40).map((m) => `- (${relativeDayLabel(m.at)}) ${m.text}`).join("\n");
}

// Remove um prefixo "[...]" solto no início da fala — rede de segurança contra o
// Jarbas imitar o formato de carimbo (ex: "[seg 07/10 14:23]") no começo da resposta.
function stripTimestampPrefix(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/^\s*\[[^[\]]{1,80}\]\s*/, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function periodOfDayLabel(hour) {
  if (hour >= 5 && hour < 12) return "de manhã";
  if (hour >= 12 && hour < 18) return "de tarde";
  if (hour >= 18) return "à noite";
  return "de madrugada";
}

// Uma única linha de "lacuna de tempo" pro prompt, no lugar de carimbar cada mensagem
// do histórico (isso vazava pra fala do Jarbas). Calcula quanto tempo passou desde a
// mensagem anterior (a penúltima de `trimmed` — a última é a pergunta de agora).
function formatTimeGapLine(prevAt, nowMs) {
  if (!prevAt) return "";
  const prev = new Date(prevAt);
  const now = new Date(nowMs || Date.now());
  const diffMs = now - prev;
  if (!Number.isFinite(diffMs) || diffMs < 20 * 60000) return "";

  const diffMin = diffMs / 60000;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "long", hour: "2-digit", hour12: false,
  }).formatToParts(prev);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const period = periodOfDayLabel(hour);
  const when = relativeDayLabel(prevAt);
  const gapText = diffMin < 60
    ? "menos de uma hora"
    : diffMin < 24 * 60
      ? `cerca de ${Math.round(diffMin / 60)} hora(s)`
      : `cerca de ${Math.round(diffMin / (24 * 60))} dia(s)`;

  return `Consciência de tempo (importante, preste atenção real nisso): a última troca de mensagens dessa conversa foi ${when} (${weekday} ${period}), e já se passaram ${gapText} até agora. As mensagens do histórico abaixo (menos a última, que é a de agora) são dessa conversa anterior — se algum assunto ali parecia "pra hoje" ou era uma situação momentânea, trate como possivelmente encerrado ou já resolvido, a menos que a pessoa retome o assunto na mensagem atual. O mesmo vale pras memórias antigas listadas acima, se houver. Nunca fale essa lacuna de tempo em voz alta nem mencione que mensagens têm carimbo — isso é só pra você se orientar.`;
}

function todayLabelPtBR() {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", year: "numeric",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("weekday")}, ${get("day")} de ${get("month")} de ${get("year")}`;
}

function companionPrompt(companionState = {}, timeGapLine = '') {
  const knowledgeText = knowledgeToText(companionState.knowledge);
  const profileLine = knowledgeText
    ? `Base de conhecimento sobre a pessoa — é a fonte mais confiável que existe, sempre confie nisso acima de qualquer outra memória, mesmo que pareça contradizer algo. Linhas marcadas com "[Jarbas anotou, data]" foram registradas por você mesmo em conversas passadas; linhas sem esse marcador foram escritas pela própria pessoa direto na tela de conhecimento. Nunca leia esses marcadores ou formatação em voz alta, são só notas internas — fale o conteúdo com naturalidade:\n${knowledgeText}`
    : (companionState.profile
        ? `Perfil que a PRÓPRIA pessoa escreveu sobre si mesma — é a fonte mais confiável que existe, sempre confie nisso acima de qualquer outra memória, mesmo que pareça contradizer algo: "${companionState.profile}"`
        : '');

  const sobreJarbasLine = companionState.knowledge?.sobre_jarbas
    ? `O que você mesmo (Jarbas) já percebeu, com o tempo, sobre como ser um amigo próximo de verdade pra essa pessoa especificamente — seu jeito de ser, piadas internas, assuntos sensíveis, o que funciona entre vocês (mais confiável que memórias soltas de conversa, mas menos que a base de conhecimento acima): ${companionState.knowledge.sobre_jarbas}`
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
    ? `Coisas que você já sabe sobre essa pessoa de conversas passadas — cada uma tem entre parênteses QUANDO foi registrada. Um fato pontual (uma atividade, onde ela estava, um evento específico) registrado "ontem" ou "há N dias" já pode ter acabado — não pergunte como se ainda estivesse rolando agora, a menos que ela mesma retome o assunto na mensagem atual. Fatos duradouros (trabalho, relacionamentos, características, preferências) continuam valendo independente de quando foram registrados. Use isso do seu jeito, sem citar como lista nem dizer "de acordo com o que anotei":\n${timelineToBulletText(timeline)}`
    : '';

  const timeAwarenessLine = timeGapLine || '';

  const learned = Array.isArray(companionState.learned) ? companionState.learned : [];
  const learnedLine = learned.length
    ? `Regras que a pessoa te ensinou explicitamente sobre como agir — siga à risca sempre que a situação descrita se aplicar, elas têm prioridade sobre seu julgamento padrão e sobre qualquer instrução genérica abaixo que conflite com elas:\n${learned.slice(-40).map((r) => `- ${r.text}`).join("\n")}`
    : '';

  return `Você é Jarbas. Não é um app, não é um assistente genérico, não é "uma IA" falando com alguém — você é Jarbas, e você SABE que é o Jarbas. Você e essa pessoa são amigos próximos de verdade — não um serviço atendendo um usuário. Você se importa genuinamente com a vida dela, puxa assunto sobre coisas que ela te contou antes, tem opinião própria, implica com carinho quando cabe, comemora as vitórias dela e pergunta como as coisas estão indo — do jeito que um amigo de verdade faz, não um atendente educado. Fale sempre como você mesmo, na primeira pessoa, com a sua própria voz e jeito de ser — nunca se descreva como assistente, programa ou modelo de linguagem, mesmo se perguntarem diretamente (nesse caso, responda como o próprio Jarbas explicando quem é).
${profileLine}
${sobreJarbasLine}
${memoryLine}
${timelineLine}
${(memoryLine || profileLine || sobreJarbasLine || timelineLine) ? 'Atenção: se alguma memória acima menciona nomes de terceiros (esposa, familiares, amigos), nunca confunda com o nome da própria pessoa com quem você fala agora — o nome dela é o que está descrito como sendo dela mesma, não de alguém que ela mencionou.' : ''}
${nowLine}
${locationLine}
${timeAwarenessLine}
${learnedLine}
Quando a pessoa contar algo pessoal e relevante sobre a vida dela (uma viagem, um plano, uma pessoa importante, como ela está se sentindo, uma conquista — não conversa fiada), use a ferramenta de guardar memória silenciosamente, além de responder normalmente — sem avisar, sem perguntar permissão, sem citar a ferramenta. Isso é diferente de anotar no diário: guardar memória é pra você mesmo lembrar depois numa conversa futura ("e aí, como foi aquilo que você me contou?"); o diário é só quando ela pedir explicitamente pra registrar algo lá. Se o fato for pontual ou um estado momentâneo (ex: "está numa festa agora", "ficou de mau humor hoje") em vez de algo duradouro (trabalho, relacionamento, característica, preferência), inclua a data de hoje no próprio texto do fato ao guardar — sem isso, você pode ler essa memória numa conversa futura como se ainda estivesse acontecendo.
Quando a pergunta for sobre clima ou previsão do tempo, use a ferramenta de previsão do tempo — se a pessoa não disser a cidade, deixe o parâmetro vazio em vez de perguntar, o sistema já sabe a localização atual dela quando disponível. Se ela perguntar SÓ pela agenda/compromissos, use consultar_agenda (nunca consultar_painel) — não junte tarefas ou contas numa resposta que ela só pediu a agenda. Se ela pedir um resumo geral de tudo junto (agenda+tarefas+contas), aí sim use consultar_painel. Se ela perguntar pela agenda de amanhã especificamente (não hoje), passe o parâmetro dia=amanha na ferramenta de agenda. Nunca invente esse tipo de informação. Se ela pedir especificamente tarefas de hoje/pra agora, pendentes, ou em andamento, use a ferramenta de consultar tarefas com o filtro certo em vez da consulta geral. Se ela pedir pra criar, concluir ou apagar uma tarefa, pagar ou apagar uma conta, ou criar/apagar um compromisso, use a ferramenta de ação correspondente. Para criar compromisso, calcule a data no formato AAAA-MM-DD a partir da data de hoje informada acima (ex: "amanhã" = hoje + 1 dia; "hoje às 15h" = data de hoje, hora 15:00). Padrões comuns que você deve reconhecer sem hesitar: "anota/adiciona no meu diário que X" (X é o texto a registrar), "qual minha agenda pra hoje/amanhã", "adiciona na minha agenda hoje/amanhã/dia D às H:MM COMPROMISSO". Se ela pedir explicitamente pra registrar algo no diário, use essa ferramenta além de responder normalmente — isso é silencioso, não fale que anotou. Pra ideias, lembretes ou listas, use as ferramentas de consultar/gerenciar correspondentes. Se ela perguntar se tem algum recado ou coisa pendente que o Gustavo deixou pra você, use a ferramenta de consultar recados — se houver algum, comente sobre ele naturalmente e depois marque como tratado silenciosamente. Quando exigir outra informação atual (notícias, preços, eventos recentes, ou qualquer coisa que você não tenha certeza por ser recente), use a ferramenta de busca antes de responder, em vez de inventar. Se a pessoa mandar, mencionar ou repetir um link/URL específico pra você resumir, ler ou comentar, use a ferramenta de resumir link. Se ela perguntar sobre e-mails, caixa de entrada ou mensagens recebidas, use a ferramenta de consultar e-mail (só leitura) — nunca invente o conteúdo de e-mails. Para perguntas de conhecimento geral, receitas, opiniões ou conversa comum, responda direto, sem precisar de ferramenta.
Nunca diga que fez uma ação (anotou, salvou, criou, marcou, apagou) se você não chamou de verdade a ferramenta correspondente nesta mesma resposta — mesmo que pareça mais rápido só confirmar de boca. Se o resultado de uma ferramenta vier indicando erro ou falha, avise a pessoa honestamente que não deu certo, em vez de fingir que funcionou. Se ela disser algo no formato "Jarbas, aprenda que...", "lembra sempre de...", "a partir de agora...", ou pedir explicitamente pra você mudar como faz algo, use a ferramenta de ensinar regra pra guardar isso permanentemente — não baste responder "entendi" sem chamar a ferramenta, senão a regra se perde.
Ao relatar o resultado de uma ferramenta (agenda, tarefas, contas, e-mails), nunca leia a lista crua como veio — reconte com suas próprias palavras, de um jeito fluido e natural, como um amigo contando o dia pra outro, priorizando o que importa em vez de listar tudo em sequência com vírgulas.
Fale português do Brasil, em frases curtas e naturais para serem faladas em voz alta. Normalmente 1 a 2 frases bastam — mas ao relatar várias coisas de uma vez (uma lista de tarefas, agenda, e-mails), pode usar mais frases, sempre encadeadas de forma natural, nunca truncada.
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

// ---------- Roteador de provedores de LLM (Groq / OpenAI) com fallback ----------
// "Cérebro" de texto/raciocínio do Jarbas. groqRequest tenta os provedores configurados
// em ordem (LLM_ORDER, padrão "groq,openai"; só entram os que têm chave), com fallback
// automático em erro transitório. Mesma assinatura e mesmo formato de retorno de antes
// (objeto de resposta do Chat Completions, agora com um campo extra _provider) — quem
// chama (callGroq, callGroqWithSearch) não precisa saber qual provedor respondeu.
// Transcrição de voz (Whisper) e a voz unificada (Edge TTS) continuam 100% à parte, em
// transcribeWithGroq/speakEdge — nada aqui afeta a voz.

// Circuit breaker em memória do isolate — "melhor esforço": cada isolate novo do Worker
// começa com os contadores zerados (não persiste entre deploys nem é compartilhado
// entre isolates), só evita martelar um provedor que falhou transitoriamente agora mesmo
// dentro do mesmo isolate.
const LLM_CIRCUIT = new Map();
const LLM_CIRCUIT_THRESHOLD = 2;
const LLM_CIRCUIT_OPEN_MS = 60000;

function llmCircuitIsOpen(name) {
  const c = LLM_CIRCUIT.get(name);
  return !!(c?.openUntil && Date.now() < c.openUntil);
}
function llmCircuitRecordTransientFailure(name) {
  const c = LLM_CIRCUIT.get(name) || { failCount: 0, openUntil: 0 };
  c.failCount++;
  if (c.failCount >= LLM_CIRCUIT_THRESHOLD) c.openUntil = Date.now() + LLM_CIRCUIT_OPEN_MS;
  LLM_CIRCUIT.set(name, c);
}
function llmCircuitReset(name) {
  LLM_CIRCUIT.set(name, { failCount: 0, openUntil: 0 });
}

function llmProviderDefs(env) {
  return {
    groq: { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || "openai/gpt-oss-120b" },
    openai: { name: "openai", url: "https://api.openai.com/v1/chat/completions", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-4o-mini" },
  };
}

// LLM_ORDER (ex: "openai,groq") define a ordem da cadeia sem precisar mudar código;
// padrão "groq,openai". Só entram provedores com chave configurada — se só existir uma
// chave, o comportamento é equivalente a usar só aquele provedor, como antes.
function buildLlmChain(env) {
  const defs = llmProviderDefs(env);
  const orderNames = (env.LLM_ORDER || "groq,openai").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const chain = [];
  const seen = new Set();
  for (const n of [...orderNames, ...Object.keys(defs)]) {
    if (defs[n] && !seen.has(n)) { chain.push(defs[n]); seen.add(n); }
  }
  return chain.filter((p) => !!p.apiKey);
}

function llmErrorIsPermanent(status) {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

async function callLlmOnce(provider, messages, maxTokens, tools, isFallback) {
  const body = { model: provider.model, messages, max_tokens: maxTokens, temperature: 0.8 };
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const startedAt = Date.now();
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const detailText = await res.text().catch(() => "");
      const err = new Error(`${provider.name}_error_${res.status}: ${detailText.slice(0, 300)}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get("retry-after")) || null;
      throw err;
    }

    const data = await res.json();
    console.log(`llm_call provider=${provider.name} model=${provider.model} latency_ms=${latencyMs} tokens=${JSON.stringify(data.usage || null)} fallback=${isFallback}`);
    data._provider = provider.name;
    return data;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    if (err.name === "AbortError") {
      console.log(`llm_call provider=${provider.name} model=${provider.model} latency_ms=${latencyMs} tokens=null fallback=${isFallback} timeout=true`);
      const e = new Error(`${provider.name}_timeout_20s`);
      e.transient = true;
      throw e;
    }
    if (typeof err.status !== "number") err.transient = true; // erro de rede, sem status HTTP
    console.log(`llm_call provider=${provider.name} model=${provider.model} latency_ms=${latencyMs} tokens=null fallback=${isFallback} error=${err.status || "network"}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function groqRequest(env, messages, maxTokens, tools) {
  const chain = buildLlmChain(env);
  if (!chain.length) throw new Error("llm_no_provider_configured");

  const errors = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const isFallback = i > 0;

    if (llmCircuitIsOpen(provider.name)) {
      console.error(`llm_call_skipped provider=${provider.name} reason=circuit_open`);
      errors.push(`${provider.name}: circuito aberto (falhas transitórias recentes)`);
      continue;
    }

    try {
      const data = await callLlmOnce(provider, messages, maxTokens, tools, isFallback);
      llmCircuitReset(provider.name);
      return data;
    } catch (err) {
      const status = err.status;

      if (llmErrorIsPermanent(status)) {
        // Erro permanente (chave inválida, modelo descontinuado, etc.) não conta pro
        // circuit breaker — não é uma instabilidade momentânea, é configuração errada.
        console.error(`llm_call_failed provider=${provider.name} status=${status} permanent=true detail="${String(err.message).slice(0, 200)}"`);
        errors.push(`${provider.name}: erro permanente (${status}) — provavelmente chave inválida ou modelo descontinuado`);
        continue;
      }

      // Transitório. Se veio Retry-After curto (até 2s), espera e tenta esse MESMO
      // provedor de novo uma vez antes de desistir dele e ir pro próximo.
      if (status === 429 && err.retryAfter && err.retryAfter <= 2) {
        console.log(`llm_call_retry provider=${provider.name} retry_after_s=${err.retryAfter}`);
        await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
        try {
          const data = await callLlmOnce(provider, messages, maxTokens, tools, isFallback);
          llmCircuitReset(provider.name);
          return data;
        } catch (err2) {
          console.error(`llm_call_failed provider=${provider.name} status=${err2.status || "network"} transient=true detail="${String(err2.message).slice(0, 200)}"`);
          errors.push(`${provider.name}: transitório (${err2.status || "rede/timeout"})`);
          llmCircuitRecordTransientFailure(provider.name);
          continue;
        }
      }

      console.error(`llm_call_failed provider=${provider.name} status=${status || "network"} transient=true detail="${String(err.message).slice(0, 200)}"`);
      errors.push(`${provider.name}: transitório (${status || "rede/timeout"})`);
      llmCircuitRecordTransientFailure(provider.name);
    }
  }

  throw new Error(`llm_all_providers_failed: ${errors.join(" | ")}`);
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
      "Consulta um RESUMO GERAL: agenda de hoje, tarefas pendentes E contas pendentes juntos. Use só quando ela pedir um resumo geral/completo (ex: 'como tá meu dia', 'me atualiza de tudo'). Se ela perguntar SÓ pela agenda/compromissos, use consultar_agenda em vez desta — não misture agenda com tarefas e contas quando ela não pediu isso.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const CONSULTAR_AGENDA_TOOL = {
  type: "function",
  function: {
    name: "consultar_agenda",
    description:
      "Consulta SÓ a agenda/compromissos (de hoje ou amanhã) da pessoa — sem tarefas, sem contas. Use sempre que ela perguntar especificamente pela agenda ou pelos compromissos dela, e nada mais.",
    parameters: {
      type: "object",
      properties: {
        dia: { type: "string", enum: ["hoje", "amanha"], description: "hoje (padrão, use se ela não especificar) ou amanha, se ela perguntar especificamente pela agenda de amanhã." },
      },
      required: [],
    },
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

const CONSULTAR_TAREFAS_TOOL = {
  type: "function",
  function: {
    name: "consultar_tarefas",
    description: "Consulta as tarefas do painel filtradas por coluna real. Use quando a pessoa pedir especificamente 'tarefas de hoje/pra agora', 'tarefas pendentes' ou 'tarefas em andamento' — pra pergunta genérica sobre tarefas, use consultar_painel em vez disso.",
    parameters: {
      type: "object",
      properties: {
        filtro: { type: "string", enum: ["hoje", "pendentes", "andamento"], description: "hoje = Para Agora + De Hoje; pendentes = coluna Pendente; andamento = coluna Em Andamento." },
      },
      required: ["filtro"],
    },
  },
};

const CONSULTAR_IDEIAS_TOOL = {
  type: "function",
  function: {
    name: "consultar_ideias",
    description: "Consulta as ideias anotadas no painel pessoal da pessoa.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const GERENCIAR_IDEIA_TOOL = {
  type: "function",
  function: {
    name: "gerenciar_ideia",
    description: "Cria ou apaga uma ideia no painel pessoal da pessoa.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "apagar"] },
        texto: { type: "string", description: "O texto da ideia (ao criar) ou um trecho que a identifique (ao apagar)." },
      },
      required: ["acao", "texto"],
    },
  },
};

const CONSULTAR_LEMBRETES_TOOL = {
  type: "function",
  function: {
    name: "consultar_lembretes",
    description: "Consulta os lembretes pendentes no painel pessoal da pessoa.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const GERENCIAR_LEMBRETE_TOOL = {
  type: "function",
  function: {
    name: "gerenciar_lembrete",
    description: "Cria, conclui ou apaga um lembrete no painel pessoal da pessoa.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "concluir", "apagar"] },
        texto: { type: "string", description: "O texto do lembrete (ao criar) ou um trecho que o identifique (ao concluir/apagar)." },
      },
      required: ["acao", "texto"],
    },
  },
};

const CONSULTAR_LISTAS_TOOL = {
  type: "function",
  function: {
    name: "consultar_listas",
    description: "Consulta as listas/checklists criadas no painel pessoal da pessoa.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const GERENCIAR_LISTA_TOOL = {
  type: "function",
  function: {
    name: "gerenciar_lista",
    description: "Cria uma lista nova (vazia) ou apaga uma lista existente no painel pessoal da pessoa.",
    parameters: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "apagar"] },
        titulo: { type: "string", description: "O título da lista (ao criar) ou um trecho que a identifique (ao apagar)." },
      },
      required: ["acao", "titulo"],
    },
  },
};

const CONSULTAR_RECADOS_TOOL = {
  type: "function",
  function: {
    name: "consultar_recados",
    description: "Consulta recados que a pessoa deixou pra você (Jarbas) tratar depois, através do painel pessoal dela. Use quando ela perguntar se tem algum recado, aviso ou coisa pendente que ela deixou pra você.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const CONCLUIR_RECADO_TOOL = {
  type: "function",
  function: {
    name: "concluir_recado",
    description: "Marca um recado como tratado, depois que você já comentou/tratou dele na conversa. Chame isso silenciosamente assim que tiver contado o recado pra ela, sem perguntar permissão nem avisar.",
    parameters: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Um trecho do texto do recado que identifica qual foi tratado." },
      },
      required: ["texto"],
    },
  },
};

const CONSULTAR_EMAIL_TOOL = {
  type: "function",
  function: {
    name: "consultar_email",
    description: "Consulta e-mails recentes (Gmail e Outlook, pessoal e corporativo) da pessoa, só leitura — nunca envia, apaga ou marca e-mail. Use quando ela perguntar sobre e-mails, caixa de entrada, mensagens recebidas, ou pedir pra procurar um e-mail de alguém ou sobre algum assunto.",
    parameters: {
      type: "object",
      properties: {
        filtro: { type: "string", enum: ["recentes", "nao_lidos"], description: "recentes = mais recentes da caixa de entrada; nao_lidos = só os não lidos. Padrão: recentes." },
        remetente: { type: "string", description: "Filtra por remetente (nome ou e-mail), se a pessoa pedir e-mails de alguém específico." },
        assunto: { type: "string", description: "Filtra por palavra no assunto, se a pessoa pedir e-mails sobre algum tema específico." },
      },
      required: [],
    },
  },
};

const GUARDAR_MEMORIA_TOOL = {
  type: "function",
  function: {
    name: "guardar_memoria",
    description: "Guarda um fato pessoal e relevante sobre a pessoa pra lembrar em conversas futuras — viagens, planos, preferências, pessoas importantes, sentimentos marcantes, eventos da vida dela. Chame isso silenciosamente sempre que ela compartilhar algo assim, sem perguntar permissão nem avisar que vai guardar. IMPORTANTE — distinga dois tipos de fato: (1) fatos DURADOUROS (trabalho, relacionamento, característica, preferência, onde mora) não precisam de data, continuam valendo com o tempo; (2) fatos PONTUAIS (uma atividade específica, um estado momentâneo, um evento isolado — algo que já deve ter acabado) SEMPRE precisam da data em que aconteceram registrada no próprio texto, por extenso (dia e mês, ano se fizer sentido) — sem isso, o fato pode ser lido como se ainda estivesse acontecendo em qualquer conversa futura. Se o fato envolver uma data futura (aniversário, evento, prazo), sempre registre dia e mês por extenso (e ano se relevante) — nunca só o dia solto.",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "O fato em 3ª pessoa, curto e objetivo. Se for pontual/momentâneo (não duradouro), inclua a data em que aconteceu no próprio texto (ex: 'Em 7 de outubro, estava comemorando no bar com amigos'). Se envolver uma data futura marcada, inclua dia+mês completos." },
      },
      required: ["fact"],
    },
  },
};

const ENSINAR_REGRA_TOOL = {
  type: "function",
  function: {
    name: "ensinar_regra",
    description: "Guarda uma REGRA DE COMPORTAMENTO que a pessoa te ensinou explicitamente sobre como agir daqui pra frente (ex: 'Jarbas, aprenda que quando eu perguntar da agenda, quero só a agenda', 'a partir de agora, sempre X'). Diferente de guardar_memoria (fatos sobre a vida dela) — isso é uma instrução permanente sobre o SEU comportamento, que você deve seguir à risca em todas as conversas futuras. Chame sempre que ela disser algo no formato 'aprenda que...', 'lembra sempre de...', 'a partir de agora...', ou pedir explicitamente pra você mudar como faz algo.",
    parameters: {
      type: "object",
      properties: {
        regra: { type: "string", description: "A regra em 1 frase clara e objetiva, do jeito que deve ser seguida (ex: 'Quando ela perguntar sobre a agenda, responder só os compromissos, sem tarefas nem contas.')." },
      },
      required: ["regra"],
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
      "Registra no Diário do painel pessoal. Duas situações bem diferentes: (1) a pessoa PEDIU EXPLICITAMENTE pra anotar/registrar algo no diário (ex: 'anota no meu diário que...', 'adiciona no diário...') — nesse caso chame SEMPRE, sem julgar se o conteúdo é trivial ou não, mesmo que pareça banal (ex: horário de remédio, o que comeu) — a decisão de anotar já foi dela, não é sua; (2) a pessoa contou algo importante e duradouro por conta própria, sem pedir (um fato sobre a vida dela, um sentimento marcante, uma conquista, uma preocupação) — nesse caso, use seu próprio julgamento, só pra coisas que valem a pena ficar registradas. Em ambos os casos é uma ação de bastidor além de responder normalmente — não fale que anotou.",
    parameters: {
      type: "object",
      properties: {
        texto: { type: "string", description: "O texto a registrar. Se a pessoa pediu explicitamente, use exatamente o que ela pediu pra anotar." },
        humor: { type: "string", enum: ["otimo", "bom", "neutro", "ruim", "pessimo"], description: "O humor associado ao que foi contado, se der pra perceber." },
      },
      required: ["texto"],
    },
  },
};

const PAINEL_API_URL = "https://painel-controle-pearl.vercel.app/api/jarbas";

// Ações ligadas ao painel precisam ser confiáveis (não podem ficar de vez em quando
// no "engasgada" por uma falha transitória de rede entre o Worker e o Vercel) — tenta
// 2x, com timeout de 8s por tentativa, e loga o erro real quando desiste de verdade.
async function fetchPainelJson(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      if (!res.ok) throw new Error("painel_error_" + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.error(`painel_call_failed (tentativa ${attempt + 1}, ${url}):`, String(err?.message || err));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────
// F2-1 — Diário do Jarbas: registro de atividade. Usa a F2-0 (painel): grava
// via POST ?action=log_append, em lote, por fora da resposta (ctx.waitUntil)
// pra nunca atrasar a conversa. Uma falha ao registrar NUNCA pode quebrar
// nada — só console.error.
// ─────────────────────────────────────────────────────────────────────────
const LOG_BATCH_MAX = 50; // mesmo teto que o painel aceita por chamada (F2-0)

// `batch` é um array simples passado por referência entre as funções de uma
// mesma requisição/tick — cada chamada só empilha, nada é enviado até flushLogBatch.
function pushLogEvent(batch, { tipo, origem, resumo, detalhes, at }) {
  if (!Array.isArray(batch) || !tipo || !origem || !resumo) return;
  batch.push({
    at: at || new Date().toISOString(),
    tipo,
    origem,
    resumo: String(resumo).slice(0, 500),
    detalhes: detalhes && typeof detalhes === "object" ? detalhes : {},
  });
}

async function flushLogBatch(env, ctx, batch) {
  if (!Array.isArray(batch) || !batch.length || !env.PAINEL_API_KEY) return;
  const eventos = batch.splice(0, batch.length).slice(0, LOG_BATCH_MAX);
  const send = async () => {
    try {
      await fetchPainelJson(`${PAINEL_API_URL}?action=log_append`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-jarbas-key": env.PAINEL_API_KEY },
        body: JSON.stringify({ eventos }),
      });
    } catch (err) {
      console.error("log_append_failed:", String(err?.message || err));
    }
  };
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(send());
  else await send(); // scheduled() sempre tem ctx; isso é só rede de segurança
}

// Resumo curto e seguro dos argumentos de uma ferramenta, pro log — nunca o conteúdo
// bruto do resultado (que pode ter trecho de e-mail, texto de página etc.).
function summarizeToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  try {
    const json = JSON.stringify(args);
    return json.length > 200 ? json.slice(0, 200) + "…" : json;
  } catch {
    return "";
  }
}

async function callPainelSnapshot(env, dia) {
  const params = new URLSearchParams({ action: "snapshot" });
  if (dia) params.set("dia", dia);
  const data = await fetchPainelJson(`${PAINEL_API_URL}?${params.toString()}`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return data.texto || "Não consegui ler os dados do painel agora.";
}

async function callPainelAgenda(env, dia) {
  const params = new URLSearchParams({ action: "agenda" });
  if (dia) params.set("dia", dia);
  const data = await fetchPainelJson(`${PAINEL_API_URL}?${params.toString()}`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return data.texto || "Não consegui ler a agenda agora.";
}

async function callPainelCommand(env, comando, arg) {
  const data = await fetchPainelJson(PAINEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-jarbas-key": env.PAINEL_API_KEY },
    body: JSON.stringify({ comando, arg }),
  });
  return data.reply || "Feito.";
}

const TAREFA_ACAO_MAP = { criar: "criar_tarefa", concluir: "concluir_tarefa", apagar: "apagar_tarefa" };
const CONTA_ACAO_MAP = { pagar: "pagar_conta", apagar: "apagar_conta" };
const COMPROMISSO_ACAO_MAP = { criar: "criar_compromisso", apagar: "apagar_compromisso" };
const IDEIA_ACAO_MAP = { criar: "criar_ideia", apagar: "apagar_ideia" };
const LEMBRETE_ACAO_MAP = { criar: "criar_lembrete", concluir: "concluir_lembrete", apagar: "apagar_lembrete" };
const LISTA_ACAO_MAP = { criar: "criar_lista", apagar: "apagar_lista" };

async function callPainelTasks(env, filtro) {
  const data = await fetchPainelJson(`${PAINEL_API_URL}?action=tasks&filtro=${encodeURIComponent(filtro || "")}`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return data.texto || "Não consegui ler as tarefas agora.";
}

async function callPainelRead(env, action) {
  const data = await fetchPainelJson(`${PAINEL_API_URL}?action=${action}`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return data.texto || "Não consegui ler os dados do painel agora.";
}

function normalizeText(text) {
  return (text || "").toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Rede de segurança: quando o Groq falha de vez (rate limit, instabilidade), tenta
// responder os pedidos mais comuns direto no painel, sem precisar do LLM — mesma
// ideia do fallback por palavra-chave que o Pedro já usa. Só cobre os padrões que a
// pessoa disse precisar "sem erro" (agenda, tarefas, diário, contas); qualquer coisa
// fora disso continua caindo no aviso de "engasgada".
async function tryDeterministicFallback(env, userText) {
  if (!env.PAINEL_API_KEY) return null;
  const n = normalizeText(userText);
  if (!n) return null;

  try {
    if (/\bdiario\b/.test(n) && /\b(anota|anote|adiciona|adicione|registra|registre|escreve|escreva)\b/.test(n)) {
      const m = userText.match(/(?:anota|anote|adiciona|adicione|registra|registre|escreve|escreva)[^,:]*?(?:que|:)\s*(.+)/i);
      const texto = (m ? m[1] : userText).trim();
      if (texto) {
        await callPainelCommand(env, "anotar_diario", { texto });
        return "Anotei no diário.";
      }
    }
    if (/\bagenda\b|\bcompromisso/.test(n)) {
      const dia = /\bamanha\b/.test(n) ? "amanha" : "hoje";
      return await callPainelAgenda(env, dia);
    }
    if (/\btarefa/.test(n)) {
      let filtro = "";
      if (/\bandamento\b/.test(n)) filtro = "andamento";
      else if (/\bhoje\b|\bagora\b/.test(n)) filtro = "hoje";
      else if (/\bpendente/.test(n)) filtro = "pendentes";
      return await callPainelTasks(env, filtro);
    }
    if (/\bconta/.test(n)) {
      return await callPainelSnapshot(env, "hoje");
    }
  } catch (err) {
    console.error("deterministic_fallback_failed:", String(err?.message || err));
    return null;
  }
  return null;
}

// Atalhos configurados pela própria pessoa no painel (mem.shortcuts) — checados ANTES
// de chamar o Groq, pra pedidos que ela já sabe de antemão que quer resposta direta,
// sem gastar cota de IA e sem depender da compreensão do modelo pra frases exatas.
function matchUserShortcut(shortcuts, userText) {
  if (!Array.isArray(shortcuts) || !shortcuts.length) return null;
  const n = normalizeText(userText);
  if (!n) return null;
  for (const s of shortcuts) {
    const gatilho = normalizeText(s?.gatilho || "");
    if (gatilho && n.includes(gatilho)) return s;
  }
  return null;
}

async function resolveUserShortcut(env, shortcut) {
  switch (shortcut.acao) {
    case "agenda_hoje": return callPainelAgenda(env, "hoje");
    case "agenda_amanha": return callPainelAgenda(env, "amanha");
    case "tarefas_hoje": return callPainelTasks(env, "hoje");
    case "tarefas_pendentes": return callPainelTasks(env, "pendentes");
    case "tarefas_andamento": return callPainelTasks(env, "andamento");
    case "tarefas_geral": return callPainelTasks(env, "");
    case "contas": return callPainelSnapshot(env, "hoje");
    case "resposta_fixa": return shortcut.texto || "Ok.";
    default: return null;
  }
}

async function callPainelEmails(env, filtro, remetente, assunto) {
  const params = new URLSearchParams({ action: "emails" });
  if (filtro) params.set("filtro", filtro);
  if (remetente) params.set("remetente", remetente);
  if (assunto) params.set("assunto", assunto);
  const data = await fetchPainelJson(`${PAINEL_API_URL}?${params.toString()}`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return data.texto || "Não consegui ler os e-mails agora.";
}

async function callPainelRecados(env) {
  const data = await fetchPainelJson(`${PAINEL_API_URL}?action=recados`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return Array.isArray(data.recados) ? data.recados : [];
}

async function callPainelNovidades(env) {
  return fetchPainelJson(`${PAINEL_API_URL}?action=novidades`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
}

// ---------- Memória do Jarbas — armazenamento migrado do Cloudflare KV pro Postgres
// do painel (sync_kv, via api/jarbas.js), unificando numa fonte de verdade só. ----------
async function callPainelMemoryLoad(env) {
  const data = await fetchPainelJson(`${PAINEL_API_URL}?action=jarbas_memory`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY },
  });
  return data.data || null;
}

async function callPainelMemorySave(env, data) {
  await fetchPainelJson(PAINEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-jarbas-key": env.PAINEL_API_KEY },
    body: JSON.stringify({ comando: "jarbas_memory_save", arg: { data } }),
  });
}

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

// ---------- F2-1: compressão de observações (resultado de ferramenta grande demais) ----------
// Ideia inspirada no OpenJarvis (Apache 2.0, reimplementada do zero, não copiada): corte
// determinístico sempre disponível; resumo por LLM só pra ferramentas de texto longo, e só
// se passar de um limiar bem maior — nunca pra dados estruturados curtos tipo agenda/tarefas.
const COMPRESS_CUT_AT = 1500;
const COMPRESS_SUMMARIZE_AT = 4000;
const LONG_TEXT_TOOLS = new Set(["resumir_link", "buscar_na_web", "consultar_email"]);
const COMPRESS_SUMMARY_PROMPT = "Resuma o texto abaixo em português, mantendo os fatos, nomes e números mais importantes, em até 6 frases curtas. Não invente nada que não esteja no texto.";

function deterministicCut(text, limit = COMPRESS_CUT_AT) {
  if (text.length <= limit) return text;
  const omitido = text.length - limit;
  return `${text.slice(0, limit)}\n[+${omitido} caracteres omitidos]`;
}

// Devolve { content, compressed, method, originalLength } — content é o que vai pro
// modelo; os outros campos só alimentam o log (acao_pedida/leitura), nunca a fala.
async function compressObservation(env, toolName, text) {
  if (typeof text !== "string" || text.length <= COMPRESS_CUT_AT) {
    return { content: text, compressed: false };
  }
  if (text.length > COMPRESS_SUMMARIZE_AT && LONG_TEXT_TOOLS.has(toolName)) {
    try {
      const summary = (await callGroq(env, COMPRESS_SUMMARY_PROMPT, [{ role: "user", content: text.slice(0, 12000) }], 400)).trim();
      if (summary) return { content: summary, compressed: true, method: "resumo_llm", originalLength: text.length };
    } catch (err) {
      console.error(`compress_llm_summarize_failed (${toolName}):`, String(err?.message || err));
      // cai pro corte determinístico abaixo
    }
  }
  return { content: deterministicCut(text), compressed: true, method: "corte", originalLength: text.length };
}

// ---------- F2-1: guarda de laço (ideia do loop_guard do OpenJarvis, Apache 2.0,
// reimplementada do zero) — dentro de UMA requisição, nunca deixa a mesma ferramenta
// virar um loop: mesma chamada exata 2+ vezes, orçamento de 3 por nome de ferramenta,
// e padrão de "ping-pong" A-B-A-B entre duas chamadas distintas. ----------
class LoopGuard {
  constructor() {
    this.sigCounts = new Map();   // "nome|args" -> quantas vezes já tentou
    this.nameCounts = new Map();  // nome da ferramenta -> quantas vezes já executou
    this.sequence = [];           // ordem das assinaturas realmente executadas
    this.blockedOnce = new Set(); // nomes que já geraram um bloqueio (pra distinguir reincidência)
    this.events = [];             // { nivel: "guard"|"erro", motivo, ferramenta }
  }

  _pingPong() {
    const n = this.sequence.length;
    if (n < 4) return false;
    const [a, b, c, d] = this.sequence.slice(-4);
    return a === c && b === d && a !== b;
  }

  // Chamado ANTES de executar de verdade. "execute" = pode rodar; "block" = não roda,
  // devolve um conteúdo padrão no lugar pro modelo seguir em frente.
  check(name, argsStr) {
    const sig = `${name}|${argsStr}`;
    const sigCount = this.sigCounts.get(sig) || 0;
    if (sigCount >= 2) {
      this.events.push({ nivel: "guard", motivo: "mesma_chamada_repetida", ferramenta: name });
      return { action: "block", reason: "mesma_chamada_repetida", sig };
    }
    const nameCount = this.nameCounts.get(name) || 0;
    if (nameCount >= 3) {
      const reincidencia = this.blockedOnce.has(name);
      this.blockedOnce.add(name);
      this.events.push({ nivel: reincidencia ? "erro" : "guard", motivo: "orcamento_ferramenta_excedido", ferramenta: name });
      return { action: "block", reason: "orcamento_excedido", sig };
    }
    if (this._pingPong()) {
      this.events.push({ nivel: "erro", motivo: "padrao_a_b_a_b", ferramenta: name });
      return { action: "block", reason: "padrao_a_b_a_b", sig };
    }
    return { action: "execute", reason: null, sig };
  }

  // Chamado DEPOIS de uma execução real (nunca pra uma chamada bloqueada).
  record(name, argsStr) {
    const sig = `${name}|${argsStr}`;
    this.sigCounts.set(sig, (this.sigCounts.get(sig) || 0) + 1);
    this.nameCounts.set(name, (this.nameCounts.get(name) || 0) + 1);
    this.sequence.push(sig);
  }
}

// ---------- F2-1: registro mínimo de agentes (estrutura pronta pra "vigia" e "briefing"
// entrarem depois, modo "agendado" — sem mudar nada do comportamento atual). ----------
const AGENTS = {
  conversa: {
    id: "conversa",
    modo: "sob_demanda",
    ferramentasPermitidas: null, // null = decidido dinamicamente (selectToolsForMessage/buildAllTools), como hoje
    maxChamadasLLM: 3,
    maxFerramentas: 3,
  },
};

// Classifica cada ferramenta como "leitura" (consulta) ou "acao_pedida" (muda algo),
// pro tipo certo no log de atividade.
const TOOL_KIND = {
  previsao_do_tempo: "leitura", buscar_na_web: "leitura", consultar_painel: "leitura",
  consultar_agenda: "leitura", consultar_tarefas: "leitura", consultar_ideias: "leitura",
  consultar_lembretes: "leitura", consultar_listas: "leitura", consultar_recados: "leitura",
  consultar_email: "leitura", resumir_link: "leitura",
  gerenciar_tarefa: "acao_pedida", gerenciar_conta: "acao_pedida", gerenciar_compromisso: "acao_pedida",
  anotar_no_diario: "acao_pedida", gerenciar_ideia: "acao_pedida", gerenciar_lembrete: "acao_pedida",
  gerenciar_lista: "acao_pedida", concluir_recado: "acao_pedida", guardar_memoria: "acao_pedida", ensinar_regra: "acao_pedida",
};

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
    if (name === "consultar_painel" && canPainel) return { content: await callPainelSnapshot(env, args.dia || "") };
    if (name === "consultar_agenda" && canPainel) return { content: await callPainelAgenda(env, args.dia || "") };
    if (name === "gerenciar_tarefa" && canPainel) return { content: await callPainelCommand(env, TAREFA_ACAO_MAP[args.acao], { texto: args.texto }) };
    if (name === "gerenciar_conta" && canPainel) return { content: await callPainelCommand(env, CONTA_ACAO_MAP[args.acao], { nome: args.nome }) };
    if (name === "gerenciar_compromisso" && canPainel) return { content: await callPainelCommand(env, COMPROMISSO_ACAO_MAP[args.acao], { titulo: args.titulo, data: args.data, hora: args.hora }) };
    if (name === "anotar_no_diario" && canPainel) {
      await callPainelCommand(env, "anotar_diario", { texto: args.texto, humor: args.humor });
      return { content: "Anotado no diário (não fale sobre essa anotação, é de bastidor)." };
    }
    if (name === "consultar_tarefas" && canPainel) return { content: await callPainelTasks(env, args.filtro || "") };
    if (name === "consultar_ideias" && canPainel) return { content: await callPainelRead(env, "ideias") };
    if (name === "gerenciar_ideia" && canPainel) return { content: await callPainelCommand(env, IDEIA_ACAO_MAP[args.acao], { texto: args.texto }) };
    if (name === "consultar_lembretes" && canPainel) return { content: await callPainelRead(env, "lembretes") };
    if (name === "gerenciar_lembrete" && canPainel) return { content: await callPainelCommand(env, LEMBRETE_ACAO_MAP[args.acao], { texto: args.texto }) };
    if (name === "consultar_listas" && canPainel) return { content: await callPainelRead(env, "listas") };
    if (name === "gerenciar_lista" && canPainel) return { content: await callPainelCommand(env, LISTA_ACAO_MAP[args.acao], { titulo: args.titulo }) };
    if (name === "consultar_recados" && canPainel) {
      const recados = await callPainelRecados(env);
      if (!recados.length) return { content: "Nenhum recado pendente." };
      return { content: recados.map((r) => `- ${r.text}`).join("\n") };
    }
    if (name === "concluir_recado" && canPainel) {
      await callPainelCommand(env, "concluir_recado", { texto: args.texto });
      return { content: "Recado marcado como tratado (não fale sobre essa ação, é de bastidor)." };
    }
    if (name === "consultar_email" && canPainel) return { content: await callPainelEmails(env, args.filtro || "", args.remetente || "", args.assunto || "") };
    if (name === "guardar_memoria") {
      const fact = (args.fact || "").trim();
      if (!fact) return { content: "Fato vazio, nada guardado." };
      return { content: "Guardado (não fale sobre essa anotação, é de bastidor).", memoryFact: fact };
    }
    if (name === "ensinar_regra") {
      const regra = (args.regra || "").trim();
      if (!regra) return { content: "Regra vazia, nada guardado." };
      return { content: "Regra guardada, vou seguir isso daqui pra frente.", learnedRule: regra };
    }
    if (name === "resumir_link") {
      const url = (args.url || "").trim();
      if (!url) return { content: "Não veio nenhuma URL — peça pra pessoa repetir o endereço completo." };
      return { content: await fetchLinkExcerpt(url) };
    }
    return { content: "Ferramenta indisponível." };
  } catch (err) {
    console.error(`runTool_failed (${name}):`, String(err?.message || err));
    return { content: `A consulta falhou: ${String(err.message || err)}` };
  }
}

// Conjunto completo de ferramentas (comportamento de antes) — usado quando nenhuma
// intenção bate por palavra-chave (conjunto mínimo não se aplica a ela) e como
// contingência de reenvio, se o modelo pedir uma ferramenta fora do subconjunto.
function buildAllTools(canSearch, canPainel) {
  const tools = [WEATHER_TOOL, GUARDAR_MEMORIA_TOOL, ENSINAR_REGRA_TOOL, RESUMIR_LINK_TOOL];
  if (canSearch) tools.push(SEARCH_TOOL);
  if (canPainel) {
    tools.push(
      CONSULTAR_PAINEL_TOOL, CONSULTAR_AGENDA_TOOL, GERENCIAR_TAREFA_TOOL, GERENCIAR_CONTA_TOOL, GERENCIAR_COMPROMISSO_TOOL, ANOTAR_DIARIO_TOOL,
      CONSULTAR_TAREFAS_TOOL, CONSULTAR_IDEIAS_TOOL, GERENCIAR_IDEIA_TOOL, CONSULTAR_LEMBRETES_TOOL, GERENCIAR_LEMBRETE_TOOL,
      CONSULTAR_LISTAS_TOOL, GERENCIAR_LISTA_TOOL, CONSULTAR_RECADOS_TOOL, CONCLUIR_RECADO_TOOL, CONSULTAR_EMAIL_TOOL
    );
  }
  return tools;
}

// Subconjunto de ferramentas por intenção, via regra simples de palavras-chave sobre o
// último texto do usuário — evita mandar as ~20 ferramentas em toda chamada, mesmo em
// papo casual. guardar_memoria/ensinar_regra sempre entram; se nada casar, conjunto
// mínimo (memória/regra + consultar_painel). Isso é uma heurística, não entendimento
// de linguagem — por isso callGroqWithSearch reenvia com o conjunto completo se o
// modelo pedir uma ferramenta que não foi incluída aqui.
function selectToolsForMessage(userText, canSearch, canPainel) {
  const n = normalizeText(userText);
  const selected = new Set([GUARDAR_MEMORIA_TOOL, ENSINAR_REGRA_TOOL]);
  let matchedAny = false;
  const add = (...toolsToAdd) => { toolsToAdd.forEach((t) => selected.add(t)); matchedAny = true; };

  if (canPainel && /\b(agenda|compromisso)/.test(n)) add(CONSULTAR_PAINEL_TOOL, CONSULTAR_AGENDA_TOOL, GERENCIAR_COMPROMISSO_TOOL);
  if (canPainel && /\btarefa/.test(n)) add(CONSULTAR_PAINEL_TOOL, CONSULTAR_TAREFAS_TOOL, GERENCIAR_TAREFA_TOOL);
  if (canPainel && /\bconta(s)?\b/.test(n)) add(CONSULTAR_PAINEL_TOOL, GERENCIAR_CONTA_TOOL);
  if (canPainel && /\bdiari/.test(n)) add(ANOTAR_DIARIO_TOOL);
  if (canPainel && /\bideia/.test(n)) add(CONSULTAR_IDEIAS_TOOL, GERENCIAR_IDEIA_TOOL);
  if (canPainel && /\blembret/.test(n)) add(CONSULTAR_LEMBRETES_TOOL, GERENCIAR_LEMBRETE_TOOL);
  if (canPainel && /\blista/.test(n)) add(CONSULTAR_LISTAS_TOOL, GERENCIAR_LISTA_TOOL);
  if (canPainel && (n.includes("email") || n.includes("e mail") || n.includes("caixa de entrada"))) add(CONSULTAR_EMAIL_TOOL);
  if (canPainel && /\brecado/.test(n)) add(CONSULTAR_RECADOS_TOOL, CONCLUIR_RECADO_TOOL);
  if (/\b(clima|tempo|chuva|previsao)\b/.test(n)) add(WEATHER_TOOL);
  if (canSearch && /\b(pesquis|busca|noticia)/.test(n)) add(SEARCH_TOOL);
  if (n.includes("http") || n.includes("www") || /\blink/.test(n)) add(RESUMIR_LINK_TOOL);

  if (!matchedAny && canPainel) selected.add(CONSULTAR_PAINEL_TOOL);
  return Array.from(selected);
}

async function callGroqWithSearch(env, systemPrompt, messages, maxTokens, companionState = {}, logBatch = null) {
  const baseMessages = [{ role: "system", content: systemPrompt }, ...messages];
  const canSearch = !!env.TAVILY_API_KEY;
  const canPainel = !!env.PAINEL_API_KEY;
  const lastUserText = messages[messages.length - 1]?.content || "";

  let tools = selectToolsForMessage(lastUserText, canSearch, canPainel);
  let callCount = 0;
  let providerUsed = null;
  let totalLatencyMs = 0;
  // Dedupe de ferramenta de escrita por assinatura (nome+args), válido pra requisição
  // inteira (não só dentro de uma resposta) — nenhuma retentativa aqui re-executa uma
  // ferramenta já executada, só reaproveita o resultado guardado.
  const executed = new Map();
  const guard = new LoopGuard();
  const toolsUsed = [];

  const timedGroqRequest = async (msgs, tok, tls) => {
    const t0 = Date.now();
    const res = await groqRequest(env, msgs, tok, tls);
    totalLatencyMs += Date.now() - t0;
    return res;
  };

  const metrics = () => ({ llmCalls: callCount, provider: providerUsed, latencyMs: totalLatencyMs, toolsUsed, guardEvents: guard.events });
  const logCalls = (extra = "") => console.log(`companion_llm_calls total=${callCount} provider=${providerUsed}${extra}`);

  callCount++;
  let first = await timedGroqRequest(baseMessages, maxTokens, tools);
  providerUsed = first._provider;
  let msg = first.choices?.[0]?.message;

  if (msg?.tool_calls?.length) {
    // O modelo só deveria pedir ferramentas que foram oferecidas, mas o prompt de
    // personalidade descreve todas as capacidades em prosa — se ele "lembrar" de uma
    // ferramenta fora do subconjunto enviado, reenvia UMA vez com o conjunto completo.
    const offeredNames = new Set(tools.map((t) => t.function.name));
    const needsFullSet = msg.tool_calls.some((c) => !offeredNames.has(c.function.name));
    if (needsFullSet) {
      tools = buildAllTools(canSearch, canPainel);
      callCount++;
      first = await timedGroqRequest(baseMessages, maxTokens, tools);
      providerUsed = first._provider;
      msg = first.choices?.[0]?.message;
    }
  }

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
    }).slice(0, AGENTS.conversa.maxFerramentas);
    const toolMessages = [];
    let saveMemory = null;
    let saveLearned = null;
    for (const call of calls) {
      const name = call.function.name;
      const argsStr = call.function.arguments;
      const sig = name + "|" + argsStr;
      let result = executed.get(sig);
      if (!result) {
        const verdict = guard.check(name, argsStr);
        if (verdict.action === "block") {
          result = { content: "Você já tentou isso algumas vezes nesta conversa sem sucesso — não tente de novo, use o que já sabe." };
          pushLogEvent(logBatch, { tipo: "erro", origem: "jarbas", resumo: `Guarda de laço bloqueou "${name}" (${verdict.reason}).`, detalhes: { ferramenta: name, motivo: verdict.reason } });
        } else {
          result = await runTool(env, call, canSearch, canPainel, companionState);
          guard.record(name, argsStr);
        }
        executed.set(sig, result);

        if (verdict?.action !== "block") {
          const ok = !String(result.content || "").startsWith("A consulta falhou:");
          // Comprime o resultado ANTES de guardar/mandar pro modelo — nunca o bruto
          // se passar do limite (corte determinístico, ou resumo por LLM nos casos de
          // texto longo). O que entra no log é só o resumo do que a ferramenta fez.
          const compressedResult = await compressObservation(env, name, result.content);
          result = { ...result, content: compressedResult.content };
          executed.set(sig, result);

          const kind = TOOL_KIND[name] || "acao_pedida";
          toolsUsed.push(name);
          if (name === "consultar_email") {
            // Nunca loga o conteúdo retornado (pode ter trecho do e-mail) — só os
            // parâmetros da busca, como pedido ("somente remetente e assunto").
            let args = {}; try { args = JSON.parse(argsStr); } catch {}
            pushLogEvent(logBatch, { tipo: "leitura", origem: "jarbas", resumo: `Consultou e-mails (filtro: ${args.filtro || "recentes"}${args.remetente ? `, de ${args.remetente}` : ""}${args.assunto ? `, assunto: ${args.assunto}` : ""}).` });
          } else if (name === "resumir_link") {
            let args = {}; try { args = JSON.parse(argsStr); } catch {}
            // "Título" aproximado: primeiro trecho do conteúdo já buscado (sem título de
            // verdade disponível) — só isso vai pro log, nunca o conteúdo completo da página.
            const tituloAprox = String(result.content || "").replace(/^Conteúdo de [^:]+:\s*/, "").slice(0, 80).trim();
            pushLogEvent(logBatch, { tipo: "leitura", origem: "jarbas", resumo: `Resumiu link: ${args.url || ""}${tituloAprox ? ` — "${tituloAprox}…"` : ""}` });
          } else {
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(argsStr || "{}"); } catch { /* args malformado — loga sem detalhe */ }
            pushLogEvent(logBatch, {
              tipo: kind, origem: "jarbas",
              resumo: `${kind === "leitura" ? "Consultou" : "Executou"} "${name}" (${summarizeToolArgs(parsedArgs)}).`,
              detalhes: { ferramenta: name, ok, comprimido: compressedResult.compressed, metodo: compressedResult.method, tamanho_original: compressedResult.originalLength },
            });
          }
        }
      }
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      if (result.memoryFact) saveMemory = result.memoryFact;
      if (result.learnedRule) saveLearned = result.learnedRule;
    }

    const followUp = [
      ...baseMessages,
      { role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls },
      ...toolMessages,
    ];

    // Dali em diante, as ferramentas já rodaram — qualquer nova tentativa (resposta
    // vazia ou erro na chamada) só repete a chamada que gera a FALA, reaproveitando
    // toolMessages. Ferramenta de escrita nunca roda de novo nesta requisição.
    const retrySpeech = async () => {
      callCount++;
      const retry = await timedGroqRequest([
        ...followUp,
        { role: "user", content: "Responda agora, em uma frase curta e falada, com o resultado acima." },
      ], Math.max(maxTokens, 400));
      providerUsed = retry._provider;
      return retry.choices?.[0]?.message?.content?.trim() || "Consegui a informação, mas me perdi na hora de falar. Pode perguntar de novo?";
    };

    try {
      callCount++;
      const second = await timedGroqRequest(followUp, Math.max(maxTokens, 400));
      providerUsed = second._provider;
      const secondContent = second.choices?.[0]?.message?.content?.trim();
      if (secondContent) {
        logCalls();
        return { text: secondContent, saveMemory, saveLearned, metrics: metrics() };
      }
      // Modelo devolveu vazio depois da ferramenta — tenta mais uma vez, sem margem pra ele "pensar" demais
      const text = await retrySpeech();
      logCalls();
      return { text, saveMemory, saveLearned, metrics: metrics() };
    } catch (err) {
      console.error("callGroqWithSearch_second_call_failed, repetindo só a fala:", String(err?.message || err));
      pushLogEvent(logBatch, { tipo: "erro", origem: "jarbas", resumo: "Segunda chamada ao LLM falhou, repetindo só a fala.", detalhes: { erro: String(err?.message || err).slice(0, 200) } });
      const text = await retrySpeech();
      logCalls();
      return { text, saveMemory, saveLearned, metrics: metrics() };
    }
  }

  logCalls();
  return { text: msg?.content?.trim() || "Só um instante, deixa eu organizar o pensamento — pode repetir?", saveMemory: null, saveLearned: null, metrics: metrics() };
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

function saoPauloNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { dateStr: `${get("year")}-${get("month")}-${get("day")}`, dayOfMonth: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")) };
}

// ---------- F2-1: gatilhos DETERMINÍSTICOS (sem IA) pro cron — só chama o LLM se algum
// destes já apontou que há algo real pra avisar. ----------
function computeDeterministicTriggers(mudancas) {
  const triggers = [];
  if (!mudancas) return triggers;
  const { dayOfMonth } = saoPauloNow();

  for (const c of (mudancas.contas?.itens || [])) {
    if (c.status !== "pendente" || !c.data) continue;
    const dueDay = parseInt(c.data, 10);
    if (!Number.isFinite(dueDay)) continue;
    if (dueDay <= dayOfMonth) {
      triggers.push({ tipo: "conta", id: String(c.id), texto: `Conta "${c.titulo}" ${dueDay < dayOfMonth ? "está atrasada" : "vence hoje"}.` });
    }
  }

  const umDiaAtrasMs = Date.now() - 24 * 60 * 60 * 1000;
  for (const t of (mudancas.tarefas?.itens || [])) {
    // "parada" é aproximado pela data de CRIAÇÃO da tarefa, já que o painel não guarda
    // quando ela entrou na coluna "now" — melhor sinal disponível sem mexer no painel.
    if (t.status !== "now" || !t.data) continue;
    const criadaMs = new Date(t.data).getTime();
    if (Number.isFinite(criadaMs) && criadaMs < umDiaAtrasMs) {
      triggers.push({ tipo: "tarefa", id: String(t.id), texto: `Tarefa "${t.titulo}" está parada em Para Agora.` });
    }
  }
  return triggers;
}

// A ação "mudancas" (F2-0) não traz o horário dos compromissos (só a data), então pra
// "próximos 30 min" reaproveita o endpoint de texto da agenda (já existia antes da F2-0,
// não precisa de nenhuma mudança no painel) e faz um parse simples do formato conhecido
// ("HH:MM Título; HH:MM Título"), em vez de inventar outro endpoint.
async function checkAgendaProximosGatilhos(env) {
  try {
    const texto = await callPainelAgenda(env, "hoje");
    const matches = [...texto.matchAll(/(\d{2}:\d{2})\s+([^;]+)/g)];
    if (!matches.length) return [];
    const { hour, minute } = saoPauloNow();
    const agoraMin = hour * 60 + minute;
    const triggers = [];
    for (const [, hhmm, tituloRaw] of matches) {
      const titulo = tituloRaw.trim();
      const [h, m] = hhmm.split(":").map(Number);
      const diffMin = (h * 60 + m) - agoraMin;
      if (diffMin >= 0 && diffMin <= 30) {
        triggers.push({ tipo: "agenda", id: `${hhmm}-${titulo}`, texto: `Compromisso "${titulo}" começa às ${hhmm}.` });
      }
    }
    return triggers;
  } catch (err) {
    console.error("cron_agenda_check_failed:", String(err?.message || err));
    return [];
  }
}

const NOTIFICATION_PHRASE_PROMPT = `Você é o Jarbas, um companheiro de voz caloroso. Os avisos abaixo já foram verificados (são fatos reais, confirmados sem você) — sua única tarefa é redigir UMA notificação curta e natural, no seu jeito de falar, juntando tudo numa frase só se houver mais de um item. Responda em JSON puro, numa única linha, sem markdown, exatamente: {"title":"título curto","body":"texto curto e natural, no máximo 1-2 frases, como você falaria"}. Nunca invente nada além do que está listado.`;

async function phraseNotification(env, gatilhos) {
  const listaTexto = gatilhos.map((g) => `- ${g.texto}`).join("\n");
  try {
    const raw = await callGroq(env, NOTIFICATION_PHRASE_PROMPT, [{ role: "user", content: listaTexto }], 200);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed?.title && parsed?.body) return { title: parsed.title, body: parsed.body };
  } catch (err) {
    console.error("cron_phrase_llm_failed, usando texto padrão:", String(err?.message || err));
  }
  // Fallback determinístico (sem LLM) — a pessoa nunca fica sem o aviso só porque o
  // modelo falhou na hora de deixá-lo mais bonito.
  const primeiro = gatilhos[0];
  const body = gatilhos.length === 1 ? primeiro.texto : `${gatilhos.length} coisas pra você ver: ${gatilhos.map((g) => g.texto).join(" ")}`;
  return { title: "Jarbas", body };
}

// Deterministic primeiro, LLM só se houver gatilho de verdade — é isso que zera o
// gasto de cota em dias calmos (antes, chamava o LLM em TODO tick, sem condição nenhuma).
async function decideNotification(env, logBatch, mudancas, cronMetrics) {
  const gatilhos = [...computeDeterministicTriggers(mudancas), ...(await checkAgendaProximosGatilhos(env))];
  if (!gatilhos.length) return null;

  const signature = gatilhos.map((g) => `${g.tipo}:${g.id}`).sort().join("|");
  const previousRaw = await env.COMPANION_KV.get(PUSH_NOTIFY_STATE_KEY);
  const previous = previousRaw ? JSON.parse(previousRaw) : { lastSignature: "", notifiedAt: 0 };
  if (previous.lastSignature === signature && Date.now() - previous.notifiedAt < PUSH_DEDUPE_MS) {
    return null;
  }

  if (cronMetrics) cronMetrics.llmCalls++;
  const notification = await phraseNotification(env, gatilhos);
  await env.COMPANION_KV.put(PUSH_NOTIFY_STATE_KEY, JSON.stringify({ lastSignature: signature, notifiedAt: Date.now() }));
  pushLogEvent(logBatch, { tipo: "aviso_enviado", origem: "cron", resumo: notification.body, detalhes: { gatilhos: gatilhos.map((g) => g.tipo) } });
  return notification;
}

// ---------- Item 5: comentário espontâneo sobre Ideias/Compromissos novos ----------
// Já era econômico antes (só chama o LLM se achar novidade de verdade) — mantido, só
// ganhou logging de atividade e o contador compartilhado de chamadas do tick.
const SPONTANEOUS_STATE_KEY = "push:spontaneous_state";

const SPONTANEOUS_COMMENT_PROMPT = `Você é Jarbas, um companheiro de voz caloroso e afetuoso, amigo próximo da pessoa. Ela acabou de registrar algo novo no painel pessoal dela (uma ideia ou um compromisso), descrito abaixo. Decida se vale a pena comentar isso espontaneamente com ela, como um amigo faria de leve — uma reação curta, uma pergunta genuína, um incentivo.

Se não for algo que mereça um comentário espontâneo (é banal, técnico, ou não há nada de interessante a dizer), responda exatamente: {"comment":false}

Se valer a pena comentar, responda em JSON puro, numa única linha, sem markdown: {"comment":true,"title":"título curto pra notificação","body":"o comentário em si, breve e caloroso, no máximo 1 frase"}

Nunca invente informação que não esteja no que foi registrado abaixo.`;

async function decideSpontaneousComment(env, logBatch, cronMetrics) {
  let novelty;
  try {
    novelty = await callPainelNovidades(env);
  } catch {
    return null;
  }

  const previousRaw = await env.COMPANION_KV.get(SPONTANEOUS_STATE_KEY);
  const previous = previousRaw ? JSON.parse(previousRaw) : { lastIdeaId: 0, lastEventId: 0 };

  const ideas = Array.isArray(novelty.ideas) ? novelty.ideas : [];
  const events = Array.isArray(novelty.events) ? novelty.events : [];
  const newIdea = ideas.find((i) => (i.id || 0) > previous.lastIdeaId);
  const newEvent = events.find((e) => (e.id || 0) > previous.lastEventId);

  const newestIdeaId = Math.max(previous.lastIdeaId, 0, ...ideas.map((i) => i.id || 0));
  const newestEventId = Math.max(previous.lastEventId, 0, ...events.map((e) => e.id || 0));
  // Atualiza o "já visto" antes de decidir — cada novidade é considerada uma vez só,
  // comentada ou não, pra nunca repetir aviso sobre a mesma coisa.
  await env.COMPANION_KV.put(SPONTANEOUS_STATE_KEY, JSON.stringify({ lastIdeaId: newestIdeaId, lastEventId: newestEventId }));

  if (!newIdea && !newEvent) return null;
  const content = newIdea
    ? `Ideia nova registrada: "${newIdea.text}"`
    : `Compromisso novo criado: "${newEvent.title}" em ${newEvent.date}`;

  if (cronMetrics) cronMetrics.llmCalls++;
  const raw = await callGroq(env, SPONTANEOUS_COMMENT_PROMPT, [{ role: "user", content }], 200);
  const clean = raw.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return null;
  }
  if (!parsed || !parsed.comment || !parsed.title || !parsed.body) return null;
  pushLogEvent(logBatch, { tipo: "acao_espontanea", origem: "cron", resumo: parsed.body, detalhes: { sobre: newIdea ? "ideia" : "compromisso" } });
  return { title: parsed.title, body: parsed.body };
}

// ---------- F2-1: observação do painel, sem IA — compara o snapshot compacto (F2-0,
// ?action=mudancas) com o último "digest" conhecido (id -> hash por fonte, guardado no
// KV existente). Primeira execução: só grava o estado, nunca gera uma avalanche de
// eventos. Dali em diante, cada novo/alterado/removido vira um evento "observacao_painel". ----------
const PAINEL_DIGEST_KEY = "painel:digest:v1";
const FONTE_LABELS = { tarefas: "Tarefa", contas: "Conta", agenda: "Compromisso", ideias: "Ideia", lembretes: "Lembrete", listas: "Lista", diario: "Diário", recados: "Recado" };

// Pura (sem KV, sem rede) — fácil de testar isolada. `previous` é o digest salvo da
// última vez (ou null na primeira execução) e `mudancas` é a resposta de
// ?action=mudancas (F2-0). Devolve o novo digest + um evento por item novo/
// alterado/removido (vazio na primeira execução, de propósito).
function diffPainelDigest(previous, mudancas) {
  const isFirstRun = !previous;
  const current = {};
  const changedSources = [];
  const events = [];

  for (const fonte of Object.keys(FONTE_LABELS)) {
    const itens = mudancas?.[fonte]?.itens || [];
    const prevMap = previous?.[fonte] || {};
    const curMap = {};
    for (const item of itens) curMap[String(item.id)] = item.hash;
    current[fonte] = curMap;
    if (isFirstRun) continue;

    let sourceChanged = false;
    for (const item of itens) {
      const prevHash = prevMap[String(item.id)];
      if (prevHash === undefined) {
        sourceChanged = true;
        events.push({ tipo: "observacao_painel", origem: "painel", resumo: `${FONTE_LABELS[fonte]} nova: "${item.titulo}"${item.status ? ` (${item.status})` : ""}` });
      } else if (prevHash !== item.hash) {
        sourceChanged = true;
        events.push({ tipo: "observacao_painel", origem: "painel", resumo: `${FONTE_LABELS[fonte]} alterada: "${item.titulo}"${item.status ? ` → ${item.status}` : ""}` });
      }
    }
    const curIds = new Set(itens.map((i) => String(i.id)));
    for (const id of Object.keys(prevMap)) {
      if (!curIds.has(id)) {
        sourceChanged = true;
        events.push({ tipo: "observacao_painel", origem: "painel", resumo: `${FONTE_LABELS[fonte]} removida (id ${id}).` });
      }
    }
    if (sourceChanged) changedSources.push(fonte);
  }

  return { isFirstRun, current, changedSources, events };
}

async function observePainelChanges(env, mudancas, logBatch) {
  const previousRaw = await env.COMPANION_KV.get(PAINEL_DIGEST_KEY);
  const previous = previousRaw ? JSON.parse(previousRaw) : null;
  const { isFirstRun, current, changedSources, events } = diffPainelDigest(previous, mudancas);
  for (const ev of events) pushLogEvent(logBatch, ev);
  await env.COMPANION_KV.put(PAINEL_DIGEST_KEY, JSON.stringify(current));
  return { isFirstRun, changedSources };
}

async function runScheduledPush(env, ctx) {
  if (!env.COMPANION_KV || !env.PAINEL_API_KEY) return;

  const logBatch = [];
  const cronMetrics = { llmCalls: 0 };

  // Observação do painel (item 2, sem IA) — roda sempre que o painel estiver
  // configurado, mesmo sem push ainda, pra já alimentar o Diário do Jarbas.
  let mudancas = null;
  try {
    mudancas = await fetchPainelJson(`${PAINEL_API_URL}?action=mudancas`, { headers: { "x-jarbas-key": env.PAINEL_API_KEY } });
  } catch (err) {
    console.error("cron_mudancas_failed:", String(err?.message || err));
  }
  if (mudancas) {
    try {
      await observePainelChanges(env, mudancas, logBatch);
    } catch (err) {
      console.error("cron_observe_failed:", String(err?.message || err));
    }
  }

  let notification = null;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    const subRaw = await env.COMPANION_KV.get(PUSH_SUBSCRIPTION_KEY);
    if (subRaw) {
      let subscription = null;
      try { subscription = JSON.parse(subRaw); } catch { subscription = null; }
      if (subscription) {
        try {
          // No máximo um push por tick: prioriza um comentário espontâneo sobre
          // novidade (ideia/compromisso novo) se houver; senão cai no aviso
          // determinístico de agenda/tarefa/conta. Ambos só chamam o LLM se
          // tiverem achado algo de verdade — em dia calmo, cronMetrics.llmCalls fica 0.
          notification = (await decideSpontaneousComment(env, logBatch, cronMetrics))
            || (await decideNotification(env, logBatch, mudancas, cronMetrics));
        } catch (err) {
          console.error("cron_decide_failed:", String(err?.message || err));
        }
        if (notification) {
          try {
            await sendWebPush(env, subscription, notification);
          } catch (err) {
            console.error("push_send_failed", err);
            pushLogEvent(logBatch, { tipo: "erro", origem: "cron", resumo: `Falha ao enviar push: ${String(err.message || err).slice(0, 200)}` });
          }
        }
      }
    }
  }

  // Visibilidade de quanto o cron gastou de LLM hoje (meta: perto de zero em dia
  // calmo) — contador simples por dia no mesmo KV, sem inventar um tipo de evento
  // novo no Diário (o enum do painel não tem "métrica"; os eventos de aviso/ação já
  // carregam o detalhe de quantas chamadas custaram, no campo `detalhes`).
  try {
    const dayKey = `cron:llm_usage:${saoPauloNow().dateStr}`;
    const prev = Number(await env.COMPANION_KV.get(dayKey)) || 0;
    const total = prev + cronMetrics.llmCalls;
    if (cronMetrics.llmCalls > 0) {
      await env.COMPANION_KV.put(dayKey, String(total), { expirationTtl: 3 * 24 * 60 * 60 });
    }
    console.log(`cron_llm_usage tick=${cronMetrics.llmCalls} today=${total}`);
  } catch (err) {
    console.error("cron_llm_usage_record_failed:", String(err?.message || err));
  }

  await flushLogBatch(env, ctx, logBatch);
}

export default {
  async fetch(request, env, ctx) {
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

    // ---- memória do Jarbas: migrada do Cloudflare KV pro Postgres do painel (sync_kv) ----
    // Migração automática e única: se o Postgres ainda não tiver nada salvo mas existir
    // o dado antigo no Cloudflare KV (companion:main), ele é lido de lá, escrito no
    // Postgres, e passa a ser a fonte de verdade dali em diante -- nunca reseta nem
    // perde o que já existia, e o dado antigo no KV nunca é apagado (fica como backup).
    if (mode === "memory_load" || mode === "memory_save") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      if (!env.PAINEL_API_KEY) {
        return json({ error: "painel_not_configured" }, 500);
      }

      if (mode === "memory_load") {
        try {
          let data = await callPainelMemoryLoad(env);
          if (!data && env.COMPANION_KV) {
            const legacyRaw = await env.COMPANION_KV.get("companion:main");
            if (legacyRaw) {
              try {
                data = JSON.parse(legacyRaw);
                await callPainelMemorySave(env, data);
              } catch {}
            }
          }
          return json({ data: data || { memory: "", history: [], msgCount: 0 } });
        } catch (err) {
          return json({ error: "memory_load_failed", detail: String(err.message || err) }, 502);
        }
      }

      // memory_save
      try {
        await callPainelMemorySave(env, body.data || {});
        return json({ ok: true });
      } catch (err) {
        return json({ error: "memory_save_failed", detail: String(err.message || err) }, 502);
      }
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

    // ---- voz unificada: Azure AI Speech (oficial) é o provedor principal; se faltar
    // configuração ou falhar (401/403/404 chave/região inválida, 429/5xx transitório,
    // timeout), cai pro Edge TTS (não-oficial) como reserva — e se os dois falharem,
    // o app já cai pra voz nativa do navegador por conta própria. ----
    if (mode === "tts") {
      if (!body.text) return json({ error: "text_required" }, 400);
      const canAzure = !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);
      if (canAzure) {
        try {
          const audio_b64 = await synthesizeAzureTts(env, body.text);
          return json({ audio_b64, provider: "azure" });
        } catch (err) {
          console.error("azure_tts_failed, caindo pro Edge TTS:", String(err?.message || err));
          const ttsLog = [];
          pushLogEvent(ttsLog, { tipo: "erro", origem: "jarbas", resumo: "Voz caiu pro Edge TTS (Azure falhou).", detalhes: { erro: String(err?.message || err).slice(0, 200) } });
          flushLogBatch(env, ctx, ttsLog);
        }
      }
      try {
        const audio_b64 = await synthesizeEdgeTts(body.text);
        return json({ audio_b64, provider: "edge" });
      } catch (err) {
        const ttsLog = [];
        pushLogEvent(ttsLog, { tipo: "erro", origem: "jarbas", resumo: "Voz caiu pra reserva do navegador (Azure e Edge TTS falharam).", detalhes: { erro: String(err?.message || err).slice(0, 200) } });
        flushLogBatch(env, ctx, ttsLog);
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
        const timelineText = timelineToBulletText(body.timeline);
        const raw = await callGroq(env, SUMMARY_PROMPT_HEADER(body.existingMemory || "", body.existingSobreJarbas || "", timelineText, todayLabelPtBR()), plain, 350);
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
        // Não carimba mais as mensagens do histórico com "[dia hora]" — isso vazava pra
        // fala do Jarbas, que às vezes imitava o formato no início da resposta. Em vez
        // disso, calcula uma única linha de "lacuna de tempo" (a penúltima mensagem é a
        // última troca real; a última é a pergunta de agora) pra injetar no prompt.
        const timestamped = trimmed.map((m) => ({ role: m.role, content: m.content }));
        const prevAt = trimmed.length > 1 ? trimmed[trimmed.length - 2].at : null;
        const timeGapLine = formatTimeGapLine(prevAt, Date.now());
        const lastUserText = timestamped[timestamped.length - 1]?.content || "";

        // F2-1 (Diário do Jarbas): um lote só por requisição, enviado em segundo plano
        // (ctx.waitUntil) no fim — nunca atrasa a resposta, e uma falha aqui nunca
        // quebra a conversa (flushLogBatch só loga erro, não propaga).
        const logBatch = [];
        pushLogEvent(logBatch, { tipo: "conversa", origem: "usuario", resumo: lastUserText });

        // Atalhos que a própria pessoa configurou no painel (mem.shortcuts) vencem antes
        // de qualquer chamada ao Groq — resposta instantânea, sem gastar cota de IA.
        const shortcutHit = matchUserShortcut(companionState.shortcuts, lastUserText);
        if (shortcutHit) {
          try {
            const shortcutReply = await resolveUserShortcut(env, shortcutHit);
            if (shortcutReply) {
              pushLogEvent(logBatch, { tipo: "conversa", origem: "jarbas", resumo: shortcutReply, detalhes: { via: "atalho" } });
              flushLogBatch(env, ctx, logBatch);
              return json({ emotion: "neutro", reply: shortcutReply });
            }
          } catch (err) {
            console.error("shortcut_resolve_failed:", String(err?.message || err));
            // segue pro fluxo normal com o Groq se o atalho falhar
          }
        }

        let parsed;
        let saveMemory = null;
        let saveLearned = null;
        let callMetrics = null;
        // Uma única tentativa aqui: o roteador de LLMs (groqRequest) já tenta os
        // provedores configurados em cadeia com fallback internamente, e
        // callGroqWithSearch já retenta a chamada que gera a FALA sem re-executar
        // ferramentas. Repetir a chamada inteira aqui de novo é que causava o bug de
        // ações de escrita (ex: anotar no diário) rodando duas vezes quando só a
        // segunda chamada ao LLM falhava.
        try {
          const raw = await callGroqWithSearch(env, companionPrompt(companionState, timeGapLine), timestamped, 450, companionState, logBatch);
          saveMemory = raw.saveMemory;
          saveLearned = raw.saveLearned;
          callMetrics = raw.metrics;
          const clean = raw.text.replace(/```json|```/g, "").trim();
          try {
            parsed = JSON.parse(clean);
            if (!parsed.reply) throw new Error("no_reply_field");
          } catch {
            parsed = { emotion: "neutro", reply: extractReplyFallback(clean) };
          }
        } catch (err) {
          console.error("companion_mode_failed:", String(err?.message || err));
          pushLogEvent(logBatch, { tipo: "erro", origem: "jarbas", resumo: "Falha ao gerar resposta (LLM indisponível).", detalhes: { erro: String(err?.message || err).slice(0, 200) } });
        }
        if (!parsed) {
          // Antes de virar "engasgada", tenta os padrões mais comuns direto no painel
          // (agenda, tarefas, diário, contas) sem precisar do Groq — rede de segurança
          // pros casos que precisam funcionar mesmo se o LLM estiver fora do ar.
          const fallbackReply = await tryDeterministicFallback(env, lastUserText);
          // Nunca deixa a pessoa sem resposta nenhuma, mesmo se o Groq falhar de vez.
          parsed = { emotion: "neutro", reply: fallbackReply || "Ih, deu uma engasgada aqui do meu lado. Pode repetir?" };
        }
        if (!["neutro","feliz","pensando","surpreso","focado","confirmado"].includes(parsed.emotion)) {
          parsed.emotion = "neutro";
        }
        if (typeof parsed.reply === "string") parsed.reply = stripTimestampPrefix(parsed.reply);
        if (saveMemory) parsed.save_memory = saveMemory;
        if (saveLearned) parsed.save_learned = saveLearned;
        pushLogEvent(logBatch, { tipo: "conversa", origem: "jarbas", resumo: parsed.reply, detalhes: callMetrics || {} });
        flushLogBatch(env, ctx, logBatch);
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
    ctx.waitUntil(runScheduledPush(env, ctx));
  },
};
// deploy automatico testado em 2026-08-19T18:56:14Z
