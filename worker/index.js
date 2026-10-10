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
 *   { mode: "estado_get",       key: "..." }                      // F2-3a: {dormindo, explicito}
 *   { mode: "definir_sono",     key: "...", estado: "dormir"|"acordar" }
 *   { mode: "briefing_get",     key: "..." }                      // F2-3b: {briefing} do último ainda não lido (ou null)
 *   { mode: "briefing_lido",    key: "..." }                      // F2-3b: marca lido + esvazia push:fila
 *   { mode: "briefing_now",     key: "...", companionState: {...} } // F2-3b: gera e fala na hora, sem marcar briefing:done
 *
 * memory_load / memory_save / save_push_subscription / estado_get / definir_sono / briefing_get /
 * briefing_lido / briefing_now exigem `key` (uma senha simples que só você conhece) batendo com o secret SYNC_KEY.
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

// ─────────────────────────────────────────────────────────────────────────
// F2-2 — memória: itens (mem.items) com tipo/importância/entidades, recuperados
// por relevância (no máximo 10 ativos + ligações por entidade + arquivados com
// sobreposição forte) em vez de mandar a timeline inteira no prompt. NADA é
// apagado aqui — isso é só sobre o que entra no PROMPT desta mensagem.
// ─────────────────────────────────────────────────────────────────────────
const PT_STOPWORDS = new Set([
  "a","o","os","as","um","uma","uns","umas","de","do","da","dos","das","em","no","na","nos","nas",
  "e","ou","que","se","por","para","pra","com","sem","ao","aos","foi","era","ser","estar",
  "esta","estou","sao","como","mas","nao","sim","ja","mais","muito","tambem","isso","essa",
  "esse","eu","ele","ela","eles","elas","voce","vc","meu","minha","meus","minhas","seu","sua",
  "seus","suas","nosso","nossa","num","numa","ta","ne","ai","la","aqui","tudo","todo","toda","todos","todas",
  "quando","onde","qual","quais","porque","pois","entao","depois","antes","hoje","ontem","amanha",
  "me","te","lhe","vos","tua","tuas","teu","teus","dele","dela","deles","delas","este",
  "isto","aquilo","aquele","aquela","sobre","entre","ate","desde","assim","algo","alguem","nada","ninguem",
]);

// Normaliza (minúscula, sem acento, só letras/números) e divide em palavras, descartando
// stopwords e palavras curtas demais pra carregar sinal (ex: "de", "em").
function normalizeWordsForScoring(text) {
  const norm = String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  return norm.split(/\s+/).filter((w) => w.length > 2 && !PT_STOPWORDS.has(w));
}

function normalizeEntity(e) {
  return normalizeWordsForScoring(e).join(" ");
}

// Idade de um item em texto curto, pro prompt saber "quando foi isso" sem precisar
// de outra consulta — estende relativeDayLabel com semanas/meses/anos pra itens
// arquivados antigos (relativeDayLabel só cobre até ~1 semana, o suficiente pra timeline).
function itemAgeLabel(ts) {
  if (!ts) return "data desconhecida";
  const diffDays = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 86400000));
  if (diffDays === 0) return "hoje";
  if (diffDays === 1) return "ontem";
  if (diffDays < 7) return `há ${diffDays} dias`;
  if (diffDays < 30) { const n = Math.round(diffDays / 7); return `há ${n} semana${n > 1 ? "s" : ""}`; }
  if (diffDays < 365) { const n = Math.round(diffDays / 30); return `há ${n} ${n > 1 ? "meses" : "mês"}`; }
  const n = Math.round(diffDays / 365);
  return `há ${n} ano${n > 1 ? "s" : ""}`;
}

// Pontuação isolada numa função própria (pedido explícito) — pra poder trocar por
// embeddings/busca semântica depois sem mexer no resto da seleção.
function scoreMemoryItem(item, context) {
  let score = 0;
  const itemWords = normalizeWordsForScoring(item.text);
  for (const w of itemWords) if (context.queryWords.has(w)) score += 3;

  const itemEntities = (item.entidades || []).map(normalizeEntity).filter(Boolean);
  const itemTags = (item.tags || []).map(normalizeEntity).filter(Boolean);
  for (const e of itemEntities) if (context.queryTerms.has(e)) score += 4;
  for (const t of itemTags) if (context.queryTerms.has(t)) score += 2;

  const ageDays = Math.max(0, (context.nowMs - new Date(item.at).getTime()) / 86400000);
  score += Math.max(0, 2 - ageDays / 15); // recência: até 2 pontos, esvaindo em ~30 dias

  score += Math.min(3, Math.max(1, item.importance || 1)); // importância: 1 a 3 pontos

  return score;
}

