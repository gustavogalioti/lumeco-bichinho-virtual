// Voz unificada no mobile: destravo de áudio (iOS/Safari), elemento único reaproveitado,
// bloqueio de autoplay não vira voz do navegador em silêncio, retry de rede/timeout, e
// motivo do diagnóstico — tudo extraído DIRETO do companion/index.html (não uma
// reimplementação) num sandbox node:vm, mesmo padrão de companion/_voz-eco-apelidos.test.mjs.
// Doubles pro Audio (ttsEl), fetch, AudioContext, speechSynthesis e document — nunca
// reimplementa a lógica real, só troca o que seria um navegador/rede de verdade.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const inicioMarcador = "const EDGE_VOICE_ON_KEY = 'raiz_edge_voice_on';";
const fimMarcador = "// PARTE C: a voz nunca lê emoji";
const inicio = html.indexOf(inicioMarcador);
const fim = html.indexOf(fimMarcador, inicio);
assert.ok(inicio !== -1 && fim !== -1, "achou o bloco de voz unificada no companion/index.html");
const trecho = html.slice(inicio, fim);

function fakeTtsEl(){
  return {
    _src: "",
    get src(){ return this._src; },
    set src(v){ this._src = v; },
    onplay: null, onended: null, onerror: null,
    _playImpl: () => Promise.resolve(),
    play(){ return this._playImpl(); },
    pause(){},
    removeAttribute(){ this._src = ""; },
    load(){},
  };
}

function makeSandbox({ fetchImpl, ctxState } = {}) {
  const listeners = {};
  const fakeDoc = {
    getElementById: (id) => (id === "ttsEl" ? elTts : null),
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn){ if(listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
  };
  const elTts = fakeTtsEl();
  const elHint = { textContent: "" };
  const store = new Map();
  const fakeLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  fakeLocalStorage.setItem("raiz_worker_url", "https://worker.test");
  const fakeCtx = {
    state: (ctxState && ctxState.state) || "running",
    resume(){ return Promise.resolve(); },
    createMediaElementSource(){ return { connect(){} }; },
    createAnalyser(){ return { connect(){}, fftSize: 0, smoothingTimeConstant: 0 }; },
  };
  const speechSynth = { speak(){} };
  const sandbox = {
    CLASSIC_FACE: true, // evita precisar simular o wiring completo do analyser nesses testes
    state: { targetTalk: 0 },
    analyserNode: null,
    ensureAudioCtx: () => fakeCtx,
    speakBrowser: (text) => { sandbox.__speakBrowserCalls.push(text); return Promise.resolve(); },
    __speakBrowserCalls: [],
    hint: elHint,
    document: fakeDoc,
    navigator: { userAgent: "", maxTouchPoints: 0 },
    window: { speechSynthesis: speechSynth },
    speechSynthesis: speechSynth,
    SpeechSynthesisUtterance: function (text) { this.text = text; this.volume = 1; },
    localStorage: fakeLocalStorage,
    fetch: fetchImpl || (() => Promise.reject(new Error("fetch não mockado"))),
    AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(trecho + `
    this.__isIOS = isIOS;
    this.__classifyTtsError = classifyTtsError;
    this.__TTS_TIMEOUT_MS = TTS_TIMEOUT_MS;
    this.__fetchTtsAudioWithRetry = fetchTtsAudioWithRetry;
    this.__playAudioForGen = playAudioForGen;
    this.__speakChunksStreaming = speakChunksStreaming;
    this.__updateVoiceProviderLabel = updateVoiceProviderLabel;
    this.__recordVoiceFallbackReason = recordVoiceFallbackReason;
    this.__getSpeechState = () => speechState;
  `, sandbox);
  sandbox.__elTts = elTts;
  sandbox.__elHint = elHint;
  sandbox.__listeners = listeners;
  sandbox.__fireGesture = (type) => {
    (listeners[type || "click"] || []).slice().forEach((fn) => fn());
  };
  return sandbox;
}

// ---------- isIOS ----------
{
  const s = makeSandbox();
  s.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  assert.equal(s.__isIOS(), true, "iPhone -> iOS");
  s.navigator.userAgent = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)";
  assert.equal(s.__isIOS(), true, "iPad -> iOS");
  s.navigator.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)";
  s.navigator.maxTouchPoints = 5;
  assert.equal(s.__isIOS(), true, "iPad moderno se identifica como Macintosh, mas com touch -> iOS");
  s.navigator.maxTouchPoints = 0;
  assert.equal(s.__isIOS(), false, "Mac de verdade (sem touch) -> não é iOS");
  s.navigator.userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8)";
  assert.equal(s.__isIOS(), false, "Android -> não é iOS");
  console.log("isIOS: OK");
}

