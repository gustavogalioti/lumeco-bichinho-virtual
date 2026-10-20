// PARTE A (mãos livres no mobile): laço de reinício, backoff, parada por erro fatal,
// folga de eco maior em touch, comparação com a fala em andamento, e modo por turnos no
// iOS — tudo extraído DIRETO do companion/index.html (não uma reimplementação), num
// sandbox node:vm, mesmo padrão de companion/_voz-eco-apelidos.test.mjs e
// companion/_voz-mobile-unlock.test.mjs. `isIOS` é fornecido como dependência externa
// (já testado em _voz-mobile-unlock.test.mjs) — aqui só precisamos dele funcionando
// pra verificar como initRecognition reage.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const inicioMarcador = "const HANDS_FREE_KEY = 'raiz_hands_free';";
const fimMarcador = '/* ---------- Gravação + transcrição via Groq (Whisper) no modo "toque para falar" ----------';
const inicio = html.indexOf(inicioMarcador);
const fim = html.indexOf(fimMarcador, inicio);
assert.ok(inicio !== -1 && fim !== -1, "achou o bloco de mãos livres/reconhecimento no companion/index.html");
const trecho = html.slice(inicio, fim);

function fakeEl() {
  return { classList: { add() {}, remove() {}, contains() { return false; } }, style: {}, textContent: "" };
}

function makeSandbox({ handsFreeInicial = true, userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8)", maxTouchPoints = 5, pointerCoarse = false, mem, history } = {}) {
  const store = new Map();
  if (handsFreeInicial) store.set("raiz_hands_free", "1");
  const fakeLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  let fakeNow = 1700000000000;
  const setTimeoutCalls = [];
  const sandbox = {
    mem: mem || { config: {} },
    history: history || [],
    navigator: { userAgent, maxTouchPoints },
    matchMedia: () => ({ matches: pointerCoarse }),
    localStorage: fakeLocalStorage,
    hint: fakeEl(),
    micBtn: fakeEl(),
    G: { listen: { t: 0 } },
    CLASSIC_FACE: true, // evita precisar simular pensarFim/pensamento nesses testes
    setEmotion: () => {},
    setCaption: () => {},
    handleLearnCommand: () => false,
    checkRoutineTrigger: () => false,
    checkDissolveCommand: () => false,
    askRaiz: (text) => { sandbox.__askRaizCalls.push(text); },
    __askRaizCalls: [],
    document: { createElement: () => ({ style: {} }), body: { appendChild() {} } },
    // isIOS já é testado em _voz-mobile-unlock.test.mjs — aqui é só uma dependência
    // externa fornecida com a MESMA lógica, pra initRecognition poder usá-la de verdade.
    isIOS: () => /iPad|iPhone|iPod/.test(sandbox.navigator.userAgent || "") || (/Macintosh/.test(sandbox.navigator.userAgent || "") && (sandbox.navigator.maxTouchPoints || 0) > 1),
    console,
    setInterval: () => 0, clearInterval() {}, // ticker cosmético, irrelevante pro teste
    setTimeout: (fn, delay) => { setTimeoutCalls.push({ fn, delay }); return setTimeoutCalls.length; },
    clearTimeout() {},
  };
  vm.createContext(sandbox);
  // Relógio controlável: Date.now() começa fixo e só avança quando o teste chama
  // __advanceTime — precisa ser MUTÁVEL (não um valor fixo só), porque o laço real
  // acontece ao longo do tempo (ver registerRestartAndCheckLoop, que filtra por janela).
  vm.runInContext(`
    let __fakeNow = ${fakeNow};
    Date.now = function(){ return __fakeNow; };
    this.__advanceTime = function(ms){ __fakeNow += ms; };
    this.__setNow = function(v){ __fakeNow = v; };
    // declarados fora do trecho extraído no index.html de verdade — precisam existir
    // ANTES do trecho rodar, senão as atribuições dentro dele (ex: "isSpeaking = true")
    // criam globais soltas em vez de reaproveitar o estado real.
    let isSpeaking = false;
    let recognition = null;
    let listening = false;
  `, sandbox);
  vm.runInContext(trecho + `
    this.__isTouchDevice = isTouchDevice;
    this.__echoGraceMsFor = echoGraceMsFor;
    this.__isFatalRecognitionError = isFatalRecognitionError;
    this.__backoffDelayMs = backoffDelayMs;
    this.__registerRestartAndCheckLoop = registerRestartAndCheckLoop;
    this.__isLikelyEcho = isLikelyEcho;
    this.__shouldDiscardAsEcho = shouldDiscardAsEcho;
    this.__pauseHandsFreeForSpeech = pauseHandsFreeForSpeech;
    this.__resumeHandsFreeListening = resumeHandsFreeListening;
    this.__initRecognition = initRecognition;
    this.__getHandsFree = () => handsFree;
    this.__setHandsFree = (v) => { handsFree = v; };
    this.__setListening = (v) => { listening = v; };
    this.__getListening = () => listening;
    this.__setIsSpeaking = (v) => { isSpeaking = v; };
    this.__setSpeechEndedAt = (v) => { speechEndedAt = v; };
    this.__getRestartTimestamps = () => restartTimestamps;
    this.__setLastAcceptedPhraseAt = (v) => { lastAcceptedPhraseAt = v; };
  `, sandbox);
  sandbox.__setTimeoutCalls = setTimeoutCalls;
  sandbox.__lastDelay = () => (setTimeoutCalls.length ? setTimeoutCalls[setTimeoutCalls.length - 1].delay : null);
  return sandbox;
}