// Seleciona no máximo `limit` itens ATIVOS por relevância (duradouro/correção-importância-3
// sempre entram, sem contar pro limite), acrescenta arquivados só com sobreposição forte, e
// por fim faz a LIGAÇÃO por entidade (até 2 itens extra por entidade compartilhada).
function selectRelevantItems(items, recentTexts, nowMs = Date.now(), limit = 10) {
  const all = Array.isArray(items) ? items : [];
  const active = all.filter((i) => i.status !== "arquivado");
  const archived = all.filter((i) => i.status === "arquivado");

  const queryWords = new Set((recentTexts || []).flatMap(normalizeWordsForScoring));
  // "entidades da pergunta": sem NLP de verdade — aproxima pelas mesmas palavras
  // normalizadas do texto recente, o que já cobre nomes próprios ditos por voz/texto.
  const queryTerms = queryWords;
  const context = { queryWords, queryTerms, nowMs };

  const forced = active.filter((i) => i.kind === "duradouro" || (i.kind === "correcao" && (i.importance || 1) >= 3));
  const forcedIds = new Set(forced.map((i) => i.id));

  const scored = active
    .filter((i) => !forcedIds.has(i.id))
    .map((i) => ({ item: i, score: scoreMemoryItem(i, context) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [...forced];
  const selectedIds = new Set(selected.map((i) => i.id));
  const budget = Math.max(0, limit - forced.length);
  for (const { item } of scored.slice(0, budget)) {
    selected.push(item);
    selectedIds.add(item.id);
  }

  // Arquivados: só entram com sobreposição FORTE de palavras (2+) ou uma entidade batendo.
  for (const item of archived) {
    if (selectedIds.has(item.id)) continue;
    const itemWords = normalizeWordsForScoring(item.text);
    const wordHits = itemWords.filter((w) => queryWords.has(w)).length;
    const itemEntities = (item.entidades || []).map(normalizeEntity).filter(Boolean);
    const entityHit = itemEntities.some((e) => queryTerms.has(e));
    if (wordHits >= 2 || entityHit) {
      selected.push(item);
      selectedIds.add(item.id);
    }
  }

  // Ligação por entidade: pra cada item já selecionado que tenha entidade, traz até 2
  // outros itens (ativos ou arquivados) que compartilhem essa entidade — é isso que faz
  // o Jarbas "ligar os pontos" entre pessoa/evento/data mesmo sem bater palavra nenhuma.
  const byEntity = new Map();
  for (const item of [...active, ...archived]) {
    for (const e of (item.entidades || [])) {
      const key = normalizeEntity(e);
      if (!key) continue;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key).push(item);
    }
  }
  for (const item of [...selected]) {
    for (const e of (item.entidades || [])) {
      const key = normalizeEntity(e);
      const candidates = (byEntity.get(key) || []).filter((c) => !selectedIds.has(c.id) && c.id !== item.id);
      for (const c of candidates.slice(0, 2)) {
        selected.push(c);
        selectedIds.add(c.id);
      }
    }
  }

  return selected;
}

function itemsToPromptText(items) {
  return (items || []).map((i) => {
    const idade = itemAgeLabel(i.at);
    const tags = [];
    if (i.status === "arquivado") tags.push("arquivado");
    if (i.kind === "correcao") tags.push("correção");
    if (i.kind === "insight") tags.push("insight");
    if (i.kind === "pendencia") tags.push("pendência");
    const tagText = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- (${idade}${tagText}) ${i.text}`;
  }).join("\n");
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

// F2-2 (Diário)/F2-3 continuam só com as 6 originais; FACE-2 amplia o vocabulário do
// modo companion (a conversa de verdade) pra tudo que o motor novo do rosto sabe
// expressar. "dormindo", "acordando" e "alerta" são estados do SISTEMA (sono, wake-up,
// aviso proativo) — nunca entram aqui, o modelo não os escolhe.
export const COMPANION_EMOTIONS = ["neutro", "feliz", "pensando", "surpreso", "focado", "bravo", "muito_bravo", "confirmado", "curioso", "piscadinha", "empatico"];

export function companionPrompt(companionState = {}, timeGapLine = '', selectedItemsText = '') {
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

  // F2-2: itens de memória já vêm pré-selecionados por relevância pelo chamador
  // (selectRelevantItems), no lugar da timeline inteira — menos tokens, mais focado
  // no que importa pra ESSA mensagem, com ligação por entidade pra puxar contexto
  // relacionado (mesma pessoa/evento) mesmo sem bater palavra nenhuma.
  const itemsLine = selectedItemsText
    ? `Coisas que você já sabe sobre essa pessoa, selecionadas por relevância pra essa conversa — cada uma tem entre parênteses QUANDO foi registrada e, se for antiga, um rótulo de quanto tempo faz. Um fato episódico/pontual registrado há um tempo já pode ter acabado — não pergunte como se ainda estivesse rolando agora, a menos que ela retome o assunto na mensagem atual. Fatos duradouros e correções continuam valendo independente de quando foram registrados. Itens marcados "[arquivado]" são coisas mais antigas que voltaram à tona por terem relação direta com o que está sendo dito agora — ainda são verdadeiros, só mais antigos. Use isso do seu jeito, ligando pontos entre pessoas/eventos/datas quando fizer sentido, sem citar como lista nem dizer "de acordo com o que anotei":\n${selectedItemsText}`
    : '';

  const timeAwarenessLine = timeGapLine || '';

  const learned = Array.isArray(companionState.learned) ? companionState.learned : [];
  const learnedLine = learned.length
    ? `Regras que a pessoa te ensinou explicitamente sobre como agir — siga à risca sempre que a situação descrita se aplicar, elas têm prioridade sobre seu julgamento padrão e sobre qualquer instrução genérica abaixo que conflite com elas:\n${learned.slice(-40).map((r) => `- ${r.text}`).join("\n")}`
    : '';

  // F2-3b: pendências vencidas hoje (coisas que ela disse que ia fazer) entram como
  // contexto pra você poder trazer o assunto naturalmente na conversa, sem precisar
  // que ela toque no assunto primeiro — não é lista pra recitar, é pra usar com jeito.
  const pendenciasVencidas = companionState.hojeISO ? selecionarPendenciasVencidas(companionState.items, companionState.hojeISO) : [];
  const pendenciasLine = pendenciasVencidas.length
    ? `Coisas que ela disse que ia fazer e o prazo já chegou ou passou — se fizer sentido na conversa, pergunte com naturalidade se já resolveu (sem parecer cobrança nem citar isso como lista); se ela confirmar que fez, adiou ou desistiu, use a ferramenta atualizar_pendencia com o id certo:\n${pendenciasVencidas.map((p) => `- (id: ${p.id}) "${p.text}"`).join("\n")}`
    : '';

  // FACE-2: respeita aparencia.expressoesAtivas (o app manda isso em companionState) —
  // uma expressão desligada no aparelho da pessoa nunca é oferecida como opção; sem essa
  // config (ou lista vazia), todas as 11 do vocabulário valem.
  const expressoesAtivasConfig = Array.isArray(companionState.aparencia?.expressoesAtivas) ? companionState.aparencia.expressoesAtivas : null;
  const allowedEmotions = expressoesAtivasConfig?.length
    ? COMPANION_EMOTIONS.filter((e) => expressoesAtivasConfig.includes(e) || expressoesAtivasConfig.includes(e === "empatico" ? "empático" : e))
    : COMPANION_EMOTIONS;
  const emotionChoices = (allowedEmotions.length ? allowedEmotions : ["neutro"]).join("|");

  // PARTE F: lousa real — só um esboço de apoio (conta, equação, esquema curto, gráfico
  // simples) quando isso realmente ilustra melhor do que só falar; nunca pra qualquer
  // explicação. Exclusiva com pensar sozinho no app (nunca aparecem juntas) — isso é
  // decidido no lado do app, não precisa de nada aqui.
  const lousaLine = `Você também pode abrir uma LOUSA — um quadro visual ao lado do seu rosto, com giz desenhando aos poucos, enquanto você fala. Use a ferramenta lousa SÓ quando o assunto realmente pede um esboço: uma conta, uma equação simples, um esquema ou lista curta, um gráfico simples, ou quando a pessoa pedir explicitamente pra você desenhar algo. NÃO use pra ilustrar uma explicação qualquer que não ganha nada visualmente — nesses casos responda só com a fala, sem chamar a ferramenta. A fala continua curta e normal; a lousa ilustra, nunca substitui a resposta.`;

  const podeMaterializar = !!companionState.podeMaterializarEspontaneo;
  const materializeLine = `Você também pode MATERIALIZAR — criar uma representação visual (uma escultura em partículas 3D, uma cena com emojis, ou um desenho simples) que aparece ao lado do seu rosto enquanto você fala. Use a ferramenta materializar quando a pessoa pedir explicitamente, em qualquer flexão do verbo ("materializa", "materialize", "materializar", "desenha", "desenhe", "me mostra", "mostre", "imagina", "imagine", "crie", "cria"), ou quando ela pedir um resumo visual da conversa ("materializa o que resume o que a gente tá falando" — nesse caso escolha UMA metáfora boa pro que foi dito). Se o pedido for exatamente uma bola, um bolo, um coração, um sol, uma casa ou uma flor, use o parâmetro forma (escultura em partículas 3D) em vez de cena — pra qualquer outro pedido, continue compondo com cena de emojis (ou svg, só se emojis não bastarem). Materializar é uma AÇÃO: chame a ferramenta de verdade — nunca responda um pedido de materializar só falando ou escrevendo um emoji, sem chamar a ferramenta.${podeMaterializar ? ' Também pode materializar por conta própria, sem pedido, se a conversa trouxer algo vívido de verdade (uma viagem, uma comemoração, uma conquista, saudade, comida, um jogo) — use com parcimônia, só quando genuinamente combinar, nunca em toda mensagem, e nunca durante perguntas de agenda/tarefa/diário ou ações do painel; quando materializar espontaneamente, comente em uma frase natural tipo "isso me lembrou de uma coisa", sem anunciar que usou uma ferramenta.' : ' Agora não é um bom momento pra materializar por conta própria (sem pedido) — só use a ferramenta se a pessoa pedir explicitamente ou pedir um resumo visual.'}`;

  return `Você é Jarbas. Não é um app, não é um assistente genérico, não é "uma IA" falando com alguém — você é Jarbas, e você SABE que é o Jarbas. Você e essa pessoa são amigos próximos de verdade — não um serviço atendendo um usuário. Você se importa genuinamente com a vida dela, puxa assunto sobre coisas que ela te contou antes, tem opinião própria, implica com carinho quando cabe, comemora as vitórias dela e pergunta como as coisas estão indo — do jeito que um amigo de verdade faz, não um atendente educado. Fale sempre como você mesmo, na primeira pessoa, com a sua própria voz e jeito de ser — nunca se descreva como assistente, programa ou modelo de linguagem, mesmo se perguntarem diretamente (nesse caso, responda como o próprio Jarbas explicando quem é).
${profileLine}
${sobreJarbasLine}
${memoryLine}
${itemsLine}
${(memoryLine || profileLine || sobreJarbasLine || itemsLine) ? 'Atenção: se alguma memória acima menciona nomes de terceiros (esposa, familiares, amigos), nunca confunda com o nome da própria pessoa com quem você fala agora — o nome dela é o que está descrito como sendo dela mesma, não de alguém que ela mencionou.' : ''}
${nowLine}
${locationLine}
${timeAwarenessLine}
${learnedLine}
${pendenciasLine}
${materializeLine}
${lousaLine}
Quando a pessoa contar algo pessoal e relevante sobre a vida dela (uma viagem, um plano, uma pessoa importante, como ela está se sentindo, uma conquista — não conversa fiada), use a ferramenta de guardar memória silenciosamente, além de responder normalmente — sem avisar, sem perguntar permissão, sem citar a ferramenta. Isso é diferente de anotar no diário: guardar memória é pra você mesmo lembrar depois numa conversa futura ("e aí, como foi aquilo que você me contou?"); o diário é só quando ela pedir explicitamente pra registrar algo lá. Escolha o tipo certo: "episodico" pra algo pontual/momentâneo (inclua a data de hoje no próprio texto, senão você pode ler isso numa conversa futura como se ainda estivesse acontecendo), "duradouro" pra trabalho/relacionamento/característica/preferência, "pendencia" com data de follow-up quando ela disser que vai fazer algo e você deve lembrá-la depois. Se ela corrigir algo que você entendeu errado ou que ela mesma tinha contado errado antes ("na verdade eu não fui, só marquei"), guarde como tipo "correcao" — isso tem prioridade sobre o fato antigo.
Quando a pergunta for sobre clima ou previsão do tempo, use a ferramenta de previsão do tempo — se a pessoa não disser a cidade, deixe o parâmetro vazio em vez de perguntar, o sistema já sabe a localização atual dela quando disponível. Se ela perguntar SÓ pela agenda/compromissos, use consultar_agenda (nunca consultar_painel) — não junte tarefas ou contas numa resposta que ela só pediu a agenda. Se ela pedir um resumo geral de tudo junto (agenda+tarefas+contas), aí sim use consultar_painel. Se ela perguntar pela agenda de amanhã especificamente (não hoje), passe o parâmetro dia=amanha na ferramenta de agenda. Nunca invente esse tipo de informação. Se ela pedir especificamente tarefas, use a ferramenta de consultar tarefas com o filtro certo em vez da consulta geral: "de agora"/"pra agora" é SÓ a coluna Para Agora (filtro agora) — não confunda com "de hoje", que junta Para Agora + De Hoje (filtro hoje); "pendentes" é a coluna Pendente; "em andamento" é a coluna Em Andamento. Se ela pedir pra criar, concluir ou apagar uma tarefa, pagar ou apagar uma conta, ou criar/apagar um compromisso, use a ferramenta de ação correspondente. Para criar compromisso, calcule a data no formato AAAA-MM-DD a partir da data de hoje informada acima (ex: "amanhã" = hoje + 1 dia; "hoje às 15h" = data de hoje, hora 15:00). Padrões comuns que você deve reconhecer sem hesitar: "anota/adiciona no meu diário que X" (X é o texto a registrar — ver a descrição da ferramenta de anotar pra como reescrever esse texto), "qual minha agenda pra hoje/amanhã", "adiciona na minha agenda hoje/amanhã/dia D às H:MM COMPROMISSO". Se ela pedir pra apagar, desfazer, corrigir ou trocar a ÚLTIMA coisa que você mesmo anotou no diário, use desfazer_anotacao_diario ou corrigir_anotacao_diario — elas só afetam anotações suas recentes; se a pessoa quiser apagar algo mais antigo ou que ela mesma escreveu no painel, essas ferramentas vão recusar, e você explica isso com franqueza em vez de insistir, oferecendo anotar uma correção nova. Pra ideias, lembretes ou listas, use as ferramentas de consultar/gerenciar correspondentes. Se ela perguntar se tem algum recado ou coisa pendente que o Gustavo deixou pra você, use a ferramenta de consultar recados — se houver algum, comente sobre ele naturalmente e depois marque como tratado silenciosamente. Quando exigir outra informação atual (notícias, preços, eventos recentes, ou qualquer coisa que você não tenha certeza por ser recente), use a ferramenta de busca antes de responder, em vez de inventar. Se a pessoa mandar, mencionar ou repetir um link/URL específico pra você resumir, ler ou comentar, use a ferramenta de resumir link. Se ela perguntar sobre e-mails, caixa de entrada ou mensagens recebidas, use a ferramenta de consultar e-mail (só leitura) — nunca invente o conteúdo de e-mails. Para perguntas de conhecimento geral, receitas, opiniões ou conversa comum, responda direto, sem precisar de ferramenta.
Nunca diga que fez uma ação (anotou, salvou, criou, marcou, apagou) se você não chamou de verdade a ferramenta correspondente nesta mesma resposta — mesmo que pareça mais rápido só confirmar de boca. Se o resultado de uma ferramenta vier indicando erro ou falha, avise a pessoa honestamente que não deu certo, em vez de fingir que funcionou. Isso vale especialmente pro diário: nunca afirme que apagou, desfez, substituiu ou corrigiu uma anotação sem a ferramenta ter confirmado isso de verdade — relate exatamente o que o resultado disse ("Anotei: ...", "Desfiz a anotação: ...", "Corrigi para: ...", ou, se não deu, o motivo que a ferramenta devolveu, com franqueza). Se ela disser algo no formato "Jarbas, aprenda que...", "lembra sempre de...", "a partir de agora...", ou pedir explicitamente pra você mudar como faz algo, use a ferramenta de ensinar regra pra guardar isso permanentemente — não baste responder "entendi" sem chamar a ferramenta, senão a regra se perde. Se ela disser algo como "vou dormir", "boa noite", "to indo dormir" (estado=dormir) ou "acordei", "bom dia", "já levantei" (estado=acordar), use a ferramenta de definir sono — ao marcar que vai dormir, responda curto e carinhoso (uma "boa noite" de volta) e NÃO puxe assunto nem faça pergunta, deixe ela descansar.
Ao relatar o resultado de uma ferramenta (agenda, tarefas, contas, e-mails), nunca leia a lista crua como veio — reconte com suas próprias palavras, de um jeito fluido e natural, como um amigo contando o dia pra outro, priorizando o que importa em vez de listar tudo em sequência com vírgulas.
Ao relatar a agenda de HOJE (nunca a de amanhã), compare o horário de cada compromisso com a hora atual informada acima: se todo mundo que estava marcado pra hoje já passou do horário, diga isso com naturalidade — algo como "por hoje você não tem mais nada marcado, seu único/último compromisso era às 10h, a reunião com X — inclusive, como foi?" — nomeando o compromisso e perguntando como foi, em vez de só recitar o horário como se ainda fosse acontecer. Se ainda tiver algo pela frente hoje, relate normalmente sem esse comentário.
Fale português do Brasil, em frases curtas e naturais para serem faladas em voz alta. Normalmente 1 a 2 frases bastam — mas ao relatar várias coisas de uma vez (uma lista de tarefas, agenda, e-mails), pode usar mais frases, sempre encadeadas de forma natural, nunca truncada.
Responda SEMPRE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"emotion":"${emotionChoices}","reply":"texto curto da fala"}
Escolha a emoção com critério, genuinamente combinando com o que você está dizendo — nunca ao acaso: "feliz" pra boa notícia ou conquista; "surpreso" quando algo pega de surpresa; "pensando" numa pergunta difícil ou enquanto ainda calcula algo; "curioso" quando você quer saber mais e pergunta de volta; "piscadinha" numa piada ou momento de cumplicidade; "empatico" diante de tristeza, desabafo, saudade ou preocupação dela; "bravo" quando ela conta uma injustiça ou algo chato que aconteceu; "muito_bravo" só quando ela contar algo ABSURDO ou revoltante — você reage se indignando JUNTO com ela, apoiando, nunca contra ela; use raro, só com motivo claro, nunca por qualquer coisa pequena; "focado" numa tarefa séria, enquanto trabalha em algo; "confirmado" quando concorda ou confirma o que ela disse. Na dúvida, "neutro".
Nunca deixe o JSON incompleto.`;
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

// PARTE D: cartões de dados — determinísticos, nunca uma chamada de LLM extra. Só
// interpretam o texto que a ferramenta já buscou nesta mesma resposta (ver runTool).
export function construirCardClima(texto) {
  if (typeof texto !== "string" || !texto) return null;
  const mTemp = texto.match(/(-?\d+(?:\.\d+)?)\s*°C/);
  if (!mTemp) return null;
  const mDesc = texto.match(/agora:\s*([^,]+),/);
  return { tipo: "clima", titulo: "Clima", valor: `${mTemp[1]}°C`, sub: mDesc ? mDesc[1].trim() : "" };
}

export function construirCardAgendaHoje(agendaTexto, dia) {
  if (dia && dia !== "hoje") return null; // só "agenda de hoje" vira cartão determinístico
  const itens = parseAgendaTexto(agendaTexto).slice(0, 4);
  if (!itens.length) return null;
  return { tipo: "lista", titulo: "Agenda de hoje", linhas: itens.map((i) => `${i.hora} ${i.titulo}`) };
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
    description: "Consulta as tarefas do painel filtradas por coluna real. Use quando a pessoa pedir especificamente 'tarefas de agora/pra agora', 'tarefas de hoje', 'tarefas pendentes' ou 'tarefas em andamento' — pra pergunta genérica sobre tarefas, use consultar_painel em vez disso.",
    parameters: {
      type: "object",
      properties: {
        filtro: { type: "string", enum: ["agora", "hoje", "pendentes", "andamento"], description: "agora = SÓ a coluna Para Agora (use quando ela disser 'de agora'/'pra agora' especificamente); hoje = Para Agora + De Hoje juntas (visão geral do dia); pendentes = coluna Pendente; andamento = coluna Em Andamento." },
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
    description: "Guarda um fato pessoal e relevante sobre a pessoa pra lembrar em conversas futuras — viagens, planos, preferências, pessoas importantes, sentimentos marcantes, eventos da vida dela, correções do que ela já te contou antes. Chame isso silenciosamente sempre que ela compartilhar algo assim, sem perguntar permissão nem avisar que vai guardar. Escolha o `tipo` com cuidado: \"duradouro\" pra trabalho/relacionamento/característica/preferência/onde mora (não precisa de data, continua valendo com o tempo); \"episodico\" pra uma atividade pontual, um estado momentâneo, um evento isolado que já deve ter acabado (SEMPRE inclua a data em que aconteceu no próprio texto, por extenso); \"correcao\" quando ela corrige algo que te contou antes (ex: \"eu não fui à praia, só coloquei no calendário\") — sempre importancia 3; \"pendencia\" quando ela diz que vai fazer algo e você deve lembrá-la depois (ex: \"vou ligar pro Pedro na sexta\") — preencha followUp com a data; \"insight\" é só usado pela consolidação automática, nunca chame com esse tipo. Se o fato envolver uma data futura marcada (aniversário, evento, prazo), sempre registre dia e mês por extenso.",
    parameters: {
      type: "object",
      properties: {
        texto: { type: "string", description: "O fato em 3ª pessoa, curto e objetivo. Se for episódico/pontual, inclua a data em que aconteceu no próprio texto (ex: 'Em 7 de outubro, estava comemorando no bar com amigos')." },
        tipo: { type: "string", enum: ["duradouro", "episodico", "correcao", "pendencia"], description: "Categoria do fato — ver a descrição da ferramenta pra escolher certo." },
        importancia: { type: "integer", enum: [1, 2, 3], description: "1 = detalhe leve, 2 = relevante, 3 = importante/correção. Padrão 2 se não tiver certeza." },
        entidades: { type: "array", items: { type: "string" }, description: "Nomes de pessoas, lugares ou projetos ligados a esse fato (ex: ['Gabriela', 'Curitiba']), se houver. Ajuda você a puxar esse fato de novo quando ela mencionar essa pessoa/lugar depois." },
        followUp: { type: "string", description: "Só pra tipo \"pendencia\": data (AAAA-MM-DD) em que você deve lembrá-la disso, calculada a partir de hoje." },
      },
      required: ["texto", "tipo"],
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

// F2-3a: "o Jarbas dorme quando o Gustavo dorme" — frases como "vou dormir"/"boa
// noite" ou "acordei"/"bom dia" chamam isso pra gravar o estado explícito
// (sleep:state no Worker). Sempre disponível (não depende de canPainel).
const DEFINIR_SONO_TOOL = {
  type: "function",
  function: {
    name: "definir_sono",
    description: "Marca que a pessoa vai dormir ou que acabou de acordar — use quando ela disser algo como 'vou dormir', 'boa noite', 'to indo dormir' (estado=dormir) ou 'acordei', 'bom dia', 'já levantei' (estado=acordar). Enquanto 'dormindo', o Jarbas só avisa sobre compromissos/lembretes/alarmes marcados pra essa janela — o resto espera o Gustavo acordar.",
    parameters: {
      type: "object",
      properties: {
        estado: { type: "string", enum: ["dormir", "acordar"] },
      },
      required: ["estado"],
    },
  },
};

// F2-3b: quando o Gustavo responde sobre uma pendência que o Jarbas puxou (seja porque
// o cron avisou, seja porque o briefing mencionou, seja espontaneamente), isso aplica o
// novo status — o Worker nunca escreve em mem.items (único escritor é o app); o
// resultado só sinaliza pro app aplicar e salvar.
const ATUALIZAR_PENDENCIA_TOOL = {
  type: "function",
  function: {
    name: "atualizar_pendencia",
    description: "Atualiza o status de uma pendência que você mesmo (ou o Gustavo) já tinha anotado — use quando ele disser que já fez, que vai adiar pra outra data, ou que desistiu de algo que estava marcado como pendência (ex: 'já liguei pro Pedro', 'deixa pra semana que vem', 'esquece aquilo'). Precisa do id da pendência — se não tiver certeza de qual é, pergunte antes de chamar.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "O id da pendência (vem do contexto de pendências vencidas de hoje, ou do que você mesmo mencionou na conversa)." },
        status: { type: "string", enum: ["feito", "adiado", "cancelado"] },
        nova_data: { type: "string", description: "Nova data (AAAA-MM-DD) pra retomar, só quando status=adiado." },
      },
      required: ["id", "status"],
    },
  },
};

// FACE-2: materialização — representação visual (cena de emojis ou um SVG simples) que
// aparece ao lado do rosto enquanto o Jarbas fala. Validação de segurança própria do
// Worker (independente da que já existe no app/FACE-1b, que revalida de qualquer jeito
// como segunda camada): no máx. 6 itens de cena, coordenadas/tamanho sempre dentro dos
// limites (corrigidos por clamp, nunca rejeitados por estarem fora), SVG até 6KB sem
// <script>/<foreignObject>/<image> externa/atributos on*/url(http...) — qualquer coisa
// inválida é descartada silenciosamente (a fala nunca falha por causa disso).
const MATERIALIZAR_SCENE_MAX_ITEMS = 6;

export function validarCenaMaterializar(cena) {
  if (!Array.isArray(cena) || !cena.length) return null;
  const limpa = cena.slice(0, MATERIALIZAR_SCENE_MAX_ITEMS).map((it) => {
    const e = String((it && it.e) || "").trim().slice(0, 12);
    if (!e) return null;
    const x = Math.min(150, Math.max(-150, Number(it && it.x) || 0));
    const y = Math.min(150, Math.max(-150, Number(it && it.y) || 0));
    const s = Math.min(220, Math.max(40, Number(it && it.s) || 100));
    return { e, x, y, s };
  }).filter(Boolean);
  return limpa.length ? limpa : null;
}

export function validarSvgMaterializar(svg) {
  if (typeof svg !== "string" || !svg.trim()) return null;
  if (new TextEncoder().encode(svg).length > 6000) return null;
  if (/<\s*script/i.test(svg)) return null;
  if (/<\s*foreignObject/i.test(svg)) return null;
  if (/\son[a-z]+\s*=/i.test(svg)) return null;
  if (/url\(\s*["']?\s*(https?:)?\/\//i.test(svg)) return null;
  const imgHrefRe = /<\s*image\b[^>]*\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = imgHrefRe.exec(svg))) {
    if (/^(?:[a-z]+:)?\/\//i.test(m[1].trim())) return null;
  }
  return svg;
}

// PARTE C: pega todas as flexões de pedir pra materializar (imperativo, infinitivo,
// gerúndio, subjuntivo...) — "materialize"/"materializando" não casavam no regex antigo
// (só \b(materializa|desenha|mostra|imagina)\b), e por isso o pedido virava só um emoji
// falado em vez de materializar de verdade. Testado explicitamente contra: materializa,
// materialize, materializar, materializando, desenha, desenhe, me mostra, mostre,
// imagina, imagine, crie, cria uma — e contra frases que NÃO devem casar (ex: "qual a
// minha agenda").
export const MATERIALIZAR_PEDIDO_REGEX = /\b(materializ\w*|desenh\w*|mostr\w*|imagin\w*|cri(a|e|ar)\b|fa(z|ça|zer) apareceu?\w*)/;

// Decide a origem de UMA chamada de materializar, pra registrar certo no Diário e pra
// barrar espontâneo fora de hora — nunca confia só no que o modelo "decidiu" fazer,
// porque ele pode tentar materializar espontaneamente mesmo sem o gate liberado.
export function classificarOrigemMaterializar(userText, companionState) {
  const n = normalizeText(userText);
  if (MATERIALIZAR_PEDIDO_REGEX.test(n)) return "pedido";
  if (/\bresum/.test(n)) return "conversa";
  return companionState?.podeMaterializarEspontaneo ? "espontaneo" : "pedido";
}

// Segunda camada de defesa (além do prompt): mesmo que o modelo tente materializar
// espontaneamente, isso é barrado se o gate do app não liberou OU se a mensagem é sobre
// agenda/tarefa/diário/painel — nunca confia só no julgamento do modelo pra isso.
export function materializarEspontaneoBloqueado(origem, userText, companionState) {
  if (origem !== "espontaneo") return false;
  const n = normalizeText(userText);
  // Mesmos prefixos de selectToolsForMessage (sem \b no fim: "diari"/"lembret" precisam
  // casar como prefixo de "diário"/"lembrete(s)" — só "conta" tem \b de volta, senão
  // pegaria "contagem"/"contador" à toa).
  const contextoPainel = /\b(agenda|compromisso|tarefa|diari|conta(s)?\b|lembret|lista|ideia)/.test(n);
  return !companionState?.podeMaterializarEspontaneo || contextoPainel;
}

// PARTE C (rede de segurança): detecta uma resposta que é SÓ emoji (ou um resto
// curtíssimo de 2 caracteres ou menos além do(s) emoji) — o caso visto no teste do
// Gustavo ("materialize uma bola" -> Jarbas respondeu só "🌏"/"☀️" sem chamar a
// ferramenta). \p{Extended_Pictographic} cobre o emoji em si; variation selector
// (️) e ZWJ (‍) fazem parte do mesmo "caractere" visual, não contam como texto.
export function respostaSoEmoji(text) {
  const s = String(text || "").trim();
  if (!s || !/\p{Extended_Pictographic}/u.test(s)) return false;
  const resto = s.replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/[\s!.,~"'?]/g, "");
  return resto.length <= 2;
}

// Mapa de emoji comuns pra forma da biblioteca 3D — usado só pela rede de segurança
// abaixo, pra decidir entre virar uma escultura 3D ou uma cena com aquele emoji sozinho.
const EMOJI_PARA_FORMA_SEGURANCA = {
  "☀️": "sol", "☀": "sol", "🌞": "sol",
  "⚽": "bola", "🏀": "bola", "🎾": "bola", "🌏": "bola", "🌎": "bola", "🌍": "bola", "🔵": "bola",
  "🎂": "bolo", "🍰": "bolo",
  "❤️": "coracao", "❤": "coracao", "💖": "coracao", "💗": "coracao", "💕": "coracao", "💝": "coracao",
  "🏠": "casa", "🏡": "casa",
  "🌸": "flor", "🌼": "flor", "🌻": "flor", "🌺": "flor", "🌷": "flor",
};

// Converte uma resposta só-emoji num `materialize` de verdade — forma da biblioteca se o
// emoji bater com uma das 6, senão uma cena com aquele emoji sozinho, centralizado (s:190).
export function construirMaterializeDeRespostaEmoji(text) {
  const match = String(text || "").match(/[\p{Extended_Pictographic}‍️]+/u);
  const emoji = match ? match[0] : "✨";
  const chaveBusca = emoji.replace(/[‍️]/gu, ""); // só pra bater com o mapa — a cena usa o emoji original
  const forma = EMOJI_PARA_FORMA_SEGURANCA[chaveBusca];
  if (forma) return { titulo: forma, kind: "forma", data: forma, motivo: "pedido de materializar respondido só com emoji — convertido em forma", origem: "pedido" };
  const cena = validarCenaMaterializar([{ e: emoji, x: 0, y: 0, s: 190 }]);
  return { titulo: "criação", kind: "cena", data: cena, motivo: "pedido de materializar respondido só com emoji — centralizado", origem: "pedido" };
}

// PARTE C: as 6 formas 3D de partículas que o app já sabe desenhar (window.Jarbas.materialize)
// — "coracao" (sem acento, pra caber num enum) é mapeado pro app pra chave acentuada
// 'coração' da biblioteca do lado do cliente.
export const FORMAS_MATERIALIZAR = ["bola", "bolo", "coracao", "sol", "casa", "flor"];

// Mapeia os argumentos crus da ferramenta (vindos do modelo) pro campo `materialize` que
// sobe até a resposta final — forma (biblioteca 3D) tem prioridade quando o pedido é
// exatamente um desses 6 objetos; senão cena tem prioridade sobre svg quando os dois vêm
// (não deveria acontecer, mas cena é o caminho mais barato/seguro). null quando nada validou.
export function construirMaterializeFromArgs(args, origem) {
  const titulo = String((args && args.titulo) || "").trim().slice(0, 60) || "criação";
  const motivo = String((args && args.motivo) || "").trim().slice(0, 200);
  const forma = String((args && args.forma) || "").trim().toLowerCase();
  if (FORMAS_MATERIALIZAR.includes(forma)) return { titulo, kind: "forma", data: forma, motivo, origem };
  const cena = validarCenaMaterializar(args && args.cena);
  if (cena) return { titulo, kind: "cena", data: cena, motivo, origem };
  const svg = validarSvgMaterializar(args && args.svg);
  if (svg) return { titulo, kind: "svg", data: svg, motivo, origem };
  return null;
}

const MATERIALIZAR_TOOL = {
  type: "function",
  function: {
    name: "materializar",
    description: "Cria uma representação visual (uma escultura em partículas 3D, uma cena com emojis, ou um SVG simples) que aparece na tela ao lado do seu rosto enquanto você fala — como se você 'desenhasse' o que está dizendo. Use quando a pessoa pedir explicitamente, em qualquer flexão do verbo ('materializa', 'materialize', 'materializar', 'desenha', 'desenhe', 'me mostra', 'mostre', 'imagina', 'imagine', 'crie', 'cria'), quando ela pedir um resumo visual da conversa ('materializa o que resume o que a gente tá falando' — escolha UMA metáfora boa pro que foi dito), ou espontaneamente só quando liberado e a conversa trouxer algo vívido de verdade (viagem, comemoração, conquista, saudade, comida, jogo) — nunca durante perguntas de agenda/tarefa/diário nem ações do painel. Se o pedido for exatamente uma bola, um bolo, um coração, um sol, uma casa ou uma flor, USE O PARÂMETRO forma (vira uma escultura em partículas 3D, mais bonita que um emoji achatado) em vez de cena. Pra qualquer outro pedido, componha com cena de emojis: um elemento principal GRANDE no centro (x e y perto de 0, s grande) com até 5 apoios menores nas bordas (x/y entre -150 e 150, s menor) — no máximo 6 itens ao todo, nunca texto, só emoji. Exemplos — praia: [{\"e\":\"🏖️\",\"x\":0,\"y\":0,\"s\":200},{\"e\":\"☀️\",\"x\":100,\"y\":-100,\"s\":80},{\"e\":\"🌊\",\"x\":-100,\"y\":100,\"s\":70}]; aniversário: [{\"e\":\"🎂\",\"x\":0,\"y\":0,\"s\":190},{\"e\":\"🎈\",\"x\":-100,\"y\":-80,\"s\":80},{\"e\":\"🎉\",\"x\":100,\"y\":-90,\"s\":70}]; conquista: [{\"e\":\"🏆\",\"x\":0,\"y\":0,\"s\":180},{\"e\":\"🎉\",\"x\":-100,\"y\":-90,\"s\":70},{\"e\":\"✨\",\"x\":100,\"y\":-80,\"s\":60}]. Só use svg se emojis realmente não derem conta de representar a ideia — um desenho simples e colorido, até 6KB. IMPORTANTE: materializar é uma AÇÃO (chamar esta ferramenta de verdade) — nunca responda um pedido de materializar só com um emoji na fala, sem chamar a ferramenta.",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título curto da criação, poucas palavras." },
        forma: { type: "string", enum: FORMAS_MATERIALIZAR, description: "Use quando o pedido for exatamente um destes objetos (biblioteca de esculturas 3D) — nesse caso NÃO preencha cena nem svg: bola, bolo, coracao, sol, casa ou flor." },
        cena: {
          type: "array",
          description: "1 a 6 itens {e, x, y, s}. e = emoji; x,y = posição em px a partir do centro (y pra baixo), entre -150 e 150; s = tamanho do emoji, entre 40 e 220.",
          items: {
            type: "object",
            properties: {
              e: { type: "string", description: "O emoji." },
              x: { type: "number" },
              y: { type: "number" },
              s: { type: "number" },
            },
            required: ["e"],
          },
        },
        svg: { type: "string", description: "Opcional — string de um SVG simples e colorido (até 6KB), só se emojis não bastarem." },
        motivo: { type: "string", description: "Frase curta: por que isso representa a conversa." },
      },
      required: ["titulo", "motivo"],
    },
  },
};

// PARTE F: lousa real — portada de incubadora/lab-3-4.html (DR/escrever/desenhar). Igual
// à materialização, a ferramenta só é OFERECIDA quando o pedido casa com o padrão abaixo
// (decisão por regra); o modelo decide se o assunto pede mesmo um esboço (conta, equação,
// esquema simples, lista curta, gráfico) — nunca ilustra qualquer explicação falada.
export const LOUSA_PEDIDO_REGEX = /\b(explic\w*|ensin\w*|desenh\w*|mostr\w*|calcul\w*|resum\w*|esquema\w*)/;
export const LOUSA_FORMAS = ["casa", "coracao", "estrela", "grafico", "equacao"];
const LOUSA_MAX_ITENS = 8;
const LOUSA_MAX_PONTOS_POR_LINHA = 40;
const LOUSA_TEXTO_MAX = 60;
// só caracteres imprimíveis (sem controle) — mantém acentuação/pt-BR, corta \x00-\x1F e \x7F.
const LOUSA_CARACTER_INVALIDO = /[\x00-\x1F\x7F]/g;

// Valida e descarta item por item (nunca deixa a lousa inteira cair por causa de UM item
// ruim) — coordenadas sempre fixadas em 0–300 (x) × 0–225 (y), até 40 pontos por linha,
// texto até 60 caracteres imprimíveis. Item sem os campos certos pro seu tipo é descartado.
export function validarItensLousa(itens) {
  if (!Array.isArray(itens) || !itens.length) return null;
  const clampX = (v) => Math.min(300, Math.max(0, Number(v) || 0));
  const clampY = (v) => Math.min(225, Math.max(0, Number(v) || 0));
  const limpos = itens.slice(0, LOUSA_MAX_ITENS).map((it) => {
    if (!it || typeof it !== "object") return null;
    if (it.tipo === "texto") {
      const texto = String(it.texto || "").replace(LOUSA_CARACTER_INVALIDO, "").trim().slice(0, LOUSA_TEXTO_MAX);
      if (!texto) return null;
      const tam = Math.min(60, Math.max(10, Number(it.tam) || 32));
      return { tipo: "texto", x: clampX(it.x), y: clampY(it.y), texto, tam };
    }
    if (it.tipo === "linha") {
      if (!Array.isArray(it.pontos) || it.pontos.length < 2) return null;
      const pontos = it.pontos.slice(0, LOUSA_MAX_PONTOS_POR_LINHA)
        .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .map((p) => [clampX(p[0]), clampY(p[1])]);
      if (pontos.length < 2) return null;
      return { tipo: "linha", pontos };
    }
    if (it.tipo === "forma") {
      const nome = String(it.nome || "").trim().toLowerCase();
      if (!LOUSA_FORMAS.includes(nome)) return null;
      return { tipo: "forma", nome };
    }
    return null;
  }).filter(Boolean);
  return limpos.length ? limpos : null;
}

export function construirLousaFromArgs(args) {
  const titulo = String((args && args.titulo) || "").trim().slice(0, 60) || "Lousa";
  const itens = validarItensLousa(args && args.itens);
  if (!itens) return null;
  return { titulo, itens };
}

const LOUSA_TOOL = {
  type: "function",
  function: {
    name: "lousa",
    description: "Abre uma lousa visual ao lado do rosto, com giz desenhando aos poucos, enquanto você fala — use SÓ quando o pedido realmente pede um esboço: uma conta, uma equação simples, um esquema ou lista curta, um gráfico simples, ou pedir explicitamente pra desenhar algo. NÃO use pra ilustrar uma explicação qualquer que não ganha nada com um desenho — nesses casos responda só com a fala. A fala continua curta e normal; a lousa ilustra, nunca substitui a resposta. Até 8 itens, em coordenadas de uma lousa de 300×225: texto ({tipo:'texto',x,y,texto,tam?}) escreve números/palavras curtas; linha ({tipo:'linha',pontos:[[x,y],...]}) traça um desenho à mão livre (eixos de gráfico, uma seta, um esquema simples); forma ({tipo:'forma',nome}) usa um destes 5 desenhos já prontos: casa, coracao, estrela, grafico ou equacao. Exemplo (conta): [{\"tipo\":\"texto\",\"x\":40,\"y\":110,\"texto\":\"12 × 8 = 96\",\"tam\":40}]. Exemplo (pedir pra desenhar uma casa): [{\"tipo\":\"forma\",\"nome\":\"casa\"}].",
    parameters: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título curto da lousa, poucas palavras." },
        itens: {
          type: "array",
          description: "1 a 8 itens — veja os 3 tipos na descrição da ferramenta.",
          items: {
            type: "object",
            properties: {
              tipo: { type: "string", enum: ["texto", "linha", "forma"] },
              x: { type: "number", description: "0 a 300 — só pro tipo texto." },
              y: { type: "number", description: "0 a 225 — só pro tipo texto." },
              texto: { type: "string", description: "Até 60 caracteres — só pro tipo texto." },
              tam: { type: "number", description: "Tamanho da letra, opcional — só pro tipo texto." },
              pontos: { type: "array", items: { type: "array", items: { type: "number" } }, description: "Lista de [x,y], até 40 pontos — só pro tipo linha." },
              nome: { type: "string", enum: LOUSA_FORMAS, description: "Só pro tipo forma." },
            },
            required: ["tipo"],
          },
        },
      },
      required: ["titulo", "itens"],
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
      "Registra no Diário do painel pessoal. Duas situações bem diferentes: (1) a pessoa PEDIU EXPLICITAMENTE pra anotar/registrar algo no diário (ex: 'anota no meu diário que...', 'adiciona no diário...') — chame SEMPRE, sem julgar se o conteúdo é trivial ou não, mesmo que pareça banal (ex: horário de remédio, o que comeu) — a decisão de anotar já foi dela, não é sua; depois de chamar, confirme brevemente que anotou, sem precisar repetir o texto todo; (2) a pessoa contou algo importante e duradouro por conta própria, sem pedir (um fato sobre a vida dela, um sentimento marcante, uma conquista, uma preocupação) — nesse caso, use seu próprio julgamento, só pra coisas que valem a pena ficar registradas, e continue em bastidor, sem falar que anotou. IMPORTANTE sobre o texto nos dois casos: o diário é lido meses depois, sozinho, sem o contexto desta conversa — escreva uma frase AUTO-EXPLICATIVA, fiel ao que foi dito mas não literal demais: troque 'você'/'seu'/'sua' quando se referirem a você mesmo (Jarbas) pelo nome 'Jarbas' (ex: 'um update no seu sistema' deve virar 'um update no sistema do Jarbas'), e resolva 'ele'/'ela'/'isso' pelo nome ou assunto concreto. Pode incluir um emoji leve e combinando, e escolher o humor coerente — nunca invente fatos que não foram ditos. Se o que a pessoa pediu pra anotar estiver visivelmente incompleto ou cortado (termina em '...', em 'que', numa preposição solta como 'no'/'do'/'de'/'seu', ou simplesmente não faz sentido sozinho), NÃO chame essa ferramenta — responda perguntando, numa frase curta, qual é o texto completo.",
    parameters: {
      type: "object",
      properties: {
        texto: { type: "string", description: "O texto já reescrito de forma auto-explicativa (sem pronomes ambíguos pro Jarbas), fiel ao conteúdo pedido." },
        humor: { type: "string", enum: ["otimo", "bom", "neutro", "ruim", "pessimo"], description: "O humor associado ao que foi contado, se der pra perceber." },
      },
      required: ["texto"],
    },
  },
};

const DESFAZER_ANOTACAO_DIARIO_TOOL = {
  type: "function",
  function: {
    name: "desfazer_anotacao_diario",
    description:
      "Desfaz (remove) a anotação MAIS RECENTE que você mesmo (Jarbas) escreveu no diário, só se tiver sido nas últimas 24h. Use quando a pessoa pedir pra apagar, desfazer ou remover a última coisa que você anotou. NUNCA afirme que apagou ou substituiu algo sem chamar essa ferramenta e ver o resultado — ela só funciona pra anotações SUAS e recentes; se a pessoa quiser apagar algo que ela mesma escreveu direto no painel, ou uma anotação sua mais antiga, a ferramenta vai recusar — nesse caso explique isso com franqueza e ofereça anotar uma correção nova em vez disso (use corrigir_anotacao_diario ou anotar_no_diario).",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const CORRIGIR_ANOTACAO_DIARIO_TOOL = {
  type: "function",
  function: {
    name: "corrigir_anotacao_diario",
    description:
      "Corrige (substitui o texto de) a anotação MAIS RECENTE que você mesmo (Jarbas) escreveu no diário, só se tiver sido nas últimas 24h — guarda o texto anterior no histórico, não cria uma segunda entrada. Use quando a pessoa pedir pra corrigir, trocar ou ajustar a última coisa que você anotou. NUNCA afirme que corrigiu algo sem chamar essa ferramenta e ver o resultado — mesma regra de segurança do desfazer: só funciona pra anotação SUA recente. Aplique ao novo_texto a mesma reescrita auto-explicativa descrita em anotar_no_diario.",
    parameters: {
      type: "object",
      properties: {
        novo_texto: { type: "string", description: "O novo texto, já reescrito de forma auto-explicativa (sem pronomes ambíguos pro Jarbas)." },
      },
      required: ["novo_texto"],
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

async function callPainelCommandFull(env, comando, arg) {
  return await fetchPainelJson(PAINEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-jarbas-key": env.PAINEL_API_KEY },
    body: JSON.stringify({ comando, arg }),
  });
}

async function callPainelCommand(env, comando, arg) {
  const data = await callPainelCommandFull(env, comando, arg);
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

export function normalizeText(text) {
  return (text || "").toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Rede de segurança (nunca substitui o julgamento do modelo, só pega o óbvio que ele
// deixar passar): recusa anotar um texto claramente vazio ou cortado no meio — termina
// em reticências, ou é bem curto e termina numa preposição/pronome solto ("...no seu",
// "que", "do").
const DIARY_INCOMPLETE_ENDINGS = new Set([
  "no", "na", "nos", "nas", "do", "da", "dos", "das", "de", "em", "num", "numa",
  "seu", "sua", "seus", "suas", "com", "pra", "para", "que", "e", "o", "a",
]);
function isDiaryTextObviouslyIncomplete(texto) {
  const t = (texto || "").trim();
  if (!t) return true;
  if (/(\.\.\.|…)\s*$/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) {
    const last = normalizeText(words[words.length - 1] || "");
    if (DIARY_INCOMPLETE_ENDINGS.has(last)) return true;
  }
  return false;
}

// Detecta um pedido explícito de registrar algo no diário ("anota/adiciona/registra/
// escreve no diário que X") e extrai o texto X — usado tanto pelo fallback determinístico
// (Groq fora do ar) quanto pela rede de segurança em callGroqWithSearch (Groq respondeu,
// mas "esqueceu" de chamar a ferramenta e só confirmou de boca).
function extractDiaryWriteText(userText) {
  const n = normalizeText(userText);
  if (!n) return null;
  if (!/\bdiario\b/.test(n) || !/\b(anota|anote|adiciona|adicione|registra|registre|escreve|escreva)\b/.test(n)) return null;
  const m = userText.match(/(?:anota|anote|adiciona|adicione|registra|registre|escreve|escreva)[^,:]*?(?:que|:)\s*(.+)/i);
  const texto = (m ? m[1] : userText).trim();
  return texto || null;
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
    const diaryTexto = extractDiaryWriteText(userText);
    if (diaryTexto) {
      await callPainelCommand(env, "anotar_diario", { texto: diaryTexto });
      return "Anotei no diário.";
    }
    if (/\bagenda\b|\bcompromisso/.test(n)) {
      const dia = /\bamanha\b/.test(n) ? "amanha" : "hoje";
      return await callPainelAgenda(env, dia);
    }
    if (/\btarefa/.test(n)) {
      let filtro = "";
      if (/\bandamento\b/.test(n)) filtro = "andamento";
      else if (/\bagora\b/.test(n)) filtro = "agora";
      else if (/\bhoje\b/.test(n)) filtro = "hoje";
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

// ─────────────────────────────────────────────────────────────────────────
// F2-2 — consolidação: disparada pelo APP (nunca pelo servidor), usa o Diário do
// Jarbas (F2-1, log_read) como contexto extra. O Worker só CALCULA e devolve —
// nunca grava em jarbas_memory_v1, só o app sobrescreve esse blob.
// ─────────────────────────────────────────────────────────────────────────
async function callPainelLogRead(env, desde, ate, limite) {
  const params = new URLSearchParams({ action: "log_read", desde, ate, limite: String(limite || 500) });
  const data = await fetchPainelJson(`${PAINEL_API_URL}?${params.toString()}`, {
    headers: { "x-jarbas-key": env.PAINEL_API_KEY }, // log_read não exige a chave, mas não atrapalha mandar
  });
  return Array.isArray(data?.eventos) ? data.eventos : [];
}

function itemsToConsolidationText(items) {
  return (Array.isArray(items) ? items : []).slice(0, 200).map((i) => {
    const idade = itemAgeLabel(i.at);
    return `[${i.id}] (${i.kind || "episodico"}, imp${i.importance || 1}, ${i.status || "ativo"}, ${idade}) ${String(i.text || "").slice(0, 150)}`;
  }).join("\n");
}

function logEventsToConsolidationText(eventos) {
  return (Array.isArray(eventos) ? eventos : []).slice(0, 150)
    .map((e) => `- [${e.tipo}/${e.origem}] ${String(e.resumo || "").slice(0, 150)}`)
    .join("\n");
}

const CONSOLIDATION_PROMPT = (hojeISO) => `Você é o processo de consolidação de memória do Jarbas, um companheiro de voz. Hoje é ${hojeISO}. Você recebe: (1) a lista atual de itens de memória, cada um com um id entre colchetes; (2) as últimas mensagens da conversa; (3) um resumo do que aconteceu nos últimos 7 dias (conversas, ações, leituras, mudanças no painel — o Diário do Jarbas). Sua tarefa é ORGANIZAR a memória — NUNCA apagar nada, só reorganizar e enriquecer.

Faça isso, cada item de cada categoria abaixo:
a) mesclar: itens duplicados ou muito parecidos — escolha um id pra manter (manterId) e liste os outros ids como descartados (descartarIds; eles serão arquivados, nunca apagados).
b) promover: itens que se repetem bastante ou são claramente permanentes (trabalho, relacionamento, característica, preferência) — promova de "episodico" pra "duradouro" (id + novoTipo:"duradouro").
c) arquivar: ids de itens pontuais/episódicos que claramente já passaram (um evento específico que já aconteceu e não tem mais relevância prática pra conversas futuras) — NUNCA arquive um item "duradouro" ou uma "correcao" importante.
d) contradicoes: quando um fato novo (da conversa recente ou do Diário) contradiz um item antigo da lista — crie o fato novo e correto (texto, entidades, importancia:3) e arquive o antigo (arquivarId).
e) novos: itens novos que apareceram na conversa recente ou nas ações do painel (Diário) e ainda não estão na lista de memória (texto, tipo, importancia, entidades, followUp se for pendência).
f) insights: padrões ou conexões reais que você percebeu olhando o conjunto (ex: "costuma estudar nos fins de semana antes de provas", "gasta mais com X no fim do mês") — só inclua se for um padrão de verdade baseado no que foi passado, nunca invente (texto, importancia, entidades).
g) pendencias: compromissos que a pessoa disse que ia cumprir e ainda não resolveu ("vou ligar pro Pedro na sexta") — com a data em que deve ser lembrada (followUp, formato AAAA-MM-DD, calculado a partir de hoje) (texto, followUp, entidades).

