// VOZ-4 PARTE B.2/B.3 (cliente): parsing do SSE do modo companion/stream, fila de fala
// que recebe o texto incrementalmente (sentença a sentença, juntando fragmentos curtos
// < 20 caracteres igual a splitIntoSpeechChunks), e askRaizStreaming (decide quando NÃO
// precisa reempurrar o texto final pra fila porque ele já foi falado via "delta", e cai
// pro fallback sem streaming só quando NADA ainda tiver sido falado) — tudo extraído
// DIRETO do companion/index.html (não uma reimplementação), mesmo padrão de
// companion/_voz-mobile-unlock.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function sliceBetween(inicioMarcador, fimMarcador) {
  const inicio = html.indexOf(inicioMarcador);
  const fim = html.indexOf(fimMarcador, inicio);
  assert.ok(inicio !== -1, `achou o marcador de início "${inicioMarcador}"`);
  assert.ok(fim !== -1 && fim > inicio, `achou o marcador de fim "${fimMarcador}"`);
  return html.slice(inicio, fim);
}

// Bloco 1: speechState .. readSseEvents (toda a camada de TTS/streaming de fala).
const trecho1 = sliceBetween(
  "const EDGE_VOICE_ON_KEY = 'raiz_edge_voice_on';",
  "// Resolve `true` se a fala terminou normalmente"
);
// Bloco 2: buildCompanionState .. askRaizStreaming (orquestração do modo companion),
// sem incluir askRaiz em si (que depende de bem mais estado do app — fora de escopo
// deste teste, que foca no que o VOZ-4 mudou).
const trecho2 = sliceBetween(
  "function buildCompanionState(){",
  "async function askRaiz(userText, isRetry){"
);

function fakeTtsEl() {
  return {
    _src: "",
    get src() { return this._src; },
    set src(v) { this._src = v; },
    onplay: null, onended: null, onerror: null,
    _playImpl: () => Promise.resolve(),
    play() { return this._playImpl(); },
    pause() {},
    removeAttribute() { this._src = ""; },
    load() {},
  };
}

function makeSandbox({ fetchImpl } = {}) {
  const elTts = fakeTtsEl();
  const elHint = { textContent: "" };
  const store = new Map();
  const fakeLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  fakeLocalStorage.setItem("raiz_worker_url", "https://worker.test");
  const listeners = {};
  const fakeDoc = {
    getElementById: (id) => (id === "ttsEl" ? elTts : null),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
  };
  const calls = { setEmotion: [], setCaption: [], applyPendenciaUpdate: [], registerCreation: [], addMemoryItem: [] };

  const sandbox = {
    CLASSIC_FACE: true, // evita precisar simular o wiring completo do analyser nesses testes
    state: { targetTalk: 0 },
    analyserNode: null,
    ensureAudioCtx: () => null,
    speakBrowser: (text) => Promise.resolve(),
    hint: elHint,
    document: fakeDoc,
    navigator: { userAgent: "", maxTouchPoints: 0 },
    window: { speechSynthesis: { speak() {} } },
    speechSynthesis: { speak() {} },
    localStorage: fakeLocalStorage,
    fetch: fetchImpl || (() => Promise.reject(new Error("fetch não mockado"))),
    AbortController,
    TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    waitForNextGesture: () => Promise.resolve(),
    onFirstUserGesture: () => {},
    // VOZ-4: hands-free/interrupt monitor vivem numa seção bem mais adiante do arquivo
    // (fora do que este teste precisa) -- aqui são só espiões de chamada.
    pauseHandsFreeForSpeech: () => { sandbox.__pauseCalls++; },
    startInterruptMonitor: (myGen) => { sandbox.__startMonitorCalls.push(myGen); },
    stopInterruptMonitor: () => { sandbox.__stopMonitorCalls++; },
    startContinuityWindow: () => { sandbox.__continuityCalls++; },
    resumeHandsFreeListening: () => { sandbox.__resumeCalls++; },
    __pauseCalls: 0, __stopMonitorCalls: 0, __continuityCalls: 0, __resumeCalls: 0,
    __startMonitorCalls: [],
    // askRaizStreaming/applyCompanionResult
    history: [],
    mem: { memory: "", items: [], learned: [], shortcuts: [], timeline: [] },
    stripTimestampPrefix: (t) => t,
    formatNowPtBR: () => "segunda, 10h00",
    todayISO: () => "2026-11-03",
    buildAparenciaForWorker: () => null,
    podeMaterializarEspontaneo: () => true,
    setEmotion: (e) => calls.setEmotion.push(e),
    setCaption: (who, text) => calls.setCaption.push(text),
    triggerJarbasMaterialize: () => {},
    triggerLousa: () => {},
    renderCards: () => {},
    fetchTelas: () => {},
    saveMemoryState: () => {},
    pushMemoryToServer: () => {},
    applyPendenciaUpdate: (u) => calls.applyPendenciaUpdate.push(u),
    registerCreation: (c) => calls.registerCreation.push(c),
    addMemoryItem: (item, origem) => calls.addMemoryItem.push({ item, origem }),
    callWorkerSyncMode: (mode, extra) => { calls.callWorkerSyncMode = calls.callWorkerSyncMode || []; calls.callWorkerSyncMode.push({ mode, extra }); return Promise.resolve({ ok: true }); },
    vozConfig: () => ({ provedor: null, vozId: null, velocidade: 1.08 }),
  };
  vm.createContext(sandbox);
  vm.runInContext(trecho1 + "\n" + trecho2 + `
    this.__getSpeechState = () => speechState;
    this.__cancelSpeech = cancelSpeech;
    this.__splitIntoSpeechChunks = splitIntoSpeechChunks;
    this.__createStreamingSpeechQueue = createStreamingSpeechQueue;
    this.__beginStreamingSpeech = beginStreamingSpeech;
    this.__readSseEvents = readSseEvents;
    this.__askRaizStreaming = askRaizStreaming;
    this.__askRaizNonStreaming = askRaizNonStreaming;
    this.__buildCompanionState = buildCompanionState;
    this.__applyCompanionResult = applyCompanionResult;
    this.__loadLatencyTraces = loadLatencyTraces;
    this.__recordLatencyTrace = recordLatencyTrace;
    this.__computeLatencyMedians = computeLatencyMedians;
    this.__formatLatencyDiagnosticText = formatLatencyDiagnosticText;
  `, sandbox);
  sandbox.__elTts = elTts;
  sandbox.__elHint = elHint;
  sandbox.__calls = calls;
  return sandbox;
}