function makeFakeRecognitionCtor(sandbox) {
  const instances = [];
  function FakeSpeechRecognition() {
    this.startCalls = 0;
    this.stopCalls = 0;
    this.start = () => { this.startCalls++; };
    this.stop = () => { this.stopCalls++; };
    instances.push(this);
  }
  sandbox.SpeechRecognition = FakeSpeechRecognition;
  sandbox.__recognitionInstances = instances;
  return instances;
}

// ---------- isTouchDevice / echoGraceMsFor ----------
{
  const touch = makeSandbox({ maxTouchPoints: 5 });
  assert.equal(touch.__isTouchDevice(), true, "maxTouchPoints > 0 -> touch");
  assert.equal(touch.__echoGraceMsFor(true), 1800, "folga de eco maior em touch (1,8s)");
  assert.equal(touch.__echoGraceMsFor(false), 900, "folga de eco padrão fora de touch (900ms)");

  const desktop = makeSandbox({ maxTouchPoints: 0, pointerCoarse: false });
  assert.equal(desktop.__isTouchDevice(), false, "sem touch e sem pointer:coarse -> não é touch");

  const coarse = makeSandbox({ maxTouchPoints: 0, pointerCoarse: true });
  assert.equal(coarse.__isTouchDevice(), true, "pointer:coarse (ex: notebook touch) também conta como touch");
  console.log("isTouchDevice / echoGraceMsFor: OK");
}

// ---------- isFatalRecognitionError ----------
{
  const s = makeSandbox();
  assert.equal(s.__isFatalRecognitionError("not-allowed"), true);
  assert.equal(s.__isFatalRecognitionError("service-not-allowed"), true);
  assert.equal(s.__isFatalRecognitionError("no-speech"), false);
  assert.equal(s.__isFatalRecognitionError("aborted"), false);
  console.log("isFatalRecognitionError: OK");
}

// ---------- backoffDelayMs: progressão 300/600/1200/2500/5000 ----------
{
  const s = makeSandbox();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => s.__backoffDelayMs(n)), [300, 600, 1200, 2500, 5000, 5000, 5000], "a partir do 5º reinício, trava em 5s");
  console.log("backoffDelayMs: OK");
}