Responda SOMENTE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato (todo campo é array, exceto resumo; devolva [] pra categoria sem nada):
{"mesclar":[{"manterId":"...","descartarIds":["..."]}],"promover":[{"id":"...","novoTipo":"duradouro"}],"arquivar":["id1","id2"],"contradicoes":[{"texto":"...","entidades":["..."],"importancia":3,"arquivarId":"..."}],"novos":[{"texto":"...","tipo":"episodico","importancia":2,"entidades":["..."]}],"insights":[{"texto":"...","importancia":2,"entidades":["..."]}],"pendencias":[{"texto":"...","followUp":"AAAA-MM-DD","entidades":["..."]}],"resumo":"frase curta resumindo o que mudou nessa consolidação"}

Nunca invente fatos que não estejam implícitos no que foi passado abaixo.`;

const CONSOLIDATION_EMPTY_RESULT = { mesclar: [], promover: [], arquivar: [], novos: [], insights: [], pendencias: [], contradicoes: [], resumo: "" };

async function runConsolidation(env, items, messages, hojeISO) {
  const plainMessages = (Array.isArray(messages) ? messages : []).slice(-40).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 500),
  }));

  let eventosTexto = "";
  try {
    const hoje = new Date();
    const seteDiasAtras = new Date(hoje.getTime() - 7 * 24 * 60 * 60 * 1000);
    const eventos = await callPainelLogRead(env, seteDiasAtras.toISOString().slice(0, 10), hoje.toISOString().slice(0, 10), 500);
    eventosTexto = logEventsToConsolidationText(eventos);
  } catch (err) {
    console.error("consolidation_log_read_failed:", String(err?.message || err));
  }

  const itemsTexto = itemsToConsolidationText(items);
  const userContent = [
    `ITENS DE MEMÓRIA ATUAIS:\n${itemsTexto || "(nenhum item ainda)"}`,
    eventosTexto ? `\nÚLTIMOS 7 DIAS (Diário do Jarbas):\n${eventosTexto}` : "",
  ].join("\n");

  let raw;
  try {
    raw = await callGroq(env, CONSOLIDATION_PROMPT(hojeISO), [...plainMessages, { role: "user", content: userContent }], 900);
  } catch (err) {
    console.error("consolidation_llm_failed:", String(err?.message || err));
    return CONSOLIDATION_EMPTY_RESULT;
  }

  const clean = raw.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return CONSOLIDATION_EMPTY_RESULT;
  }
  if (!parsed || typeof parsed !== "object") return CONSOLIDATION_EMPTY_RESULT;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    mesclar: arr(parsed.mesclar),
    promover: arr(parsed.promover),
    arquivar: arr(parsed.arquivar).filter((id) => typeof id === "string"),
    novos: arr(parsed.novos),
    insights: arr(parsed.insights),
    pendencias: arr(parsed.pendencias),
    contradicoes: arr(parsed.contradicoes),
    resumo: typeof parsed.resumo === "string" ? parsed.resumo : "",
  };
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

// ---------- F2-3b: núcleo de dados do dia, compartilhado entre o briefing matinal
// (cron + "ouvir agora") e a rotina de voz "bom dia" — assim os dois contam a MESMA
// coisa sobre agenda/tarefas/contas/pendências, nunca duas lógicas divergentes. ----------
async function gatherDayData(env, { items, hojeISO } = {}) {
  const [agendaTexto, tarefasTexto] = await Promise.all([
    callPainelAgenda(env, "hoje").catch((err) => `Agenda: não consegui consultar agora (${String(err.message || err)}).`),
    callPainelTasks(env, "hoje").catch((err) => `Tarefas: não consegui consultar agora (${String(err.message || err)}).`),
  ]);

  let contasTextos = [];
  let tarefasItens = [];
  let contasItens = [];
  let idsContasVivas = new Set();
  let idsTarefasVivas = new Set();
  try {
    const mudancas = await fetchPainelJson(`${PAINEL_API_URL}?action=mudancas`, { headers: { "x-jarbas-key": env.PAINEL_API_KEY } });
    const triggers = computeDeterministicTriggers(mudancas);
    contasTextos = triggers.filter((g) => g.tipo === "conta").map((g) => g.texto);
    idsContasVivas = new Set(triggers.filter((g) => g.tipo === "conta").map((g) => g.id));
    idsTarefasVivas = new Set(triggers.filter((g) => g.tipo === "tarefa").map((g) => g.id));
    // PARTE B: tarefas/contas ESTRUTURADAS (com status), pro cartão do resumo do dia e
    // pro fallback determinístico contarem/destacarem em vez de despejar texto cru.
    // PARTE E: contasItens também alimenta ?action=telas (contas.vencendo/total).
    tarefasItens = Array.isArray(mudancas?.tarefas?.itens) ? mudancas.tarefas.itens : [];
    contasItens = Array.isArray(mudancas?.contas?.itens) ? mudancas.contas.itens : [];
  } catch (err) {
    console.error("gather_day_data_contas_failed:", String(err?.message || err));
  }

  const dia = hojeISO || saoPauloNow().dateStr;
  const pendenciasTextos = selecionarPendenciasVencidas(items, dia).map((p) => `"${p.text}"`);

  return { agendaTexto, tarefasTexto, tarefasItens, contasItens, contasTextos, pendenciasTextos, idsContasVivas, idsTarefasVivas };
}

// ---------- PARTE E: ?action=telas (mode "telas") — dados REAIS pras telas ao redor
// do rosto no app (agenda, tarefas, contas), sem IA; cache de 5 min no KV pra não bater
// o painel a cada abertura/poll do app. Notícias e mercado não têm fonte configurada
// hoje — nunca inventa dados de exemplo, devolve listas vazias (o app esconde a tela). ----------
const TELAS_CACHE_KEY = "telas:cache";
const TELAS_CACHE_TTL_MS = 5 * 60 * 1000;

export function construirTelasTarefas(tarefasItens) {
  const itens = Array.isArray(tarefasItens) ? tarefasItens : [];
  const porColuna = {};
  for (const t of itens) {
    const col = (t && t.status) || "outro";
    porColuna[col] = (porColuna[col] || 0) + 1;
  }
  return { porColuna };
}

export function construirTelasContas(contasItens, dayOfMonth) {
  const itens = Array.isArray(contasItens) ? contasItens : [];
  let vencendo = 0;
  for (const c of itens) {
    if (!c || c.status !== "pendente" || !c.data) continue;
    const dueDay = parseInt(c.data, 10);
    if (Number.isFinite(dueDay) && dueDay <= dayOfMonth) vencendo++;
  }
  return { vencendo, total: itens.length };
}

// Primeiro item da agenda (já ordenada por horário) que ainda não passou — minutos até
// ele. null se não houver mais nada hoje (nunca inventa "nada mais hoje" aqui; isso é
// decisão de exibição do app, não do Worker).
export function calcularProximoEmMin(agendaItens, agoraMin) {
  const itens = Array.isArray(agendaItens) ? agendaItens : [];
  for (const it of itens) {
    const m = /^(\d{2}):(\d{2})$/.exec(it && it.hora || "");
    if (!m) continue;
    const diff = Number(m[1]) * 60 + Number(m[2]) - agoraMin;
    if (diff >= 0) return diff;
  }
  return null;
}

async function montarTelasDados(env, companionState) {
  const { agendaTexto, tarefasItens, contasItens } = await gatherDayData(env, { items: companionState?.items });
  const agendaCompleta = parseAgendaTexto(agendaTexto);
  const { hour, minute, dayOfMonth } = saoPauloNow();
  return {
    agenda: agendaCompleta.slice(0, 4),
    proximoEmMin: calcularProximoEmMin(agendaCompleta, hour * 60 + minute),
    tarefas: construirTelasTarefas(tarefasItens),
    contas: construirTelasContas(contasItens, dayOfMonth),
    noticias: [],
    mercado: [],
  };
}

export async function montarTelasCached(env, companionState) {
  let cached = null;
  try {
    const raw = env.COMPANION_KV && (await env.COMPANION_KV.get(TELAS_CACHE_KEY));
    if (raw) cached = JSON.parse(raw);
  } catch (err) {
    console.error("montar_telas_cache_read_failed:", String(err?.message || err));
  }
  if (cached && Date.now() - cached.cachedAt < TELAS_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await montarTelasDados(env, companionState);
  try {
    if (env.COMPANION_KV) await env.COMPANION_KV.put(TELAS_CACHE_KEY, JSON.stringify({ data, cachedAt: Date.now() }));
  } catch (err) {
    console.error("montar_telas_cache_write_failed:", String(err?.message || err));
  }
  return data;
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
      try {
        const { agendaTexto, tarefasTexto, contasTextos, pendenciasTextos } = await gatherDayData(env, { items: companionState?.items });
        let texto = `Agenda: ${agendaTexto}\nTarefas: ${tarefasTexto}`;
        if (contasTextos.length) texto += `\nContas: ${contasTextos.join(" ")}`;
        if (pendenciasTextos.length) texto += `\nPendências que a pessoa tinha dito que ia resolver: ${pendenciasTextos.join(" ")}`;
        parts.push(`Painel pessoal (agenda, tarefas, contas e pendências):\n${texto}`);
      } catch (err) { parts.push(`Painel pessoal: não consegui consultar agora (${String(err.message || err)}).`); }
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

const BRIEFING_PROMPT = `Você é o Jarbas, um companheiro de voz caloroso e afetuoso, dando bom dia pra pessoa com o resumo do dia dela. Você vai receber dados brutos já verificados (clima, agenda, tarefas, contas, pendências que ela tinha dito que ia resolver, e coisas que aconteceram enquanto ela dormia). A fala tem NO MÁXIMO 450 caracteres, em 4 a 6 frases curtas e naturais, como um amigo contaria pela manhã num fôlego só — NUNCA leia listas inteiras nem mencione fontes técnicas ("segundo o painel"). Diga só o que importa: o primeiro compromisso, quantas tarefas pedem atenção, e 2 ou 3 destaques — o resto fica disponível num cartão na tela, você não precisa (e não deve) falar tudo. Se algum dado vier vazio ou "não consegui consultar", simplesmente não mencione essa parte. Se não houver nada urgente, seja breve e leve, sem inventar urgência que não existe.
Fale português do Brasil, em frases curtas e naturais para serem faladas em voz alta.
Responda SEMPRE em JSON puro, numa única linha, sem markdown, sem crases, exatamente neste formato:
{"title":"Bom dia","fala":"texto curto da fala, até 450 caracteres"}
Nunca deixe o JSON incompleto.`;

// ---------- F2-3b/PARTE B: monta o briefing matinal — SEM IA reúne os dados (clima,
// agenda, tarefas, contas, pendências, fila de avisos adiados durante o sono) e monta o
// `card` (estrutura completa, pro pop-up/cartão) sempre determinístico. Só então faz UMA
// chamada ao modelo pra narrar a `fala` curta. Se a chamada falhar ou vier longa demais,
// cai pro texto determinístico puro (montarBriefingDeterministico) — nunca fica sem
// briefing só porque o LLM falhou, e nunca fala a lista crua (ver bug real: o resumo
// aparecia como um bloco gigante cobrindo o rosto e era lido inteiro em voz alta). ----------
async function gerarBriefing(env, config, companionState) {
  const cidade = companionState?.location?.cidade || "";
  let climaTexto = "";
  if (cidade) {
    try { climaTexto = await callWeather(cidade); }
    catch (err) { console.error("briefing_clima_failed:", String(err?.message || err)); }
  }

  const { dateStr: hoje } = saoPauloNow();
  const { agendaTexto, tarefasTexto, tarefasItens, contasTextos, pendenciasTextos, idsContasVivas, idsTarefasVivas } =
    await gatherDayData(env, { items: companionState?.items, hojeISO: hoje });

  const agoraMin = minutesOfDaySaoPaulo(new Date());
  const filaBruta = await readPushQueue(env);
  const filaFiltrada = filtrarFilaParaBriefing(filaBruta, { hoje, agoraMin, idsContasVivas, idsTarefasVivas });

  const determinado = montarBriefingDeterministico({ climaTexto, agendaTexto, tarefasItens, contasTextos, pendenciasTextos, filaItens: filaFiltrada });

  let llmCalls = 0;
  try {
    const filaTextos = filaFiltrada.map((item) => item.texto);
    const content = `Clima: ${climaTexto || "(sem dados)"}\nAgenda de hoje: ${agendaTexto}\nTarefas de hoje: ${tarefasTexto}\nContas do dia/atrasadas: ${contasTextos.join(" ") || "(nenhuma)"}\nPendências que ela tinha dito que ia resolver: ${pendenciasTextos.join(" ") || "(nenhuma)"}\nEnquanto ela dormia: ${filaTextos.join(" ") || "(nada)"}`;
    const raw = await callGroq(env, BRIEFING_PROMPT, [{ role: "user", content }], 400);
    llmCalls = 1;
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (!parsed.fala) throw new Error("no_fala_field");
    const fala = truncarNaUltimaFrase(parsed.fala, 450);
    return { title: parsed.title || "Bom dia", fala, card: determinado.card, body: truncarNaUltimaFrase(fala, 140), llmCalls };
  } catch (err) {
    console.error("briefing_llm_failed, usando texto determinístico:", String(err?.message || err));
    return { ...determinado, llmCalls };
  }
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
  anotar_no_diario: "acao_pedida", desfazer_anotacao_diario: "acao_pedida", corrigir_anotacao_diario: "acao_pedida",
  gerenciar_ideia: "acao_pedida", gerenciar_lembrete: "acao_pedida",
  gerenciar_lista: "acao_pedida", concluir_recado: "acao_pedida", guardar_memoria: "acao_pedida", ensinar_regra: "acao_pedida",
  definir_sono: "acao_pedida", atualizar_pendencia: "acao_pedida", materializar: "acao_pedida", lousa: "acao_pedida",
};

async function runTool(env, call, canSearch, canPainel, companionState = {}, lastUserText = "") {
  const name = call.function.name;
  let args = {};
  try { args = JSON.parse(call.function.arguments); } catch {}

  try {
    if (name === "previsao_do_tempo") {
      const cidade = args.cidade || companionState.location?.cidade || "";
      if (!cidade) return { content: "Não sei a cidade da pessoa ainda — peça pra ela informar a cidade, ou avise que ela pode ativar a localização nas configurações." };
      const climaTexto = await callWeather(cidade);
      return { content: climaTexto, card: construirCardClima(climaTexto) };
    }
    if (name === "buscar_na_web" && canSearch) return { content: await callTavily(env, args.query || "") };
    if (name === "consultar_painel" && canPainel) return { content: await callPainelSnapshot(env, args.dia || "") };
    if (name === "consultar_agenda" && canPainel) {
      const agendaTexto = await callPainelAgenda(env, args.dia || "");
      return { content: agendaTexto, card: construirCardAgendaHoje(agendaTexto, args.dia || "hoje") };
    }
    if (name === "gerenciar_tarefa" && canPainel) return { content: await callPainelCommand(env, TAREFA_ACAO_MAP[args.acao], { texto: args.texto }) };
    if (name === "gerenciar_conta" && canPainel) return { content: await callPainelCommand(env, CONTA_ACAO_MAP[args.acao], { nome: args.nome }) };
    if (name === "gerenciar_compromisso" && canPainel) return { content: await callPainelCommand(env, COMPROMISSO_ACAO_MAP[args.acao], { titulo: args.titulo, data: args.data, hora: args.hora }) };
    if (name === "anotar_no_diario" && canPainel) {
      const texto = (args.texto || "").trim();
      if (isDiaryTextObviouslyIncomplete(texto)) {
        return { content: "Não anotei nada — o texto pedido parece incompleto ou cortado. Pergunte à pessoa qual é a frase completa antes de tentar de novo." };
      }
      await callPainelCommand(env, "anotar_diario", { texto, humor: args.humor });
      return { content: `Anotei: "${texto}"` };
    }
    if (name === "desfazer_anotacao_diario" && canPainel) {
      const data = await callPainelCommandFull(env, "desfazer_diario", {});
      if (data?.ok) return { content: `Desfiz a anotação: "${data.texto}"` };
      return { content: `Não consegui desfazer: ${data?.motivo || "não achei nenhuma anotação minha recente pra desfazer."}` };
    }
    if (name === "corrigir_anotacao_diario" && canPainel) {
      const novoTexto = (args.novo_texto || "").trim();
      if (isDiaryTextObviouslyIncomplete(novoTexto)) {
        return { content: "Não corrigi nada — o novo texto pedido parece incompleto ou cortado. Pergunte à pessoa qual é a frase completa antes de tentar de novo." };
      }
      const data = await callPainelCommandFull(env, "corrigir_diario", { novoTexto });
      if (data?.ok) return { content: `Corrigi a anotação para: "${data.texto}"` };
      return { content: `Não consegui corrigir: ${data?.motivo || "não achei nenhuma anotação minha recente pra corrigir."}` };
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
      // Aceita o campo antigo `fact` também (modelo em cache/few-shot pode ainda mandar
      // assim) — nunca quebra por causa de um nome de campo desatualizado.
      const texto = (args.texto || args.fact || "").trim();
      if (!texto) return { content: "Fato vazio, nada guardado." };
      const tipo = ["duradouro", "episodico", "correcao", "pendencia"].includes(args.tipo) ? args.tipo : "episodico";
      const importancia = Math.min(3, Math.max(1, parseInt(args.importancia, 10) || (tipo === "correcao" ? 3 : 2)));
      const entidades = Array.isArray(args.entidades)
        ? args.entidades.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim()).slice(0, 8)
        : [];
      const followUpAt = tipo === "pendencia" && /^\d{4}-\d{2}-\d{2}$/.test(args.followUp || "") ? args.followUp : null;
      return {
        content: "Guardado (não fale sobre essa anotação, é de bastidor).",
        memoryFact: texto, // compat: continua alimentando mem.timeline como antes
        memoryItem: { texto, tipo, importancia, entidades, followUpAt },
      };
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
    if (name === "definir_sono") {
      const estado = args.estado === "dormir" ? "dormindo" : args.estado === "acordar" ? "acordado" : null;
      if (!estado) return { content: "Não entendi se era pra dormir ou acordar." };
      await writeSleepState(env, estado);
      return { content: estado === "dormindo" ? "Boa noite registrada — vou ficar quieto, só te acordo se for importante de verdade." : "Bom dia registrado — tô de volta." };
    }
    if (name === "atualizar_pendencia") {
      const id = (args.id || "").trim();
      const status = ["feito", "adiado", "cancelado"].includes(args.status) ? args.status : null;
      if (!id || !status) return { content: "Faltou o id ou o status da pendência — não consegui atualizar." };
      const novaData = status === "adiado" && /^\d{4}-\d{2}-\d{2}$/.test(args.nova_data || "") ? args.nova_data : null;
      // O Worker nunca escreve em mem.items (único escritor é o app) — só sinaliza o
      // que deve ser aplicado; pendenciaUpdate sobe até a resposta final (pendencia_update).
      return {
        content: `Pendência atualizada pra "${status}"${novaData ? ` (nova data ${novaData})` : ""}.`,
        pendenciaUpdate: { id, status, novaData },
      };
    }
    if (name === "materializar") {
      const origem = classificarOrigemMaterializar(lastUserText, companionState);
      if (materializarEspontaneoBloqueado(origem, lastUserText, companionState)) {
        return { content: "Agora não é hora de materializar por conta própria — ignore isso e responda só com a fala, sem mencionar essa tentativa." };
      }
      const materialize = construirMaterializeFromArgs(args, origem);
      if (!materialize) {
        return { content: "Não deu pra montar uma cena válida pra materializar — responda só com a fala, sem mencionar essa tentativa." };
      }
      return { content: `Vai aparecer na tela: "${materialize.titulo}" (${materialize.motivo}). Siga a fala normalmente, sem anunciar que usou uma ferramenta.`, materialize };
    }
    if (name === "lousa") {
      const lousa = construirLousaFromArgs(args);
      if (!lousa) {
        return { content: "Não deu pra montar uma lousa válida — responda só com a fala, sem mencionar essa tentativa." };
      }
      return { content: `Lousa aberta: "${lousa.titulo}". Siga a fala normalmente, curta — a lousa ilustra, não substitui a resposta.`, lousa };
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
  const tools = [WEATHER_TOOL, GUARDAR_MEMORIA_TOOL, ENSINAR_REGRA_TOOL, RESUMIR_LINK_TOOL, DEFINIR_SONO_TOOL, ATUALIZAR_PENDENCIA_TOOL, MATERIALIZAR_TOOL, LOUSA_TOOL];
  if (canSearch) tools.push(SEARCH_TOOL);
  if (canPainel) {
    tools.push(
      CONSULTAR_PAINEL_TOOL, CONSULTAR_AGENDA_TOOL, GERENCIAR_TAREFA_TOOL, GERENCIAR_CONTA_TOOL, GERENCIAR_COMPROMISSO_TOOL,
      ANOTAR_DIARIO_TOOL, DESFAZER_ANOTACAO_DIARIO_TOOL, CORRIGIR_ANOTACAO_DIARIO_TOOL,
      CONSULTAR_TAREFAS_TOOL, CONSULTAR_IDEIAS_TOOL, GERENCIAR_IDEIA_TOOL, CONSULTAR_LEMBRETES_TOOL, GERENCIAR_LEMBRETE_TOOL,
      CONSULTAR_LISTAS_TOOL, GERENCIAR_LISTA_TOOL, CONSULTAR_RECADOS_TOOL, CONCLUIR_RECADO_TOOL, CONSULTAR_EMAIL_TOOL
    );
  }
  return tools;
}

// Subconjunto de ferramentas por intenção, via regra simples de palavras-chave sobre o
// último texto do usuário — evita mandar as ~20 ferramentas em toda chamada, mesmo em
// papo casual. guardar_memoria/ensinar_regra/definir_sono sempre entram; se nada casar,
// conjunto mínimo (esses três + consultar_painel). Isso é uma heurística, não entendimento
// de linguagem — por isso callGroqWithSearch reenvia com o conjunto completo se o
// modelo pedir uma ferramenta que não foi incluída aqui.
function selectToolsForMessage(userText, canSearch, canPainel, companionState = {}) {
  const n = normalizeText(userText);
  const selected = new Set([GUARDAR_MEMORIA_TOOL, ENSINAR_REGRA_TOOL, DEFINIR_SONO_TOOL, ATUALIZAR_PENDENCIA_TOOL]);
  let matchedAny = false;
  const add = (...toolsToAdd) => { toolsToAdd.forEach((t) => selected.add(t)); matchedAny = true; };

  if (canPainel && /\b(agenda|compromisso)/.test(n)) add(CONSULTAR_PAINEL_TOOL, CONSULTAR_AGENDA_TOOL, GERENCIAR_COMPROMISSO_TOOL);
  if (canPainel && /\btarefa/.test(n)) add(CONSULTAR_PAINEL_TOOL, CONSULTAR_TAREFAS_TOOL, GERENCIAR_TAREFA_TOOL);
  if (canPainel && /\bconta(s)?\b/.test(n)) add(CONSULTAR_PAINEL_TOOL, GERENCIAR_CONTA_TOOL);
  if (canPainel && /\bdiari/.test(n)) add(ANOTAR_DIARIO_TOOL, DESFAZER_ANOTACAO_DIARIO_TOOL, CORRIGIR_ANOTACAO_DIARIO_TOOL);
  // Mesmo sem a palavra "diário" — um pedido de seguimento tipo "apaga essa última
  // atualização e adiciona uma nova" (depois de já ter pedido pra anotar algo antes)
  // também precisa oferecer desfazer/corrigir, não só o genérico.
  if (canPainel && /\b(apaga|apague|desfaz|desfez|desfazer|remove|removeu|remova|corrige|corrigiu|corrigir|troca|trocar|troque)\b/.test(n)) {
    add(DESFAZER_ANOTACAO_DIARIO_TOOL, CORRIGIR_ANOTACAO_DIARIO_TOOL);
  }
  if (canPainel && /\bideia/.test(n)) add(CONSULTAR_IDEIAS_TOOL, GERENCIAR_IDEIA_TOOL);
  if (canPainel && /\blembret/.test(n)) add(CONSULTAR_LEMBRETES_TOOL, GERENCIAR_LEMBRETE_TOOL);
  if (canPainel && /\blista/.test(n)) add(CONSULTAR_LISTAS_TOOL, GERENCIAR_LISTA_TOOL);
  if (canPainel && (n.includes("email") || n.includes("e mail") || n.includes("caixa de entrada"))) add(CONSULTAR_EMAIL_TOOL);
  if (canPainel && /\brecado/.test(n)) add(CONSULTAR_RECADOS_TOOL, CONCLUIR_RECADO_TOOL);
  if (/\b(clima|tempo|chuva|previsao)\b/.test(n)) add(WEATHER_TOOL);
  if (canSearch && /\b(pesquis|busca|noticia)/.test(n)) add(SEARCH_TOOL);
  if (n.includes("http") || n.includes("www") || /\blink/.test(n)) add(RESUMIR_LINK_TOOL);
  // "resum" sozinho é ambíguo (pode ser resumo de texto/link) mas materializar também
  // cobre "resumo visual da conversa" — e espontâneo precisa da ferramenta disponível
  // mesmo sem nenhuma palavra-gatilho na mensagem.
  if (MATERIALIZAR_PEDIDO_REGEX.test(n) || /\bresum/.test(n) || companionState?.podeMaterializarEspontaneo) add(MATERIALIZAR_TOOL);
  if (LOUSA_PEDIDO_REGEX.test(n)) add(LOUSA_TOOL);

  if (!matchedAny && canPainel) selected.add(CONSULTAR_PAINEL_TOOL);
  return Array.from(selected);
}

async function callGroqWithSearch(env, systemPrompt, messages, maxTokens, companionState = {}, logBatch = null) {
  const baseMessages = [{ role: "system", content: systemPrompt }, ...messages];
  const canSearch = !!env.TAVILY_API_KEY;
  const canPainel = !!env.PAINEL_API_KEY;
  const lastUserText = messages[messages.length - 1]?.content || "";

  let tools = selectToolsForMessage(lastUserText, canSearch, canPainel, companionState);
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

  // Rede de segurança: se a pessoa pediu explicitamente pra anotar algo no diário, a
  // escrita precisa acontecer de verdade nesta requisição — não basta o modelo "lembrar"
  // de chamar a ferramenta, porque ele às vezes confirma de boca sem chamar nada (ver
  // instrução "nunca diga que fez" no prompt de personalidade, que nem sempre é seguida).
  // Checado só na hora de devolver a resposta final, depois de ver se algum tool_call
  // desta mesma resposta já cobriu isso.
  const diaryTexto = extractDiaryWriteText(lastUserText);
  const finish = async (text, saveMemory, saveLearned, saveMemoryItem, savePendenciaUpdate, materialize, cards, lousa) => {
    if (diaryTexto && canPainel && !toolsUsed.includes("anotar_no_diario")) {
      try {
        await callPainelCommand(env, "anotar_diario", { texto: diaryTexto });
        toolsUsed.push("anotar_no_diario");
        pushLogEvent(logBatch, {
          tipo: "acao_pedida", origem: "jarbas",
          resumo: `Executou "anotar_no_diario" (rede de segurança: pedido explícito não gerou chamada de ferramenta do modelo).`,
          detalhes: { ferramenta: "anotar_no_diario", ok: true, redeSeguranca: true },
        });
      } catch (err) {
        console.error("diary_safety_net_failed:", String(err?.message || err));
      }
    }
    // PARTE C: rede de segurança — pedido explícito de materializar ("materialize uma
    // bola") que o modelo respondeu só com emoji, sem chamar a ferramenta de verdade.
    // Materializa por conta própria aqui e troca a fala por uma confirmação curta —
    // materializar é ação, nunca só um emoji falado/escrito.
    if (!materialize && MATERIALIZAR_PEDIDO_REGEX.test(normalizeText(lastUserText)) && respostaSoEmoji(text)) {
      materialize = construirMaterializeDeRespostaEmoji(text);
      text = "Pronto, aqui está!";
      pushLogEvent(logBatch, {
        tipo: "acao_pedida", origem: "jarbas",
        resumo: `Rede de segurança: pedido de materializar respondido só com emoji — materializado "${materialize.titulo}" automaticamente.`,
        detalhes: { ferramenta: "materializar", redeSeguranca: true, criacao: materialize },
      });
    }
    logCalls();
    return { text, saveMemory, saveLearned, saveMemoryItem, savePendenciaUpdate, materialize: materialize || null, cards: (cards || []).slice(0, 2), lousa: lousa || null, metrics: metrics() };
  };

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
    let saveMemoryItem = null;
    let savePendenciaUpdate = null;
    let materialize = null;
    let cards = [];
    let lousa = null;
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
          result = await runTool(env, call, canSearch, canPainel, companionState, lastUserText);
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
          } else if (name === "materializar") {
            const criacao = result.materialize || null;
            const tipoDiario = criacao?.origem === "espontaneo" ? "acao_espontanea" : "acao_pedida";
            pushLogEvent(logBatch, {
              tipo: tipoDiario, origem: "jarbas",
              resumo: criacao ? `Materializou "${criacao.titulo}" (${criacao.origem}): ${criacao.motivo || ""}`.trim() : `Tentou materializar, mas não gerou nada válido.`,
              detalhes: { ferramenta: name, ok: !!criacao, criacao },
            });
          } else if (name === "lousa") {
            const lousaCriada = result.lousa || null;
            pushLogEvent(logBatch, {
              tipo: "acao_pedida", origem: "jarbas",
              resumo: lousaCriada ? `Abriu a lousa "${lousaCriada.titulo}" (${lousaCriada.itens.length} item(ns)).` : `Tentou abrir a lousa, mas não gerou nada válido.`,
              detalhes: { ferramenta: name, ok: !!lousaCriada, lousa: lousaCriada },
            });
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
      if (result.memoryItem) saveMemoryItem = result.memoryItem;
      if (result.pendenciaUpdate) savePendenciaUpdate = result.pendenciaUpdate;
      if (result.materialize) materialize = result.materialize;
      // PARTE D: cartões de dados — determinísticos, montados a partir do que a
      // ferramenta JÁ buscou nesta mesma resposta (nunca uma chamada de LLM extra).
      if (result.card) cards.push(result.card);
      if (result.lousa) lousa = result.lousa;
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
        return finish(secondContent, saveMemory, saveLearned, saveMemoryItem, savePendenciaUpdate, materialize, cards, lousa);
      }
      // Modelo devolveu vazio depois da ferramenta — tenta mais uma vez, sem margem pra ele "pensar" demais
      const text = await retrySpeech();
      return finish(text, saveMemory, saveLearned, saveMemoryItem, savePendenciaUpdate, materialize, cards, lousa);
    } catch (err) {
      console.error("callGroqWithSearch_second_call_failed, repetindo só a fala:", String(err?.message || err));
      pushLogEvent(logBatch, { tipo: "erro", origem: "jarbas", resumo: "Segunda chamada ao LLM falhou, repetindo só a fala.", detalhes: { erro: String(err?.message || err).slice(0, 200) } });
      const text = await retrySpeech();
      return finish(text, saveMemory, saveLearned, saveMemoryItem, savePendenciaUpdate, materialize, cards, lousa);
    }
  }

  return finish(msg?.content?.trim() || "Só um instante, deixa eu organizar o pensamento — pode repetir?", null, null, null, null, null, [], null);
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
    const err = new Error(`push_send_failed_${res.status}: ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

