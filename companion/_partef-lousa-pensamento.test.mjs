// PARTE F: regras de ociosidade/intervalo do "pensar sozinho" (relógio simulado) e a
// exclusividade lousa/pensamento — extraídas DIRETO do companion/index.html (não uma
// reimplementação), num sandbox node:vm, mesmo padrão de companion/_voz-eco-apelidos.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const inicioMarcador = '/* ========== Lousa real e quadro de pensamento';
const fimMarcador = '/* ========== Motor "classic"';
const inicio = html.indexOf(inicioMarcador);
const fimIdx = html.indexOf(fimMarcador, inicio);
assert.ok(inicio !== -1 && fimIdx !== -1, "achou o bloco de lousa/pensamento no companion/index.html");
const trecho = html.slice(inicio, fimIdx);

function fakeEl() {
  const el = {
    hidden: true,
    style: {},
    innerHTML: "",
    textContent: "",
    classList: { list: new Set(), add(c) { this.list.add(c); }, remove(c) { this.list.delete(c); }, contains(c) { return this.list.has(c); } },
    addEventListener() {},
    querySelector() { return fakeEl(); },
    getContext() { return { fillRect() {}, arc() {}, beginPath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, ellipse() {}, createLinearGradient() { return { addColorStop() {} }; }, createRadialGradient() { return { addColorStop() {} }; } }; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 225 }; },
  };
  return el;
}

function makeSandbox({ opts, classicFace, materializado } = {}) {
  const elements = {
    lousa: fakeEl(), lousaSvg: fakeEl(), giz: fakeEl(),
    pensamento: fakeEl(), pensCv: fakeEl(), pensLeg: fakeEl(),
  };
  const sandbox = {
    CLASSIC_FACE: !!classicFace,
    opts: { pensamento: true, lousa: true, ...(opts || {}) },
    document: { hidden: false, getElementById: (id) => elements[id] || null, addEventListener() {} },
    window: { Jarbas: { isMaterialized: () => !!materializado } },
    sleepFaceState: { dormindo: false },
    state: { expr: "neutro" },
    G: { rob: { t: 0 } },
    gazeTarget: [0, 0], gazeHold: 0,
    clamp: (x, a, b) => (x < a ? a : x > b ? b : x),
    rndRange: (a, b) => a + Math.random() * (b - a),
    TAU: Math.PI * 2,
    effectiveQuality: () => "total",
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    performance: { now: () => Date.now() },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(trecho + `
    this.__podePensarSozinho = podePensarSozinho;
    this.__tentarPensarSozinho = tentarPensarSozinho;
    this.__pensar = pensar;
    this.__pensarFim = pensarFim;
    this.__getPensName = () => pensName;
    this.__setLastInteractionAt = (v) => { lastInteractionAt = v; };
    this.__getLastInteractionAt = () => lastInteractionAt;
    this.__setPensarUltimoAs = (v) => { pensarUltimoAs = v; };
    this.__setPensarLimiarMs = (v) => { pensarLimiarMs = v; };
    this.__getPensarLimiarMs = () => pensarLimiarMs;
    this.__setIsSpeaking = (v) => { isSpeaking = v; };
    this.__setListening = (v) => { listening = v; };
    this.__setAwaitingCommand = (v) => { awaitingCommand = v; };
  `, sandbox);
  sandbox.__elements = elements;
  sandbox.__setPensarUltimoAs(-1e9); // sem cena anterior recente — testes de cooldown ajustam por conta própria
  return sandbox;
}

// ---------- podePensarSozinho: cada bloqueio isolado, com relógio simulado ----------
{
  const s = makeSandbox();
  s.__setLastInteractionAt(0);
  s.__setPensarLimiarMs(60000);
  // antes do limiar de ociosidade -> false
  assert.equal(s.__podePensarSozinho(30000), false, "antes dos 40-90s de ociosidade -> não pensa ainda");
  // depois do limiar -> true (nenhum outro bloqueio ativo)
  assert.equal(s.__podePensarSozinho(90000), true, "depois do limiar de ociosidade, sem bloqueios -> pode pensar");
  console.log("podePensarSozinho (limiar de ociosidade, relógio simulado): OK");
}
{
  const s = makeSandbox({ classicFace: true });
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, "motor classic nunca pensa sozinho");
}
{
  const s = makeSandbox({ opts: { pensamento: false } });
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, "mem.config.aparencia.pensamento desligado -> nunca pensa");
}
{
  const s = makeSandbox();
  s.document.hidden = true;
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, "aba oculta -> nunca pensa (sem custo escondido)");
}
{
  const s = makeSandbox();
  s.sleepFaceState.dormindo = true;
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, "dormindo -> nunca pensa");
}
{
  const s = makeSandbox();
  s.effectiveQuality = () => "leve";
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, '"modo econômico" (qualidade leve) -> nunca pensa');
}
{
  const s = makeSandbox({ materializado: true });
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, "materialização em curso tem prioridade sobre pensar sozinho");
}
{
  const s = makeSandbox();
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  s.__setIsSpeaking(true);
  assert.equal(s.__podePensarSozinho(999999), false, "falando -> nunca pensa");
}
{
  const s = makeSandbox();
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  s.__setListening(true);
  assert.equal(s.__podePensarSozinho(999999), false, "gravando/ouvindo -> nunca pensa");
}
{
  const s = makeSandbox();
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  s.__setAwaitingCommand(true);
  assert.equal(s.__podePensarSozinho(999999), false, "aguardando comando (janela de continuidade) -> nunca pensa");
}
{
  const s = makeSandbox();
  s.__elements.lousa.hidden = false; // lousa aberta
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  assert.equal(s.__podePensarSozinho(999999), false, "lousa aberta tem prioridade sobre pensar sozinho");
}
console.log("podePensarSozinho (cada bloqueio isolado): OK");