// ---------- readSseEvents: parsing de "event: X\ndata: Y\n\n", inclusive partido entre reads ----------
{
  const s = makeSandbox();
  function fakeResp(chunks) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
      body: {
        getReader() {
          return {
            read() {
              if (i < chunks.length) return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    };
  }

  const resp1 = fakeResp([
    'event: emotion\ndata: {"emotion":"feliz"}\n\n',
    'event: delta\ndata: {"text":"Oi, '
  , 'tudo bem?"}\n\n',
    'event: done\ndata: {"emotion":"feliz","reply":"Oi, tudo bem?"}\n\n',
  ]);
  const got = [];
  for await (const ev of s.__readSseEvents(resp1)) got.push(ev);
  assert.deepEqual(got.map((e) => e.event), ["emotion", "delta", "done"], "eventos na ordem certa, mesmo com um \"data:\" partido em dois reads() do stream");
  // objetos vêm do sandbox (outro "realm") -- compara pelo JSON, não por identidade de protótipo
  assert.equal(JSON.stringify(got[0].data), JSON.stringify({ emotion: "feliz" }));
  assert.equal(JSON.stringify(got[1].data), JSON.stringify({ text: "Oi, tudo bem?" }));
  assert.equal(JSON.stringify(got[2].data), JSON.stringify({ emotion: "feliz", reply: "Oi, tudo bem?" }));
  console.log("readSseEvents: OK");
}

// ---------- createStreamingSpeechQueue: junta frases completas < 20 caracteres com a próxima ----------
{
  const played = [];
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) });
    },
  });
  s.__elTts._playImpl = function () {
    const text = Buffer.from(this._src.replace("data:audio/mpeg;base64,", ""), "base64").toString("utf8");
    played.push(text);
    queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); });
    return Promise.resolve();
  };
  const st = s.__getSpeechState();
  const myGen = st.generation;
  const q = s.__createStreamingSpeechQueue(myGen);
  // "Oi." sozinho tem 3 caracteres (< 20) -- some junto com a frase seguinte.
  q.pushText("Oi. Tudo bem com você hoje? ");
  q.pushText("Vou contar uma novidade.");
  await q.finish();
  assert.deepEqual(played, ["Oi. Tudo bem com você hoje?", "Vou contar uma novidade."], "frase curta colada na seguinte, frases tocadas em ordem");
  console.log("createStreamingSpeechQueue (junta frase curta + ordem de reprodução): OK");
}