// ---------- classifyTtsError: motivo pra cada caso do diagnóstico ----------
{
  const s = makeSandbox();
  assert.equal(s.__classifyTtsError({ name: "NotAllowedError" }), "bloqueio de áudio do aparelho");
  assert.equal(s.__classifyTtsError({ name: "AbortError" }), "rede/tempo esgotado");
  assert.equal(s.__classifyTtsError(new Error("tts_http_500")), "Worker sem voz");
  assert.equal(s.__classifyTtsError(new Error("tts_http_429")), "Worker sem voz");
  assert.equal(s.__classifyTtsError(new Error("no_worker")), "Worker sem voz");
  assert.equal(s.__classifyTtsError(new Error("tts_empty")), "rede/tempo esgotado", "erro desconhecido cai no genérico de rede");
  assert.equal(s.__classifyTtsError(null), "rede/tempo esgotado", "nunca quebra sem erro nenhum");
  console.log("classifyTtsError (motivo pra cada caso): OK");
}

// ---------- timeout: 20s (não mais 12s) + 1 retry antes de desistir ----------
{
  assert.equal(makeSandbox().__TTS_TIMEOUT_MS, 20000, "timeout do TTS é 20s, não mais 12s");

  let calls = 0;
  const s = makeSandbox({
    fetchImpl: () => {
      calls++;
      if(calls === 1) return Promise.reject(Object.assign(new Error("network"), { name: "TypeError" }));
      return Promise.resolve({ ok: true, json: async () => ({ audio_b64: "QUFB", provider: "azure" }) });
    },
  });
  const r = await s.__fetchTtsAudioWithRetry("oi");
  assert.equal(calls, 2, "tentou de novo UMA vez depois da primeira falha");
  // objeto vem do sandbox (outro "realm") — compara campo a campo, não por identidade de protótipo
  assert.equal(r.b64, "QUFB", "a segunda tentativa deu certo e devolveu o áudio");
  assert.equal(r.provider, "azure");
  console.log("fetchTtsAudioWithRetry (1 retry antes de desistir): OK");
}
{
  let calls = 0;
  const s = makeSandbox({ fetchImpl: () => { calls++; return Promise.reject(new Error("tts_http_500")); } });
  const r = await s.__fetchTtsAudioWithRetry("oi");
  assert.equal(calls, 2, "tentou exatamente 2 vezes (1 original + 1 retry), nunca mais que isso");
  assert.ok(r && r.error, "se as duas tentativas falharem, devolve {error}, nunca lança");
  console.log("fetchTtsAudioWithRetry (desiste depois do retry também falhar): OK");
}

// ---------- playAudioForGen: usa o elemento único (ttsEl), nunca cria outro Audio ----------
{
  const s = makeSandbox();
  s.__elTts._playImpl = () => { queueMicrotask(() => { s.__elTts.onplay && s.__elTts.onplay(); s.__elTts.onended && s.__elTts.onended(); }); return Promise.resolve(); };
  const st = s.__getSpeechState();
  const myGen = st.generation;
  await s.__playAudioForGen({ b64: "QUFB", provider: "azure" }, myGen);
  assert.equal(s.__elTts.src, "data:audio/mpeg;base64,QUFB", "tocou no ttsEl único, trocando só o src");
  console.log("playAudioForGen (elemento único reaproveitado): OK");
}