// ---------- registerRestartAndCheckLoop: 6 reinícios em 30s sem frase aceita -> para ----------
{
  const s = makeSandbox();
  let timestamps = [];
  let now = 1000000;
  for (let i = 1; i <= 5; i++) {
    const r = s.__registerRestartAndCheckLoop(timestamps, now, 0, 30000, 6);
    timestamps = r.timestamps;
    assert.equal(r.shouldStop, false, `reinício ${i}/6 ainda não deve parar`);
    now += 200;
  }
  const r6 = s.__registerRestartAndCheckLoop(timestamps, now, 0, 30000, 6);
  assert.equal(r6.shouldStop, true, "o 6º reinício na janela, sem frase aceita, dispara a parada");
  console.log("registerRestartAndCheckLoop (laço sem frase aceita): OK");
}
{
  // se uma frase foi aceita DENTRO da janela, não para — mesmo com 6+ reinícios
  // (conversa normal: cada troca de turno naturalmente passa por onend várias vezes)
  const s = makeSandbox();
  let timestamps = [];
  const lastAcceptedAt = 999900; // dentro da janela de 30s a partir de 'now' abaixo
  let now = 1000000;
  for (let i = 1; i <= 7; i++) {
    const r = s.__registerRestartAndCheckLoop(timestamps, now, lastAcceptedAt, 30000, 6);
    timestamps = r.timestamps;
    assert.equal(r.shouldStop, false, `reinício ${i} não para — teve frase aceita há pouco`);
    now += 200;
  }
  console.log("registerRestartAndCheckLoop (frase aceita recente evita a parada): OK");
}
{
  // reinícios antigos (fora da janela de 30s) não contam mais
  const s = makeSandbox();
  const antigos = [0, 1000, 2000, 3000, 4000]; // há "muito tempo" em relação a nowMs abaixo
  const r = s.__registerRestartAndCheckLoop(antigos, 1000000, 0, 30000, 6);
  assert.equal(r.timestamps.length, 1, "só o reinício novo (o que está sendo registrado agora) sobrevive ao filtro");
  assert.equal(r.shouldStop, false, "sem 6 reinícios dentro da janela -> não para");
  console.log("registerRestartAndCheckLoop (janela descarta reinícios antigos): OK");
}

// ---------- isLikelyEcho / shouldDiscardAsEcho: compara também contra a fala em andamento ----------
{
  const nowMs = Date.parse("2026-10-20T10:00:00Z");
  const s = makeSandbox({ history: [] }); // SEM histórico — só a fala em andamento disponível
  const emAndamento = "Hoje você tem uma reunião importante às 10h com o time inteiro.";
  const ecoDaFalaEmAndamento = "hoje você tem uma reunião importante às 10h com o time inteiro";
  assert.equal(s.__isLikelyEcho(ecoDaFalaEmAndamento, nowMs, emAndamento), true, "eco da fala EM ANDAMENTO é pego mesmo sem estar no histórico ainda");
  assert.equal(s.__isLikelyEcho("jarbas, muda de assunto", nowMs, emAndamento), false, "fala nova e diferente continua passando");
  assert.equal(
    s.__shouldDiscardAsEcho(ecoDaFalaEmAndamento, nowMs, true, false, 0, 900, emAndamento),
    true,
    "shouldDiscardAsEcho também recebe e usa a fala em andamento"
  );
  console.log("isLikelyEcho / shouldDiscardAsEcho (fala em andamento): OK");
}

// ---------- pauseHandsFreeForSpeech: sem depender de `listening` (corrige a corrida) ----------
{
  const s = makeSandbox({ handsFreeInicial: true });
  makeFakeRecognitionCtor(s);
  s.__initRecognition();
  const rec = s.__recognitionInstances[0];
  // simula exatamente a corrida: recognition.start() já foi chamado, mas o onstart
  // (que seta `listening=true`) ainda não disparou — `listening` continua false.
  s.__setListening(false);
  s.__pauseHandsFreeForSpeech();
  assert.equal(rec.stopCalls, 1, "para o reconhecimento mesmo com listening ainda false (sem a corrida antiga)");
  console.log("pauseHandsFreeForSpeech (sem corrida com recognition.start): OK");
}