// ---------- intervalo mínimo: no máximo 1 cena a cada 10min ----------
{
  const s = makeSandbox();
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000);
  s.__setPensarUltimoAs(500000);
  assert.equal(s.__podePensarSozinho(500000 + 9 * 60000), false, "antes de 10min desde a última cena -> não pensa de novo");
  assert.equal(s.__podePensarSozinho(500000 + 11 * 60000), true, "depois de 10min -> pode pensar de novo");
  console.log("intervalo mínimo de 10min entre cenas: OK");
}

// ---------- tentarPensarSozinho: dispara pensar() e sorteia um novo limiar (40-90s) ----------
{
  const s = makeSandbox();
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000); s.__setPensarUltimoAs(0);
  assert.equal(s.__getPensName(), null);
  s.__tentarPensarSozinho(999999);
  assert.ok(s.__getPensName(), "disparou uma cena de pensamento");
  assert.ok(["praia", "fogos", "flor", "sofa"].includes(s.__getPensName()), "cena é uma das 4 implementadas");
  const novoLimiar = s.__getPensarLimiarMs();
  assert.ok(novoLimiar >= 40000 && novoLimiar <= 90000, "novo limiar sorteado entre 40 e 90s, pra próxima ociosidade");
  console.log("tentarPensarSozinho (dispara e resorteia o limiar): OK");
}
{
  // não tenta de novo (nem redispara) enquanto já há uma cena rodando
  const s = makeSandbox();
  s.__setLastInteractionAt(0); s.__setPensarLimiarMs(1000); s.__setPensarUltimoAs(0);
  s.__pensar("praia", 999999);
  const antes = s.__getPensName();
  s.__tentarPensarSozinho(999999);
  assert.equal(s.__getPensName(), antes, "cena já rodando nunca é substituída por outra tentativa");
  console.log("tentarPensarSozinho (não redispara com cena já rodando): OK");
}

// ---------- pensar/pensarFim: nomes inválidos, motor classic, e sceneByMood por humor ----------
{
  const s = makeSandbox();
  s.__pensar("nao-existe", 1000);
  assert.equal(s.__getPensName(), null, "cena desconhecida nunca abre nada");
}
{
  const s = makeSandbox({ classicFace: true });
  s.__pensar("praia", 1000);
  assert.equal(s.__getPensName(), null, "motor classic nunca abre o quadro de pensamento");
}
{
  const s = makeSandbox();
  s.__pensar("praia", 999999);
  assert.equal(s.__getPensName(), "praia");
  assert.equal(s.__elements.pensamento.hidden, false, "elemento do pensamento fica visível");
  s.__pensarFim();
  assert.ok(s.__elements.pensamento.classList.contains("some"), "pensarFim inicia a transição de saída");
  console.log("pensar/pensarFim (abre e fecha): OK");
}

console.log("_partef-lousa-pensamento.test.mjs: todos os testes passaram");