// ---------- createStreamingSpeechQueue: toca em ordem mesmo se o TTS da frase seguinte volta antes ----------
{
  const played = [];
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      // a primeira frase ("frase A") demora mais que a segunda ("frase B") de propósito.
      const delay = body.text.includes("A") ? 30 : 5;
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) }), delay));
    },
  });
  s.__elTts._playImpl = function () {
    const text = Buffer.from(this._src.replace("data:audio/mpeg;base64,", ""), "base64").toString("utf8");
    played.push(text);
    queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); });
    return Promise.resolve();
  };
  const st = s.__getSpeechState();
  const myGen = st.generation;
  const q = s.__createStreamingSpeechQueue(myGen);
  q.pushText("Frase A é mais longa que vinte caracteres. ");
  q.pushText("Frase B também passa de vinte caracteres.");
  await q.finish();
  assert.deepEqual(played, ["Frase A é mais longa que vinte caracteres.", "Frase B também passa de vinte caracteres."], "ordem de reprodução segue a ordem das frases, não a ordem em que o TTS respondeu");
  console.log("createStreamingSpeechQueue (ordem respeitada mesmo com TTS fora de ordem): OK");
}

// ---------- beginStreamingSpeech: mesmo contrato do speak() (gera generation, pausa mãos-livres, liga/desliga monitor) ----------
{
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) });
    },
  });
  s.__elTts._playImpl = function () {
    queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); });
    return Promise.resolve();
  };
  const genAntes = s.__getSpeechState().generation;
  const streaming = s.__beginStreamingSpeech();
  assert.equal(streaming.myGen, genAntes + 1, "novo generation, igual a speak()");
  assert.equal(s.__pauseCalls, 1, "pausou mãos-livres assim que a fala começou");
  assert.deepEqual(s.__startMonitorCalls, [streaming.myGen], "ligou o monitor de interrupção com o generation certo");
  streaming.pushText("Teste de fala em streaming, frase razoavelmente longa.");
  const finishedNormally = await streaming.finish();
  assert.equal(finishedNormally, true);
  assert.equal(s.__stopMonitorCalls, 1, "desligou o monitor no fim");
  assert.equal(s.__resumeCalls, 1, "retomou mãos-livres no fim");
  console.log("beginStreamingSpeech (mesmo contrato de speak()): OK");
}

function sseFakeResponse(events, { ok = true, contentType = "text/event-stream" } = {}) {
  const encoder = new TextEncoder();
  const raw = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  let sent = false;
  return {
    ok,
    headers: { get: () => contentType },
    body: ok ? {
      getReader() {
        return {
          read() {
            if (!sent) { sent = true; return Promise.resolve({ done: false, value: encoder.encode(raw) }); }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    } : null,
  };
}

// ---------- askRaizStreaming: caminho feliz (emotion + delta + done), fala já tocada = não refala ----------
{
  const ttsFetchTexts = [];
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.mode === "tts") {
        ttsFetchTexts.push(body.text);
        return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) });
      }
      // mode:'companion', stream:true
      return Promise.resolve(sseFakeResponse([
        { event: "emotion", data: { emotion: "feliz" } },
        { event: "delta", data: { text: "Tudo certo por aqui! " } },
        { event: "delta", data: { text: "Já resolvi o que você pediu." } },
        { event: "done", data: { emotion: "feliz", reply: "Tudo certo por aqui! Já resolvi o que você pediu." } },
      ]));
    },
  });
  s.__elTts._playImpl = function () {
    queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); });
    return Promise.resolve();
  };
  const result = await s.__askRaizStreaming("https://worker.test", {}, () => {});
  assert.equal(result.finishedNormally, true);
  assert.equal(result.parsed.reply, "Tudo certo por aqui! Já resolvi o que você pediu.");
  assert.deepEqual(s.__calls.setEmotion, ["feliz"], "emoção setada assim que o evento \"emotion\" chegou (antes do \"done\")");
  // as duas frases (cada uma >= 20 caracteres, então não são coladas) são pedidas ao TTS
  // só UMA vez cada, via "delta" -- depois do "done" não pede nada de novo (soma exata).
  assert.deepEqual(ttsFetchTexts, ["Tudo certo por aqui!", "Já resolvi o que você pediu."], "o texto já falado via delta NÃO é pedido de novo ao TTS depois do \"done\"");
  console.log("askRaizStreaming (feliz: delta já cobre tudo, não refala): OK");
}