// ---------- initRecognition: continuous=false no iOS (modo por turnos), true fora dele ----------
{
  const android = makeSandbox({ handsFreeInicial: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" });
  makeFakeRecognitionCtor(android);
  android.__initRecognition();
  assert.equal(android.__recognitionInstances[0].continuous, true, "Android com mãos livres ligado -> contínuo de verdade");

  const iphone = makeSandbox({ handsFreeInicial: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
  makeFakeRecognitionCtor(iphone);
  iphone.__initRecognition();
  assert.equal(iphone.__recognitionInstances[0].continuous, false, "iOS -> nunca contínuo de verdade (vira conversa por turnos)");
  console.log("initRecognition (continuous: turnos no iOS): OK");
}

// ---------- onerror: not-allowed/service-not-allowed param NA HORA, sem tentar reiniciar ----------
for (const erroFatal of ["not-allowed", "service-not-allowed"]) {
  const s = makeSandbox({ handsFreeInicial: true });
  makeFakeRecognitionCtor(s);
  s.__initRecognition();
  const rec = s.__recognitionInstances[0];
  rec.onerror({ error: erroFatal });
  assert.equal(s.__getHandsFree(), false, `${erroFatal}: mãos livres desligado na hora`);
  assert.ok(s.hint.textContent.startsWith("Mãos livres pausado"), `${erroFatal}: mensagem clara no hint ("${s.hint.textContent}")`);
  assert.equal(s.__setTimeoutCalls.length, 0, `${erroFatal}: nunca agenda um reinício`);
  assert.equal(s.localStorage.getItem("raiz_hands_free"), "0", `${erroFatal}: persiste o desligamento`);
}
console.log("onerror (not-allowed/service-not-allowed): parada imediata, sem reinício: OK");

// ---------- onend em sequência rápida (laço real) -> backoff crescente e parada após 6 ----------
{
  const s = makeSandbox({ handsFreeInicial: true });
  makeFakeRecognitionCtor(s);
  s.__initRecognition();
  const rec = s.__recognitionInstances[0];
  s.__setListening(true); // estava "ouvindo" quando o onend chegou, como no navegador de verdade

  const delaysObservados = [];
  for (let i = 1; i <= 5; i++) {
    rec.onend();
    assert.equal(s.__getHandsFree(), true, `reinício ${i}/6: ainda não desligou`);
    delaysObservados.push(s.__lastDelay());
    s.__advanceTime(200); // ~200ms entre cada onend, bem dentro da janela de 30s
  }
  assert.deepEqual(delaysObservados, [350, 600, 1200, 2500, 5000], "backoff cresce a cada reinício (piso de 350ms no 1º, depois a progressão de verdade)");

  // 6º reinício, ainda sem nenhuma frase aceita -> pausa o mãos livres
  const chamadasAntes = s.__setTimeoutCalls.length;
  rec.onend();
  assert.equal(s.__getHandsFree(), false, "6º reinício em 30s sem frase aceita -> mãos livres pausado");
  assert.equal(s.hint.textContent, "Mãos livres pausado: toque para retomar", `mensagem discreta esperada (hint: "${s.hint.textContent}")`);
  assert.equal(s.__setTimeoutCalls.length, chamadasAntes, "não agenda mais nenhum reinício depois de pausar por laço");
  console.log("onend (laço rápido): backoff crescente + parada após 6 reinícios em 30s: OK");
}

// ---------- uma frase aceita no meio do caminho reseta o contador de laço ----------
{
  const s = makeSandbox({ handsFreeInicial: true });
  makeFakeRecognitionCtor(s);
  s.__initRecognition();
  const rec = s.__recognitionInstances[0];
  s.__setListening(true);

  for (let i = 1; i <= 4; i++) { rec.onend(); s.__advanceTime(200); }
  assert.ok(s.__getRestartTimestamps().length >= 4, "acumulou reinícios");

  // simula uma frase de verdade sendo aceita (o que o onresult faz nos ramos "aceito")
  s.__setLastAcceptedPhraseAt(Date.now());
  // a lógica de reset mora no onresult (não no onend) — aqui testamos só que, uma vez
  // que lastAcceptedPhraseAt está recente, nem 6 reinícios adicionais disparam a parada
  // (ver teste de registerRestartAndCheckLoop acima, que cobre essa regra isoladamente);
  // confirmamos aqui que, de fato, continua rodando depois de mais reinícios:
  for (let i = 1; i <= 6; i++) { rec.onend(); s.__advanceTime(200); }
  assert.equal(s.__getHandsFree(), true, "com frase aceita recente, reinícios adicionais não pausam o mãos livres");
  console.log("onend (frase aceita recente protege contra falso positivo de laço): OK");
}

// ---------- pausa deliberada pra falar NÃO conta como reinício de laço ----------
{
  const s = makeSandbox({ handsFreeInicial: true });
  makeFakeRecognitionCtor(s);
  s.__initRecognition();
  const rec = s.__recognitionInstances[0];
  s.__setListening(true);

  // Jarbas vai falar 8 vezes numa conversa normal (bem mais que o limite de 6/30s) —
  // cada fala passa por pauseHandsFreeForSpeech -> recognition.stop() -> onend.
  for (let i = 1; i <= 8; i++) {
    s.__pauseHandsFreeForSpeech();
    rec.onend();
    s.__advanceTime(500);
  }
  assert.equal(s.__getHandsFree(), true, "8 pausas pra falar em sequência NUNCA pausam o mãos livres por laço (não são reinícios de erro)");
  assert.equal(s.__getRestartTimestamps().length, 0, "nenhuma dessas pausas é contada como reinício de laço");
  console.log("onend (pausa pra falar nunca conta como reinício de laço): OK");
}

console.log("_partea-maos-livres-loop.test.mjs: todos os testes passaram");