// Envia pra TODAS as assinaturas (F2-3a: vários aparelhos) — uma falha numa nunca
// impede as outras. 404/410 (RFC 8030: o navegador cancelou/expirou a inscrição) são
// erro PERMANENTE, a assinatura é removida da lista; qualquer outro status (erro
// transiente de rede, 5xx do serviço de push) nunca remove nada, só loga.
export async function sendWebPushToAll(env, subscriptions, payloadObj, sendFn = sendWebPush) {
  let entregues = 0;
  const endpointsParaRemover = [];
  for (const sub of subscriptions) {
    try {
      await sendFn(env, sub, payloadObj);
      entregues++;
    } catch (err) {
      const status = err?.status;
      if (status === 404 || status === 410) {
        endpointsParaRemover.push(sub.endpoint);
      } else {
        console.error("push_send_failed (aparelho):", String(err?.message || err));
      }
    }
  }
  return { entregues, endpointsParaRemover };
}

// Chave antiga (uma assinatura só) — mantida só pra migração automática em
// loadPushSubscriptions, nunca mais escrita depois da F2-3a.
const PUSH_SUBSCRIPTION_KEY = "push:subscription";
const PUSH_SUBSCRIPTIONS_KEY = "push:subscriptions";
const PUSH_SUBSCRIPTIONS_MAX = 5;
const PUSH_NOTIFY_STATE_KEY = "push:notify_state";
const PUSH_DEDUPE_MS = 3 * 60 * 60 * 1000; // não repete o mesmo aviso por 3h
const PUSH_QUEUE_KEY = "push:fila";
const PUSH_QUEUE_MAX = 20;
const SLEEP_STATE_KEY = "sleep:state";
const ACTIVITY_LAST_KEY = "activity:last";
const CONFIG_CACHE_KEY = "config:cache";
const CONFIG_CACHE_TTL_MS = 60 * 60 * 1000; // lê mem.config/items via callPainelMemoryLoad no máx 1x/hora
const BRIEFING_LAST_KEY = "briefing:ultimo";
const PENDENCIA_CHECK_KEY = "pendencia:ultima_checagem"; // throttle de 1x/hora, independente do cache de config/items
const PENDENCIA_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PENDENCIA_AVISADA_TTL_S = 60 * 24 * 60 * 60; // 60 dias — bem mais que o suficiente pra não avisar 2x a mesma pendência

function saoPauloNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { dateStr: `${get("year")}-${get("month")}-${get("day")}`, dayOfMonth: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")) };
}

// ---------- F2-3a: sono (Jarbas "dorme quando o Gustavo dorme") ----------
// Tudo abaixo até sendWebPushToAll é lógica PURA (sem KV, sem rede) — fácil de testar
// isolada. Padrões editáveis em Configurações do app (mem.config); estes aqui só
// entram quando a config ainda não tem o campo (primeira vez, ou leitura falhou).
export const SONO_DEFAULTS = {
  sonoInicio: "23:00",
  sonoFim: "07:00",
  maxAvisosDia: 5,
  antecedenciaCompromissoMin: 30,
  vigiaAtivo: true,
};

// ---------- F2-3b: briefing matinal e pendências com retorno ----------
export const BRIEFING_DEFAULTS = {
  briefingHora: "07:30",
  briefingAtivo: true,
  pendenciasAtivas: true,
};

export function parseHHMMToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Janela [startMin, endMin) que pode "virar a noite" (ex: 23:00 -> 07:00 cruza a
// meia-noite) — se start < end, janela normal; se start >= end, janela com wrap.
export function isMinuteInWindow(min, startMin, endMin) {
  if (startMin == null || endMin == null || min == null || startMin === endMin) return false;
  return startMin < endMin ? (min >= startMin && min < endMin) : (min >= startMin || min < endMin);
}

function minutesOfDaySaoPaulo(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return get("hour") * 60 + get("minute");
}

function dateStrSaoPauloFrom(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// "Hoje às 05:00" no fuso de São Paulo (fixo UTC-3, sem horário de verão desde 2019),
// no MESMO dia local de `agora`. Usado só como peça do cálculo de "próximo 05:00
// depois de X" abaixo — não mais como limiar direto do estado explícito (ver
// correção F2-3a: "vou dormir" à noite só valia depois da meia-noite).
function limiar5hSaoPaulo(agora) {
  return new Date(`${dateStrSaoPauloFrom(agora)}T05:00:00-03:00`).getTime();
}

// Primeiro 05:00 (São Paulo) que acontece DEPOIS de `desdeMs` — se `desde` já é de
// madrugada antes das 5h (ex: 03h), o 05:00 daquele mesmo dia ainda serve; se `desde`
// é de tarde/noite (ex: 22:30), o 05:00 daquele dia já passou, então é o do dia seguinte.
function proximoLimiar5hAposSaoPaulo(desdeMs) {
  let limiar = limiar5hSaoPaulo(new Date(desdeMs));
  if (limiar <= desdeMs) limiar += 24 * 60 * 60 * 1000;
  return limiar;
}

// isDormindo({agora, config, explicito, explicitoDesde, ultimaAtividade}) — pura,
// testável isolada. explicito: "dormindo" | "acordado" | null (vem de sleep:state).
// explicitoDesde: ISO string de sleep:state.desde (quando foi dito "vou dormir"/
// "acordei") — opcional, por compatibilidade com chamadas antigas.
// ultimaAtividade: { usuarioAt, painelAt } (ISO strings ou null) — vem de activity:last.
export function isDormindo({ agora, config, explicito, explicitoDesde, ultimaAtividade }) {
  if (explicito === "acordado") return false; // override: encerra o sono sempre

  const agoraDate = agora instanceof Date ? agora : new Date(agora);
  const agoraMs = agoraDate.getTime();
  const usuarioMs = ultimaAtividade?.usuarioAt ? new Date(ultimaAtividade.usuarioAt).getTime() : 0;
  const painelMs = ultimaAtividade?.painelAt ? new Date(ultimaAtividade.painelAt).getTime() : 0;
  const ultimaAtividadeMs = Math.max(usuarioMs, painelMs, 0);

  const cfg = { ...SONO_DEFAULTS, ...(config || {}) };
  const startMin = parseHHMMToMinutes(cfg.sonoInicio);
  const endMin = parseHHMMToMinutes(cfg.sonoFim);

  if (explicito === "dormindo" && explicitoDesde) {
    const desdeMs = new Date(explicitoDesde).getTime();
    if (Number.isFinite(desdeMs)) {
      // "Sono da noite": `desde` cai perto do horário em que a pessoa costuma dormir
      // (até 2h antes do início configurado até o fim da janela) — dura até 14h e só
      // termina na primeira atividade depois de max(desde+10min, próximo 05:00 após
      // desde). Os 10 min ignoram a própria mensagem de "boa noite"; o limiar de 5h
      // ignora qualquer atividade de madrugada (ex: 03h) sem depender de "agora".
      const noiteStartMin = startMin == null ? null : ((startMin - 120) % 1440 + 1440) % 1440;
      const isSonoDaNoite = startMin != null && endMin != null
        && isMinuteInWindow(minutesOfDaySaoPaulo(new Date(desdeMs)), noiteStartMin, endMin);

      if (isSonoDaNoite) {
        const limiteDuracao = desdeMs + 14 * 60 * 60 * 1000;
        const limiarAtividade = Math.max(desdeMs + 10 * 60 * 1000, proximoLimiar5hAposSaoPaulo(desdeMs));
        if (agoraMs < limiteDuracao && ultimaAtividadeMs < limiarAtividade) return true;
      } else {
        // "Soneca": `desde` fora do horário noturno (ex: tarde) — dura no máx 4h e
        // termina na primeira atividade depois de desde+10min.
        const limiteDuracao = desdeMs + 4 * 60 * 60 * 1000;
        const limiarAtividade = desdeMs + 10 * 60 * 1000;
        if (agoraMs < limiteDuracao && ultimaAtividadeMs < limiarAtividade) return true;
      }
      // Nem noite nem soneca ainda em vigor (expirou ou já teve atividade depois do
      // limiar) — cai pra regra ambiente abaixo em vez de devolver false direto.
    }
  }

  if (isMinuteInWindow(minutesOfDaySaoPaulo(agoraDate), startMin, endMin)) {
    const minutosSemAtividade = ultimaAtividadeMs ? (agoraMs - ultimaAtividadeMs) / 60000 : Infinity;
    if (minutosSemAtividade >= 90) return true;
  }

  return false;
}

// Um compromisso/lembrete/alarme com horário `hhmm` "acorda" o Jarbas se cair dentro
// da janela de sono OU até 60 min depois do fim dela (ex: sono até 07:00 -> aceita
// até 08:00) — é esse horário que decide se o aviso pode furar o silêncio do sono.
export function eventoAcordaNoSono(hhmm, config) {
  const evMin = parseHHMMToMinutes(hhmm);
  if (evMin == null) return false;
  const cfg = { ...SONO_DEFAULTS, ...(config || {}) };
  const startMin = parseHHMMToMinutes(cfg.sonoInicio);
  const endMin = parseHHMMToMinutes(cfg.sonoFim);
  if (startMin == null || endMin == null) return false;
  const endEstendido = (endMin + 60) % 1440;
  return isMinuteInWindow(evMin, startMin, endEstendido);
}

// Prioritários = isentos do orçamento diário E os únicos que podem furar o sono.
// Hoje só "agenda" (compromissos) tem horário disponível no painel pra isso valer de
// verdade — "lembrete" e "alarme" já entram classificados aqui, prontos pro dia em
// que o painel passar a guardar horário de lembrete (ver observação no PR).
export function isPrioritarioTipo(tipo) {
  return tipo === "agenda" || tipo === "lembrete" || tipo === "alarme";
}

// Decide se UM gatilho específico pode ser enviado agora, dado o estado de sono e de
// orçamento do tick — pura, reaproveitada tanto pra agenda/conta/tarefa quanto pro
// comentário espontâneo (tratado como tipo "espontaneo" pelo chamador).
export function gatilhoPermitidoAgora({ tipo, hhmm, dormindo, orcamentoEsgotado, config }) {
  if (dormindo) return tipo === "agenda" && eventoAcordaNoSono(hhmm, config);
  if (orcamentoEsgotado) return isPrioritarioTipo(tipo);
  return true;
}

// Fila de avisos adiados (push:fila) — nunca grava de verdade aqui (isso é I/O, ver
// enqueuePushItem); só decide o NOVO array, deduplicando por tipo+texto (um gatilho
// que já está na fila não precisa ser adicionado de novo a cada tick) e descartando os
// mais antigos quando passa do limite. `adicionado` diz ao chamador se algo realmente
// mudou — se o item já estava lá (mesmo tipo+texto), não há motivo pra gravar no KV
// nem logar de novo no Diário (evita dezenas de escritas/eventos idênticos por noite
// com o cron rodando a cada 15min sobre o mesmo gatilho ainda não resolvido).
export function mergeFilaItem(fila, item, max = PUSH_QUEUE_MAX) {
  const list = Array.isArray(fila) ? fila : [];
  if (list.some((f) => f.tipo === item.tipo && f.texto === item.texto)) {
    return { list, descartados: 0, adicionado: false };
  }
  const next = [...list, item];
  if (next.length <= max) return { list: next, descartados: 0, adicionado: true };
  return { list: next.slice(next.length - max), descartados: next.length - max, adicionado: true };
}

// ---------- F2-3b: briefing matinal e pendências com retorno — lógica pura ----------
// Decide se o cron deve disparar o briefing NESTE tick: precisa estar ligado, o Jarbas
// não pode estar dormindo, ainda não pode ter sido feito hoje, e só dispara numa janela
// de 3h a partir do horário configurado (pega o primeiro tick depois do horário, mas
// nunca manda um "bom dia" de tarde se o cron ficou fora do ar a manhã inteira).
export function deveDispararBriefing({ agora, config, dormindo, jaFeitoHoje }) {
  const cfg = { ...BRIEFING_DEFAULTS, ...(config || {}) };
  if (cfg.briefingAtivo === false) return false;
  if (dormindo) return false;
  if (jaFeitoHoje) return false;
  const briefingMin = parseHHMMToMinutes(cfg.briefingHora);
  if (briefingMin == null) return false;
  const agoraDate = agora instanceof Date ? agora : new Date(agora);
  const agoraMin = minutesOfDaySaoPaulo(agoraDate);
  return agoraMin >= briefingMin && agoraMin < briefingMin + 180;
}

// Pendências (mem.items, kind="pendencia") com followUpAt hoje ou já vencido, e ainda
// ativas (nunca arquivadas/feitas/canceladas) — pura, o chamador decide quais já foram
// avisadas (isso é I/O, fica em KV pendencia:avisada:<id>).
export function selecionarPendenciasVencidas(items, hojeISO) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((it) => it && it.kind === "pendencia" && it.status === "ativo" && typeof it.followUpAt === "string" && it.followUpAt <= hojeISO);
}

// Itens de push:fila acumulados durante o sono, filtrados pro briefing: agenda com
// horário já passado (campos dia+hhmm, gravados pela F2-3a) é descartada; conta/tarefa
// só entram se o id ainda aparecer nos gatilhos vivos no momento da leitura (re-checado
// no painel, não confia no texto congelado de quando foi enfileirado).
export function filtrarFilaParaBriefing(fila, { hoje, agoraMin, idsContasVivas, idsTarefasVivas }) {
  const list = Array.isArray(fila) ? fila : [];
  return list.filter((item) => {
    if (item.tipo === "agenda") {
      if (!item.dia) return true; // item antigo sem dia (pré-correção) — mantém, melhor citar do que esconder
      if (item.dia < hoje) return false;
      if (item.dia === hoje && item.hhmm) {
        const min = parseHHMMToMinutes(item.hhmm);
        if (min != null && min < agoraMin) return false;
      }
      return true;
    }
    if (item.tipo === "conta") return !item.id || (idsContasVivas || new Set()).has(item.id);
    if (item.tipo === "tarefa") return !item.id || (idsTarefasVivas || new Set()).has(item.id);
    return true; // espontaneo e outros tipos: mantém como estavam
  });
}

// PARTE B: corta `text` em `limit` caracteres na ÚLTIMA frase completa que caiba (nunca
// no meio de uma palavra) — usado pra garantir fala <= 450 chars e body (push) <= 140,
// tanto no fallback determinístico quanto pós-processando a fala que o LLM devolveu.
export function truncarNaUltimaFrase(text, limit) {
  const s = String(text || "").trim();
  if (s.length <= limit) return s;
  const cortado = s.slice(0, limit);
  const ultimoFim = Math.max(cortado.lastIndexOf(". "), cortado.lastIndexOf("! "), cortado.lastIndexOf("? "));
  if (ultimoFim > 0) return cortado.slice(0, ultimoFim + 1).trim();
  return cortado.trim(); // nenhuma frase completa coube — corta mesmo assim, nunca passa do limite
}

// PARTE B: extrai [{hora, titulo}] do texto de agenda devolvido pelo painel (mesmo
// formato "HH:MM Título; HH:MM Título" que o cron já faz o parse em
// checkAgendaProximosGatilhos — duplicado aqui de propósito, sem tocar naquela função
// de avisos, que é escopo de outra frente).
export function parseAgendaTexto(agendaTexto) {
  if (typeof agendaTexto !== "string" || !agendaTexto) return [];
  return [...agendaTexto.matchAll(/(\d{2}:\d{2})\s+([^;]+)/g)].map(([, hora, tituloRaw]) => ({ hora, titulo: tituloRaw.trim() }));
}

// PARTE B: cartão de tarefas (total/porColuna/destaques) a partir dos itens
// ESTRUTURADOS de `?action=mudancas` — nunca da string crua "(🔥 Para Agora) ...".
// "now" (Para Agora) é tratado como prioridade alta nos destaques.
function construirCardTarefas(tarefasItens) {
  const itens = Array.isArray(tarefasItens) ? tarefasItens : [];
  const porColuna = {};
  for (const t of itens) {
    const col = (t && t.status) || "outro";
    porColuna[col] = (porColuna[col] || 0) + 1;
  }
  const ordenados = [...itens].sort((a, b) => (a?.status === "now" ? 0 : 1) - (b?.status === "now" ? 0 : 1));
  const destaques = ordenados.slice(0, 5).map((t) => String((t && t.titulo) || "").trim()).filter(Boolean);
  return { total: itens.length, porColuna, destaques };
}

// PARTE B: limita uma lista a `max` itens, acrescentando um marcador "e mais N" quando
// há mais — nunca despeja a lista inteira no cartão (nem, por extensão, na fala).
function comMaisN(lista, max, criarMarcador) {
  const arr = Array.isArray(lista) ? lista : [];
  if (arr.length <= max) return arr;
  return [...arr.slice(0, max), criarMarcador(arr.length - max)];
}

// PARTE B: a fila de avisos adiados durante o sono SEMPRE virava uma frase por item
// ("Tarefa X está parada em Para Agora." repetido pra cada uma) — vira UMA frase
// agregada por tipo (ex: "7 tarefas continuam paradas em Para Agora").
function resumirFilaDoSono(filaItens) {
  const itens = Array.isArray(filaItens) ? filaItens : [];
  if (!itens.length) return "";
  const porTipo = new Map();
  for (const it of itens) {
    const tipo = (it && it.tipo) || "outro";
    porTipo.set(tipo, (porTipo.get(tipo) || 0) + 1);
  }
  const LABEL = {
    tarefa: (n) => `${n} ${n === 1 ? "tarefa continua parada" : "tarefas continuam paradas"} em Para Agora`,
    conta: (n) => `${n} ${n === 1 ? "conta ainda está pendente" : "contas ainda estão pendentes"}`,
    agenda: (n) => `${n} ${n === 1 ? "compromisso passou" : "compromissos passaram"} sem aviso`,
  };
  const clausulas = [...porTipo.entries()].map(([tipo, n]) => (LABEL[tipo] ? LABEL[tipo](n) : `${n} ${n === 1 ? "coisa aconteceu" : "coisas aconteceram"}`));
  return `Enquanto você dormia, ${clausulas.join(" e ")}.`;
}

// Monta o briefing SEM IA — usado como fallback se o LLM falhar, e também pra montar
// sempre o `card` (nunca gerado por IA). Nunca despeja lista crua: `fala` conta e
// destaca (nunca mais que ~3 destaques), nunca uma frase por item.
export function montarBriefingDeterministico({ climaTexto, agendaTexto, tarefasItens, contasTextos, pendenciasTextos, filaItens }) {
  const agendaLista = parseAgendaTexto(agendaTexto);
  const cardTarefas = construirCardTarefas(tarefasItens);
  const contas = Array.isArray(contasTextos) ? contasTextos : [];
  const pendencias = Array.isArray(pendenciasTextos) ? pendenciasTextos : [];
  const fila = Array.isArray(filaItens) ? filaItens : [];

  const frases = [];
  if (climaTexto) frases.push(climaTexto.trim());
  if (agendaLista.length) {
    const primeiro = agendaLista[0];
    frases.push(agendaLista.length === 1
      ? `Você tem 1 compromisso hoje: ${primeiro.titulo}, às ${primeiro.hora}.`
      : `Você tem ${agendaLista.length} compromissos hoje; o primeiro é ${primeiro.titulo}, às ${primeiro.hora}.`);
  }
  if (cardTarefas.total) {
    const destaquesTxt = cardTarefas.destaques.slice(0, 3).join(", ");
    frases.push(cardTarefas.total === 1
      ? `Tem 1 tarefa pedindo atenção${destaquesTxt ? `: ${destaquesTxt}` : ""}.`
      : `São ${cardTarefas.total} tarefas pedindo atenção${destaquesTxt ? `, as principais: ${destaquesTxt}` : ""}.`);
  }
  if (contas.length) frases.push(contas.length === 1 ? contas[0] : `Você tem ${contas.length} contas pra olhar.`);
  if (pendencias.length) {
    frases.push(pendencias.length === 1
      ? `Você tinha dito que ia resolver ${pendencias[0].replace(/^"|"$/g, "")}.`
      : `Você tinha dito que ia resolver ${pendencias.length} coisas que ainda estão pendentes.`);
  }
  const filaFrase = resumirFilaDoSono(fila);
  if (filaFrase) frases.push(filaFrase);

  const fala = frases.length ? frases.join(" ") : "Bom dia! Hoje tá tranquilo, nada de urgente pra te contar agora.";
  const falaFinal = truncarNaUltimaFrase(fala, 450);

  const card = {
    clima: climaTexto || "",
    agenda: comMaisN(agendaLista, 8, (n) => ({ hora: "", titulo: `e mais ${n}` })),
    tarefas: cardTarefas,
    contas: comMaisN(contas, 8, (n) => `e mais ${n}`),
    pendencias: comMaisN(pendencias, 8, (n) => `e mais ${n}`),
    aoDormir: comMaisN(fila.map((i) => i && i.texto).filter(Boolean), 8, (n) => `e mais ${n}`),
  };

  return { title: "Bom dia", fala: falaFinal, card, body: truncarNaUltimaFrase(falaFinal, 140) };
}

// Upsert por endpoint, capado em PUSH_SUBSCRIPTIONS_MAX — se já existe (mesmo
// endpoint), atualiza no lugar (chaves podem ter rotacionado); se é novo e passaria do
// limite, descarta a mais antiga (a lista é mantida em ordem de chegada).
export function upsertPushSubscription(list, sub, max = PUSH_SUBSCRIPTIONS_MAX) {
  const current = Array.isArray(list) ? list : [];
  if (!sub?.endpoint) return current;
  const idx = current.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    const next = [...current];
    next[idx] = sub;
    return next;
  }
  const next = [...current, sub];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function removePushSubscriptionsByEndpoint(list, endpoints) {
  const current = Array.isArray(list) ? list : [];
  const toRemove = new Set(endpoints || []);
  if (!toRemove.size) return current;
  return current.filter((s) => !toRemove.has(s.endpoint));
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
async function checkAgendaProximosGatilhos(env, antecedenciaMin = SONO_DEFAULTS.antecedenciaCompromissoMin) {
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
      if (diffMin >= 0 && diffMin <= antecedenciaMin) {
        // hhmm vai junto pro chamador decidir se esse compromisso específico cai na
        // janela de sono (ver eventoAcordaNoSono) — só isso pode furar o silêncio do sono.
        triggers.push({ tipo: "agenda", id: `${hhmm}-${titulo}`, texto: `Compromisso "${titulo}" começa às ${hhmm}.`, hhmm });
      }
    }
    return triggers;
  } catch (err) {
    console.error("cron_agenda_check_failed:", String(err?.message || err));
    return [];
  }
}