// ---------- updateVoiceProviderLabel: mostra o motivo quando o provedor é o navegador ----------
{
  const s = makeSandbox();
  const el = { textContent: "" };
  s.document.getElementById = (id) => (id === "voiceProviderLabel" ? el : (id === "ttsEl" ? s.__elTts : null));
  s.localStorage.setItem("raiz_last_voice_provider", "azure");
  s.__updateVoiceProviderLabel();
  assert.equal(el.textContent, "última voz: Azure (oficial)", "sem motivo quando a voz unificada funcionou");

  s.localStorage.setItem("raiz_last_voice_provider", "browser");
  s.__recordVoiceFallbackReason("bloqueio de áudio do aparelho");
  s.__updateVoiceProviderLabel();
  assert.ok(el.textContent.startsWith("última voz: navegador (reserva) — motivo: bloqueio de áudio do aparelho"), `mostra o motivo: "${el.textContent}"`);
  console.log("updateVoiceProviderLabel (motivo visível pro navegador): OK");
}

// ---------- NotAllowedError: NUNCA cai direto pro navegador — espera o próximo gesto e tenta de novo ----------
{
  const s = makeSandbox({
    fetchImpl: () => Promise.resolve({ ok: true, json: async () => ({ audio_b64: "QUFB", provider: "azure" }) }),
  });
  // conta só as tentativas com o áudio de verdade — a tentativa "silenciosa" de destravo
  // (performAudioUnlock, disparada pelo mesmo gesto) também chama play(), mas com outro src.
  let realPlayAttempts = 0;
  s.__elTts._playImpl = function(){
    if(this._src !== "data:audio/mpeg;base64,QUFB") return Promise.resolve(); // destravo silencioso
    realPlayAttempts++;
    if(realPlayAttempts === 1) return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    // segunda tentativa (depois do "gesto"): toca normalmente
    queueMicrotask(() => { s.__elTts.onplay && s.__elTts.onplay(); s.__elTts.onended && s.__elTts.onended(); });
    return Promise.resolve();
  };
  const st = s.__getSpeechState();
  const myGen = st.generation;
  const p = s.__speakChunksStreaming(["Oi, tudo bem?"], myGen);
  // dá um tempo pro primeiro play() (bloqueado) rodar e cair no hint de "toque pra ativar"
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.__elHint.textContent, "Toque na tela para ativar a voz", "mostra o hint discreto, nunca cai direto pro navegador");
  assert.equal(s.__speakBrowserCalls.length, 0, "ainda não usou a voz do navegador — só está esperando o próximo gesto");
  // simula o próximo toque na tela
  s.__fireGesture("click");
  await p;
  assert.equal(s.__speakBrowserCalls.length, 0, "o retry depois do gesto funcionou — nunca precisou da voz do navegador");
  assert.equal(realPlayAttempts, 2, "tentou tocar de novo (o MESMO áudio já buscado) depois do gesto, sem buscar de novo");
  console.log("NotAllowedError (guarda pendente, espera o gesto, retry): OK");
}

// ---------- NotAllowedError: se o retry TAMBÉM falhar, aí sim usa a voz do navegador (com motivo) ----------
{
  const s = makeSandbox({
    fetchImpl: () => Promise.resolve({ ok: true, json: async () => ({ audio_b64: "QUFB", provider: "azure" }) }),
  });
  s.__elTts._playImpl = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
  const st = s.__getSpeechState();
  const myGen = st.generation;
  const p = s.__speakChunksStreaming(["Oi, tudo bem?"], myGen);
  await new Promise((r) => setTimeout(r, 20));
  s.__fireGesture("click");
  await p;
  assert.deepEqual(s.__speakBrowserCalls, ["Oi, tudo bem?"], "retry falhou de novo -> cai pra voz do navegador, só nesse ponto");
  assert.equal(s.localStorage.getItem("raiz_last_voice_reason"), "bloqueio de áudio do aparelho", "motivo registrado pro diagnóstico");
  console.log("NotAllowedError (retry também falha -> voz do navegador, com motivo): OK");
}

console.log("_voz-mobile-unlock.test.mjs: todos os testes passaram");