// ---------- askRaizStreaming: atalho (só "done", sem nenhum "delta") -- precisa falar o reply inteiro ----------
{
  const ttsFetchTexts = [];
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.mode === "tts") { ttsFetchTexts.push(body.text); return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) }); }
      return Promise.resolve(sseFakeResponse([{ event: "done", data: { emotion: "neutro", reply: "Pronto, já anotei." } }]));
    },
  });
  s.__elTts._playImpl = function () { queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); }); return Promise.resolve(); };
  const result = await s.__askRaizStreaming("https://worker.test", {}, () => {});
  assert.equal(result.parsed.reply, "Pronto, já anotei.");
  assert.deepEqual(ttsFetchTexts, ["Pronto, já anotei."], "nada tinha sido falado por delta -- o reply inteiro do atalho precisa ser pedido ao TTS");
  console.log("askRaizStreaming (atalho sem delta nenhum, fala o reply inteiro): OK");
}

// ---------- askRaizStreaming: frase-ponte só é falada quando NENHUM delta chegou ainda ----------
{
  const ttsFetchTexts = [];
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.mode === "tts") { ttsFetchTexts.push(body.text); return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) }); }
      return Promise.resolve(sseFakeResponse([
        { event: "bridge", data: { text: "Um segundo, vou ver..." } },
        { event: "done", data: { emotion: "neutro", reply: "Sua agenda de hoje tem duas reuniões." } },
      ]));
    },
  });
  s.__elTts._playImpl = function () { queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); }); return Promise.resolve(); };
  const result = await s.__askRaizStreaming("https://worker.test", {}, () => {});
  assert.equal(result.parsed.reply, "Sua agenda de hoje tem duas reuniões.");
  assert.deepEqual(ttsFetchTexts, ["Um segundo, vou ver...", "Sua agenda de hoje tem duas reuniões."], "fala a ponte, depois a resposta final (que ainda não tinha sido dita)");
  console.log("askRaizStreaming (frase-ponte seguida da resposta final): OK");
}

// ---------- askRaizStreaming: falha ANTES de qualquer conteúdo falável -> lança (seguro cair pro fallback) ----------
{
  const s = makeSandbox({
    fetchImpl: () => Promise.resolve(sseFakeResponse([], { ok: false })),
  });
  await assert.rejects(() => s.__askRaizStreaming("https://worker.test", {}, () => {}), /worker_stream_error/, "resp.ok=false sem nada falado ainda -> lança, nunca engole o erro");
  console.log("askRaizStreaming (falha antes de qualquer fala -> lança pro fallback): OK");
}

// ---------- askRaizStreaming: content-type inesperado (ex: proxy devolveu JSON de erro) -> lança ----------
{
  const s = makeSandbox({
    fetchImpl: () => Promise.resolve({ ok: true, headers: { get: () => "application/json" }, body: {} }),
  });
  await assert.rejects(() => s.__askRaizStreaming("https://worker.test", {}, () => {}), /unexpected_content_type/);
  console.log("askRaizStreaming (content-type não é text/event-stream -> lança): OK");
}

// ---------- askRaizStreaming: conexão cai DEPOIS de algum delta -- não lança, fecha com o que já foi dito ----------
{
  const ttsFetchTexts = [];
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.mode === "tts") { ttsFetchTexts.push(body.text); return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) }); }
      // o stream entrega um "delta" e então o corpo termina sem nunca mandar "done".
      const encoder = new TextEncoder();
      let sent = false;
      return Promise.resolve({
        ok: true,
        headers: { get: () => "text/event-stream" },
        body: { getReader() { return { read() { if (!sent) { sent = true; return Promise.resolve({ done: false, value: encoder.encode('event: delta\ndata: {"text":"Isso aqui foi dito."}\n\n') }); } return Promise.resolve({ done: true, value: undefined }); } }; } },
      });
    },
  });
  s.__elTts._playImpl = function () { queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); }); return Promise.resolve(); };
  const result = await s.__askRaizStreaming("https://worker.test", {}, () => {});
  assert.equal(result.parsed.reply, "Isso aqui foi dito.", "sem \"done\", fecha com o texto que já tinha sido streamado (nunca inventa outra coisa)");
  assert.deepEqual(ttsFetchTexts, ["Isso aqui foi dito."], "não tenta falar de novo o que já tinha sido falado via delta");
  console.log("askRaizStreaming (conexão cai depois de falar algo -- não lança, fecha com o que tem): OK");
}