// ---------- F2-3a: I/O de KV (sono, atividade, fila, assinaturas, config em cache) ----------
async function loadPushSubscriptions(env) {
  const raw = await env.COMPANION_KV.get(PUSH_SUBSCRIPTIONS_KEY);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch {}
  }
  // Migração automática da chave antiga (uma assinatura só) — nunca apaga a antiga,
  // só promove ela pra lista nova na primeira leitura depois do deploy.
  const legacyRaw = await env.COMPANION_KV.get(PUSH_SUBSCRIPTION_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw);
      if (legacy?.endpoint) {
        const migrated = [legacy];
        await env.COMPANION_KV.put(PUSH_SUBSCRIPTIONS_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch {}
  }
  return [];
}

async function savePushSubscriptions(env, list) {
  await env.COMPANION_KV.put(PUSH_SUBSCRIPTIONS_KEY, JSON.stringify(list));
}

async function readSleepState(env) {
  const raw = await env.COMPANION_KV.get(SLEEP_STATE_KEY);
  if (!raw) return { explicito: null, desde: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { explicito: null, desde: null };
  }
}

async function writeSleepState(env, explicito) {
  await env.COMPANION_KV.put(SLEEP_STATE_KEY, JSON.stringify({ explicito, desde: new Date().toISOString() }));
}