// ---------- VOZ-4 PARTE A: recordLatencyTrace / computeLatencyMedians / diagnóstico ----------
{
  const s = makeSandbox();
  assert.equal(s.__formatLatencyDiagnosticText(), "(ainda sem dados — converse por voz pra começar a medir)", "sem amostras ainda -> mensagem clara, nunca quebra");

  // uma fala completa, com TODAS as etapas presentes
  s.__recordLatencyTrace({
    tUserEnd: 1000, tSent: 1010, tWorkerReceived: 1090, tFirstToken: 1300, tLlmComplete: 1900,
    tFirstSpeakable: 1350, tFirstTtsStart: 1360, tFirstTtsReady: 1960, tPlaybackStart: 1980,
  }, "https://worker.test");
  const list = s.__loadLatencyTraces();
  assert.equal(list.length, 1);
  // objeto vem do sandbox (outro "realm") -- compara pelo JSON, não por identidade de protótipo
  assert.equal(JSON.stringify(list[0]), JSON.stringify({ redeIdaMs: 80, primeiroTokenMs: 210, llmCompletoMs: 810, primeiraFraseProntaMs: 260, ttsMs: 600, totalMs: 980 }));

  const m = s.__computeLatencyMedians();
  assert.equal(m.amostras, 1);
  assert.equal(m.totalMs, 980, "mediana de 1 amostra é ela mesma");
  assert.match(s.__formatLatencyDiagnosticText(), /980ms/);
  assert.match(s.__formatLatencyDiagnosticText(), /INÍCIO DA FALA/);
  console.log("recordLatencyTrace/computeLatencyMedians (1 amostra completa): OK");
}

{
  // uma etapa faltando (ex: a conexão caiu antes do "timing") nunca derruba as outras --
  // só essa etapa fica null, e a mediana ignora nulls sem quebrar.
  const s = makeSandbox();
  s.__recordLatencyTrace({ tUserEnd: 1000, tSent: 1010, tPlaybackStart: 1500 }, "https://worker.test");
  const stage = s.__loadLatencyTraces()[0];
  assert.equal(stage.redeIdaMs, null, "sem tWorkerReceived -> essa etapa fica null");
  assert.equal(stage.totalMs, 500, "mas a etapa que TINHA os dois lados (a e g) ainda é calculada");
  console.log("recordLatencyTrace (etapa faltando nunca derruba as outras): OK");
}

{
  // janela de 20 amostras (mais antiga cai fora) + relatório agregado a cada 20
  const s = makeSandbox();
  for (let i = 0; i < 25; i++) {
    s.__recordLatencyTrace({ tUserEnd: 0, tSent: 0, tPlaybackStart: 1000 + i }, "https://worker.test");
  }
  assert.equal(s.__loadLatencyTraces().length, 20, "nunca guarda mais que as últimas 20 amostras");
  assert.equal(s.__calls.callWorkerSyncMode.length, 1, "manda o resumo pro Diário exatamente 1x a cada 20 amostras (não 1x por fala)");
  assert.equal(s.__calls.callWorkerSyncMode[0].mode, "latencia_relatar");
  assert.equal(s.__calls.callWorkerSyncMode[0].extra.amostras, 20);
  console.log("recordLatencyTrace (janela de 20 + relatório agregado 1x a cada 20): OK");
}

// ---------- askRaizStreaming: preenche o trace a partir do evento "timing" ----------
{
  const s = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.mode === "tts") return Promise.resolve({ ok: true, json: async () => ({ audio_b64: Buffer.from(body.text, "utf8").toString("base64"), provider: "azure" }) });
      return Promise.resolve(sseFakeResponse([
        { event: "timing", data: { tReceived: 2000, tFirstToken: 2100, tLlmComplete: 2400, tFirstSpeakable: 2150 } },
        { event: "delta", data: { text: "Prontinho, já falei isso tudo." } },
        { event: "done", data: { emotion: "neutro", reply: "Prontinho, já falei isso tudo." } },
      ]));
    },
  });
  s.__elTts._playImpl = function () { queueMicrotask(() => { this.onplay && this.onplay(); this.onended && this.onended(); }); return Promise.resolve(); };
  const trace = { tUserEnd: 1950 };
  await s.__askRaizStreaming("https://worker.test", {}, () => {}, trace);
  assert.equal(trace.tWorkerReceived, 2000);
  assert.equal(trace.tFirstToken, 2100);
  assert.equal(trace.tLlmComplete, 2400);
  assert.equal(trace.tFirstSpeakable, 2150);
  assert.equal(typeof trace.tSent, "number", "tSent foi marcado antes do fetch");
  assert.equal(typeof trace.tFirstTtsStart, "number", "hook de início do TTS foi chamado");
  assert.equal(typeof trace.tFirstTtsReady, "number", "hook de TTS pronto foi chamado");
  assert.equal(typeof trace.tPlaybackStart, "number", "hook de início da reprodução foi chamado");
  console.log("askRaizStreaming (preenche o trace a partir do evento timing + hooks de TTS/reprodução): OK");
}

console.log("_voz4-streaming-cliente.test.mjs: todos os testes passaram");