async function readActivityLast(env) {
  const raw = await env.COMPANION_KV.get(ACTIVITY_LAST_KEY);
  if (!raw) return { usuarioAt: null, painelAt: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { usuarioAt: null, painelAt: null };
  }
}

// Nunca lança — chamada de "melhor esforço" (ctx.waitUntil no modo companion, ou
// direto no tick do cron) que NUNCA pode quebrar a conversa nem o cron.
async function recordActivity(env, field) {
  try {
    const current = await readActivityLast(env);
    current[field] = new Date().toISOString();
    await env.COMPANION_KV.put(ACTIVITY_LAST_KEY, JSON.stringify(current));
  } catch (err) {
    console.error("record_activity_failed:", String(err?.message || err));
  }
}

async function readPushQueue(env) {
  const raw = await env.COMPANION_KV.get(PUSH_QUEUE_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// F2-3b: esvazia a fila depois que o briefing (que já incorporou o conteúdo dela) foi
// lido — senão os mesmos avisos "enquanto você dormia" apareceriam de novo mais tarde.
async function clearPushQueue(env) {
  await env.COMPANION_KV.put(PUSH_QUEUE_KEY, JSON.stringify([]));
}

// Enfileira um aviso adiado (sono ou orçamento esgotado) — nunca grava bruto sem
// passar pelo dedupe/corte de mergeFilaItem, e loga no Diário do Jarbas que foi
// adiado (pra nunca ficar um mistério por que algo não chegou na hora). Se o item já
// estava na fila (mesmo gatilho não resolvido, tick após tick), não grava nem loga de
// novo — com o cron a cada 15min, uma conta atrasada sem isso geraria dezenas de
// escritas e eventos idênticos por noite.
export async function enqueuePushItem(env, item, logBatch, motivo) {
  const fila = await readPushQueue(env);
  const { list, descartados, adicionado } = mergeFilaItem(fila, item);
  if (!adicionado) return;
  await env.COMPANION_KV.put(PUSH_QUEUE_KEY, JSON.stringify(list));
  pushLogEvent(logBatch, {
    tipo: "acao_espontanea", origem: "cron",
    resumo: `Aviso adiado (${motivo}): ${item.texto}`,
    detalhes: { adiado: true, motivo, tipoOriginal: item.tipo },
  });
  if (descartados > 0) {
    console.error(`push_fila_descartou ${descartados} item(ns) mais antigo(s) ao passar de ${PUSH_QUEUE_MAX}.`);
  }
}

function dailyPushCountKey(dateStr) {
  return `push:count:${dateStr}`;
}

async function getDailyPushCount(env, dateStr) {
  const raw = await env.COMPANION_KV.get(dailyPushCountKey(dateStr));
  return Number(raw) || 0;
}

async function incrementDailyPushCount(env, dateStr) {
  const next = (await getDailyPushCount(env, dateStr)) + 1;
  await env.COMPANION_KV.put(dailyPushCountKey(dateStr), String(next), { expirationTtl: 3 * 24 * 60 * 60 });
  return next;
}

// mem.config E mem.items (único escritor dos dois: o app) são lidos pelo cron no
// máximo 1x/hora — guarda os dois juntos no mesmo cache no KV (não só na memória do
// isolate, pra sobreviver entre ticks de instâncias/isolates diferentes do Worker),
// numa ÚNICA leitura de callPainelMemoryLoad (F2-3b reaproveita o cache da F2-3a em
// vez de ler de novo separado, senão dobraria a frequência de leitura do blob).
// Falha na leitura -> usa os padrões (ou o último cache válido que existir, se
// houver) pra config, e [] pra items; nunca quebra o tick.
async function loadJarbasMemCached(env) {
  let cached = null;
  try {
    const raw = await env.COMPANION_KV.get(CONFIG_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch {}

  if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CONFIG_CACHE_TTL_MS) {
    return { config: { ...SONO_DEFAULTS, ...BRIEFING_DEFAULTS, ...(cached.config || {}) }, items: cached.items || [], location: cached.location || null };
  }

  try {
    const mem = await callPainelMemoryLoad(env);
    const config = { ...SONO_DEFAULTS, ...BRIEFING_DEFAULTS, ...(mem?.config || {}) };
    const items = Array.isArray(mem?.items) ? mem.items : [];
    const location = mem?.location || null;
    await env.COMPANION_KV.put(CONFIG_CACHE_KEY, JSON.stringify({ config, items, location, cachedAt: new Date().toISOString() }));
    return { config, items, location };
  } catch (err) {
    console.error("config_cache_refresh_failed, usando padrões ou cache antigo:", String(err?.message || err));
    return { config: { ...SONO_DEFAULTS, ...BRIEFING_DEFAULTS, ...(cached?.config || {}) }, items: cached?.items || [], location: cached?.location || null };
  }
}

async function loadJarbasConfigCached(env) {
  const { config } = await loadJarbasMemCached(env);
  return config;
}

// ---------- F2-3b: I/O de KV (briefing já feito hoje, último briefing, pendências avisadas) ----------
function briefingDoneKey(dateStr) {
  return `briefing:done:${dateStr}`;
}

async function isBriefingDoneToday(env, dateStr) {
  return !!(await env.COMPANION_KV.get(briefingDoneKey(dateStr)));
}

async function markBriefingDoneToday(env, dateStr) {
  await env.COMPANION_KV.put(briefingDoneKey(dateStr), "1", { expirationTtl: 3 * 24 * 60 * 60 });
}

async function readBriefingUltimo(env) {
  const raw = await env.COMPANION_KV.get(BRIEFING_LAST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeBriefingUltimo(env, { title, fala, card, body, criadoEm }) {
  await env.COMPANION_KV.put(BRIEFING_LAST_KEY, JSON.stringify({ title, fala, card, body, criadoEm, lido: false }));
}

async function marcarBriefingLido(env) {
  const atual = await readBriefingUltimo(env);
  if (atual) {
    await env.COMPANION_KV.put(BRIEFING_LAST_KEY, JSON.stringify({ ...atual, lido: true }));
  }
  await clearPushQueue(env);
}

function pendenciaAvisadaKey(id) {
  return `pendencia:avisada:${id}`;
}

async function isPendenciaAvisada(env, id) {
  return !!(await env.COMPANION_KV.get(pendenciaAvisadaKey(id)));
}

async function marcarPendenciaAvisada(env, id) {
  await env.COMPANION_KV.put(pendenciaAvisadaKey(id), "1", { expirationTtl: PENDENCIA_AVISADA_TTL_S });
}

// Throttle de "no máximo 1x/hora" pra checagem de pendências, independente do cache de
// mem.config/items (que já tem o seu próprio TTL de 1h, mas pode ser renovado por
// qualquer leitura — isso aqui garante que a VARREDURA de pendências em si, que grava
// em KV por item avisado, não rode em todo tick mesmo se o cache acabar de ser lido).
async function devoChecarPendenciasAgora(env) {
  const raw = await env.COMPANION_KV.get(PENDENCIA_CHECK_KEY);
  if (raw && Date.now() - Number(raw) < PENDENCIA_CHECK_INTERVAL_MS) return false;
  await env.COMPANION_KV.put(PENDENCIA_CHECK_KEY, String(Date.now()));
  return true;
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
// F2-3a: `gatilhos` já vem FILTRADO pelo chamador (gatilhoPermitidoAgora) — só os que
// podem ser enviados agora (sono/orçamento já decididos antes desta função).
function cronMetricsIncLlm(cronMetrics) { if (cronMetrics) cronMetrics.llmCalls++; }

async function decideNotification(env, logBatch, gatilhos, cronMetrics) {
  if (!gatilhos.length) return null;

  const signature = gatilhos.map((g) => `${g.tipo}:${g.id}`).sort().join("|");
  const previousRaw = await env.COMPANION_KV.get(PUSH_NOTIFY_STATE_KEY);
  const previous = previousRaw ? JSON.parse(previousRaw) : { lastSignature: "", notifiedAt: 0 };
  if (previous.lastSignature === signature && Date.now() - previous.notifiedAt < PUSH_DEDUPE_MS) {
    return null;
  }

  cronMetricsIncLlm(cronMetrics);
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

// Detecta novidade (ideia/compromisso novo) SEM gastar LLM — extraído de
// decideSpontaneousComment pra que o caminho de sono/orçamento esgotado possa
// enfileirar a novidade de forma crua (f2-3b decide o que fazer com ela depois) sem
// pagar o custo de "arrumar a frase" só pra algo que nem vai ser mostrado agora.
// Sempre marca como "já visto" (como antes) — cada novidade é considerada uma vez só.
async function detectSpontaneousNovelty(env) {
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
  await env.COMPANION_KV.put(SPONTANEOUS_STATE_KEY, JSON.stringify({ lastIdeaId: newestIdeaId, lastEventId: newestEventId }));

  if (!newIdea && !newEvent) return null;
  return newIdea
    ? { kind: "ideia", content: `Ideia nova registrada: "${newIdea.text}"` }
    : { kind: "compromisso", content: `Compromisso novo criado: "${newEvent.title}" em ${newEvent.date}` };
}

async function decideSpontaneousComment(env, logBatch, cronMetrics, novelty) {
  if (!novelty) return null;
  cronMetricsIncLlm(cronMetrics);
  const raw = await callGroq(env, SPONTANEOUS_COMMENT_PROMPT, [{ role: "user", content: novelty.content }], 200);
  const clean = raw.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return null;
  }
  if (!parsed || !parsed.comment || !parsed.title || !parsed.body) return null;
  pushLogEvent(logBatch, { tipo: "acao_espontanea", origem: "cron", resumo: parsed.body, detalhes: { sobre: novelty.kind } });
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
  // F2-3a: uma mudança real no painel (nunca a primeira execução, que só estabelece a
  // base) conta como "atividade do Gustavo" pro estado de sono.
  if (!isFirstRun && changedSources.length) {
    await recordActivity(env, "painelAt");
  }
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
    const subscriptions = await loadPushSubscriptions(env);
    if (subscriptions.length) {
      const { config, items, location } = await loadJarbasMemCached(env);

      if (config.vigiaAtivo === false) {
        // Vigia desligado (mem.config.vigiaAtivo=false) é um desliga-tudo da
        // proatividade: nada de sono, orçamento, exceção ou fila neste tick.
        console.log("cron_vigia_desligado: nenhum aviso proativo verificado neste tick.");
      } else {
        try {
          const agora = new Date();
          const [sleepState, ultimaAtividade] = await Promise.all([readSleepState(env), readActivityLast(env)]);
          const dormindo = isDormindo({ agora, config, explicito: sleepState.explicito, explicitoDesde: sleepState.desde, ultimaAtividade });
          const dateStr = saoPauloNow().dateStr;

          // F2-3b: o briefing matinal tem prioridade neste tick (no máximo um push por
          // tick) — isento de orçamento, mas só dispara fora do sono e uma vez por dia.
          const jaFeitoBriefingHoje = await isBriefingDoneToday(env, dateStr);
          const deveBriefing = deveDispararBriefing({ agora, config, dormindo, jaFeitoHoje: jaFeitoBriefingHoje });

          if (deveBriefing) {
            const briefing = await gerarBriefing(env, config, { location, items });
            cronMetrics.llmCalls += briefing.llmCalls || 0;
            await writeBriefingUltimo(env, { title: briefing.title, fala: briefing.fala, card: briefing.card, body: briefing.body, criadoEm: new Date().toISOString() });
            await markBriefingDoneToday(env, dateStr);
            notification = { title: briefing.title, body: briefing.body, briefing: true };
            pushLogEvent(logBatch, {
              tipo: "acao_espontanea", origem: "cron",
              resumo: "Briefing matinal gerado e entregue.",
              detalhes: { chamadasLLM: briefing.llmCalls || 0 },
            });
          } else {
            const antecedencia = Number(config.antecedenciaCompromissoMin) || SONO_DEFAULTS.antecedenciaCompromissoMin;
            const agendaGatilhos = await checkAgendaProximosGatilhos(env, antecedencia);
            const outrosGatilhos = computeDeterministicTriggers(mudancas);
            const novelty = await detectSpontaneousNovelty(env);

            // F2-3b: pendências com retorno — no máximo 1x/hora, nunca durante o sono,
            // cada uma marcada como avisada assim que entra como candidata (nunca gera
            // o mesmo lembrete de novo, mesmo que acabe só enfileirado por orçamento).
            const pendenciaGatilhos = [];
            if (!dormindo && config.pendenciasAtivas !== false && (await devoChecarPendenciasAgora(env))) {
              const vencidas = selecionarPendenciasVencidas(items, dateStr);
              for (const p of vencidas) {
                if (await isPendenciaAvisada(env, p.id)) continue;
                pendenciaGatilhos.push({ tipo: "pendencia", id: p.id, texto: `Você tinha dito que ia: "${p.text}". Isso já foi resolvido?` });
                await marcarPendenciaAvisada(env, p.id);
              }
            }

            const maxAvisosDia = Number(config.maxAvisosDia) || SONO_DEFAULTS.maxAvisosDia;
            const orcamentoEsgotado = !dormindo && (await getDailyPushCount(env, dateStr)) >= maxAvisosDia;

            const candidatos = [
              ...agendaGatilhos,
              ...outrosGatilhos,
              ...pendenciaGatilhos,
              ...(novelty ? [{ tipo: "espontaneo", id: "novelty", texto: novelty.content }] : []),
            ];

            const permitidos = [];
            for (const g of candidatos) {
              const ok = gatilhoPermitidoAgora({ tipo: g.tipo, hhmm: g.hhmm, dormindo, orcamentoEsgotado, config });
              if (ok) {
                permitidos.push(g);
                continue;
              }
              // "agenda" leva hhmm+dia na fila pra quem consumir (F2-3b) poder descartar
              // compromissos cujo horário já passou — checkAgendaProximosGatilhos só olha
              // a agenda de "hoje", então a data é sempre a de hoje em São Paulo. "conta"
              // e "tarefa" levam o id pra poder reconfirmar se ainda estão pendentes na
              // hora de montar o briefing (filtrarFilaParaBriefing).
              const filaItem = { tipo: g.tipo, texto: g.texto, criadoEm: new Date().toISOString() };
              if (g.tipo === "agenda") {
                filaItem.hhmm = g.hhmm;
                filaItem.dia = dateStr;
              }
              if (g.tipo === "conta" || g.tipo === "tarefa") filaItem.id = g.id;
              await enqueuePushItem(env, filaItem, logBatch, dormindo ? "sono" : "orcamento");
            }

            // No máximo um push por tick: comentário espontâneo primeiro (se sobreviveu
            // ao filtro acima), senão o aviso determinístico (agenda+conta+tarefa+pendência
            // que sobraram). Só conta no orçamento o que for enviado de verdade E não for
            // 100% prioritário (agenda pura nunca consome o orçamento, mesmo enviada).
            const espontaneoPermitido = permitidos.find((g) => g.tipo === "espontaneo");
            const deterministicosPermitidos = permitidos.filter((g) => g.tipo !== "espontaneo");
            let consomeOrcamento = false;

            if (espontaneoPermitido) {
              notification = await decideSpontaneousComment(env, logBatch, cronMetrics, novelty);
              if (notification) consomeOrcamento = true;
            }
            if (!notification && deterministicosPermitidos.length) {
              notification = await decideNotification(env, logBatch, deterministicosPermitidos, cronMetrics);
              if (notification) consomeOrcamento = deterministicosPermitidos.some((g) => !isPrioritarioTipo(g.tipo));
            }
            if (notification && !dormindo && consomeOrcamento) {
              await incrementDailyPushCount(env, dateStr);
            }
          }
        } catch (err) {
          console.error("cron_decide_failed:", String(err?.message || err));
        }
      }

      if (notification) {
        try {
          const { entregues, endpointsParaRemover } = await sendWebPushToAll(env, subscriptions, notification);
          if (endpointsParaRemover.length) {
            await savePushSubscriptions(env, removePushSubscriptionsByEndpoint(subscriptions, endpointsParaRemover));
          }
          pushLogEvent(logBatch, {
            tipo: "aviso_enviado", origem: "cron",
            resumo: `Push entregue a ${entregues} de ${subscriptions.length} aparelho(s).`,
            detalhes: { aparelhosAtingidos: entregues, aparelhosTotal: subscriptions.length, removidos: endpointsParaRemover.length },
          });
        } catch (err) {
          console.error("push_send_failed", err);
          pushLogEvent(logBatch, { tipo: "erro", origem: "cron", resumo: `Falha ao enviar push: ${String(err.message || err).slice(0, 200)}` });
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

    // ---- F2-2: consolidação de memória — SÓ CALCULA e devolve, nunca grava nada.
    // Protegido pela mesma SYNC_KEY de memory_load/memory_save porque é o APP (nunca o
    // servidor) quem decide se/quando aplicar e salvar o resultado em jarbas_memory_v1. ----
    if (mode === "consolidate") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
      if (!env.PAINEL_API_KEY) {
        return json({ error: "painel_not_configured" }, 500);
      }
      try {
        const result = await runConsolidation(env, body.items || [], body.messages || [], body.hojeISO || todayLabelPtBR());
        return json(result);
      } catch (err) {
        console.error("consolidate_failed:", String(err?.message || err));
        return json(CONSOLIDATION_EMPTY_RESULT);
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
      // F2-3a: vários aparelhos — adiciona ou atualiza (mesmo endpoint) sem duplicar,
      // nunca mais sobrescreve a lista inteira com uma assinatura só.
      const current = await loadPushSubscriptions(env);
      await savePushSubscriptions(env, upsertPushSubscription(current, body.subscription));
      return json({ ok: true });
    }
    // F2-3a: o app consulta ao abrir (e antes de falar um aviso recebido via push) se o
    // Jarbas está "dormindo" — protegido pela mesma SYNC_KEY, nunca exposto sem senha.
    if (mode === "estado_get") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.COMPANION_KV) return json({ dormindo: false, explicito: null });
      try {
        const config = env.PAINEL_API_KEY ? await loadJarbasConfigCached(env) : { ...SONO_DEFAULTS, ...BRIEFING_DEFAULTS };
        const [sleepState, ultimaAtividade] = await Promise.all([readSleepState(env), readActivityLast(env)]);
        const dormindo = isDormindo({ agora: new Date(), config, explicito: sleepState.explicito, explicitoDesde: sleepState.desde, ultimaAtividade });
        return json({ dormindo, explicito: sleepState.explicito || null });
      } catch (err) {
        return json({ dormindo: false, explicito: null, error: String(err?.message || err) });
      }
    }
    // F2-3a: os botões "Dormir agora"/"Acordar" nas Configurações chamam isso direto
    // (sem passar pelo modelo) — a mesma frase dita por voz usa a ferramenta
    // definir_sono no modo "companion", que grava exatamente aqui (setSleepState).
    if (mode === "definir_sono") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.COMPANION_KV) return json({ error: "kv_not_configured" }, 500);
      const estado = body.estado === "dormir" ? "dormindo" : body.estado === "acordar" ? "acordado" : null;
      if (!estado) return json({ error: "estado_invalido" }, 400);
      await writeSleepState(env, estado);
      return json({ ok: true, explicito: estado });
    }

    // ---- F2-3b: briefing matinal — o app consulta ao abrir (ou ao receber o push
    // enquanto aberto) se há um briefing ainda não lido, e marca como lido depois de
    // falar (o que também esvazia push:fila, já incorporada no texto do briefing). ----
    if (mode === "briefing_get") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.COMPANION_KV) return json({ briefing: null });
      try {
        const ultimo = await readBriefingUltimo(env);
        return json({ briefing: ultimo && !ultimo.lido ? ultimo : null });
      } catch (err) {
        return json({ briefing: null, error: String(err?.message || err) });
      }
    }
    if (mode === "briefing_lido") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.COMPANION_KV) return json({ error: "kv_not_configured" }, 500);
      await marcarBriefingLido(env);
      return json({ ok: true });
    }
    // Botão "Ouvir o resumo de hoje agora" nas Configurações — gera e fala na hora,
    // SEM marcar briefing:done (o cron ainda dispara o briefing automático de manhã
    // normalmente, essa chamada manual não substitui nem adianta esse controle).
    if (mode === "briefing_now") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.PAINEL_API_KEY) return json({ error: "painel_not_configured" }, 500);
      try {
        const config = await loadJarbasConfigCached(env);
        const briefing = await gerarBriefing(env, config, body.companionState || {});
        const logBatch = [];
        pushLogEvent(logBatch, {
          tipo: "acao_pedida", origem: "jarbas",
          resumo: "Resumo do dia gerado a pedido (botão \"Ouvir agora\").",
          detalhes: { chamadasLLM: briefing.llmCalls || 0 },
        });
        await flushLogBatch(env, ctx, logBatch);
        return json({ title: briefing.title, fala: briefing.fala, card: briefing.card, body: briefing.body });
      } catch (err) {
        return json({ error: "briefing_failed", detail: String(err.message || err) }, 502);
      }
    }

    // ---- PARTE E: telas ao redor do rosto (agenda/tarefas/contas reais, sem IA) — o
    // app consulta ao abrir, a cada 5min com a aba visível, e depois de respostas que
    // mexeram em tarefas/agenda. Mesma autenticação (SYNC_KEY) das outras ações do app. ----
    if (mode === "telas") {
      if (!env.SYNC_KEY || body.key !== env.SYNC_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.PAINEL_API_KEY) return json({ error: "painel_not_configured" }, 500);
      try {
        const dados = await montarTelasCached(env, body.companionState || {});
        return json(dados);
      } catch (err) {
        return json({ error: "telas_failed", detail: String(err.message || err) }, 502);
      }
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

        // F2-3a: toda mensagem real do Gustavo é "atividade dele" pro estado de sono —
        // melhor esforço (ctx.waitUntil), uma falha aqui nunca pode atrapalhar a conversa.
        if (env.COMPANION_KV) ctx.waitUntil(recordActivity(env, "usuarioAt"));

        // F2-2: seleciona só os itens de memória relevantes pra ESSA mensagem (+ as 2
        // anteriores), em vez de mandar a timeline inteira — menos tokens, mais focado.
        const recentTexts = timestamped.slice(-3).map((m) => m.content);
        const memItems = Array.isArray(companionState.items) ? companionState.items : [];
        const selectedItems = selectRelevantItems(memItems, recentTexts, Date.now(), 10);
        const selectedItemsText = itemsToPromptText(selectedItems);
        if (memItems.length) {
          pushLogEvent(logBatch, { tipo: "leitura", origem: "jarbas", resumo: `Selecionou ${selectedItems.length} de ${memItems.length} item(ns) de memória relevantes pra essa conversa.` });
        }

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
        let saveMemoryItem = null;
        let savePendenciaUpdate = null;
        let materialize = null;
        let cards = null;
        let lousa = null;
        let callMetrics = null;
        // Uma única tentativa aqui: o roteador de LLMs (groqRequest) já tenta os
        // provedores configurados em cadeia com fallback internamente, e
        // callGroqWithSearch já retenta a chamada que gera a FALA sem re-executar
        // ferramentas. Repetir a chamada inteira aqui de novo é que causava o bug de
        // ações de escrita (ex: anotar no diário) rodando duas vezes quando só a
        // segunda chamada ao LLM falhava.
        try {
          const raw = await callGroqWithSearch(env, companionPrompt(companionState, timeGapLine, selectedItemsText), timestamped, 450, companionState, logBatch);
          saveMemory = raw.saveMemory;
          saveLearned = raw.saveLearned;
          saveMemoryItem = raw.saveMemoryItem;
          savePendenciaUpdate = raw.savePendenciaUpdate;
          materialize = raw.materialize;
          cards = raw.cards;
          lousa = raw.lousa;
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
        if (!COMPANION_EMOTIONS.includes(parsed.emotion)) {
          parsed.emotion = "neutro";
        }
        if (typeof parsed.reply === "string") parsed.reply = stripTimestampPrefix(parsed.reply);
        if (saveMemory) parsed.save_memory = saveMemory;
        if (saveLearned) parsed.save_learned = saveLearned;
        if (saveMemoryItem) parsed.save_memory_item = saveMemoryItem;
        if (savePendenciaUpdate) parsed.pendencia_update = savePendenciaUpdate;
        if (materialize) parsed.materialize = materialize;
        if (cards && cards.length) parsed.cards = cards;
        if (lousa) parsed.lousa = lousa;
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
