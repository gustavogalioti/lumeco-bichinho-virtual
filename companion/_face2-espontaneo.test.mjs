// Testa a lógica de verdade de podeMaterializarEspontaneo() extraída direto do
// companion/index.html (não uma reimplementação) — roda o trecho real num sandbox
// com localStorage/document/mem/sleepFaceState simulados, via node:vm.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const inicio = html.indexOf("const SPONT_MATERIALIZE_KEY");
const fimMarcador = "\nfunction buildAparenciaForWorker(){";
const fim = html.indexOf(fimMarcador, inicio);
assert.ok(inicio !== -1 && fim !== -1, "achou o trecho de podeMaterializarEspontaneo no companion/index.html");
const trecho = html.slice(inicio, fim);

// ---------- sandbox: localStorage em memória + mocks mínimos ----------
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

function runPodeMaterializarEspontaneo({ cfg, hidden, dormindo, isMaterialized, nowMs, hojeISO, estadoAnterior }) {
  const localStorage = makeLocalStorage();
  if (estadoAnterior) localStorage.setItem("raiz_materializacao_espontanea_estado", JSON.stringify(estadoAnterior));
  const sandbox = {
    localStorage,
    document: { hidden: !!hidden },
    window: { Jarbas: { isMaterialized: () => !!isMaterialized } },
    mem: { config: { aparencia: { materializacaoEspontanea: cfg } } },
    sleepFaceState: { dormindo: !!dormindo },
    CLASSIC_FACE: false,
    todayISO: () => hojeISO,
    Date: { now: () => nowMs },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(trecho + "\nthis.__pode = podeMaterializarEspontaneo; this.__registrar = registerSpontMaterialization;", sandbox);
  return { pode: sandbox.__pode(), registrar: sandbox.__registrar, localStorage };
}

const HOJE = "2026-10-09";
const AGORA = new Date(`${HOJE}T12:00:00-03:00`).getTime();

// ---------- caso feliz: tudo liberado ----------
{
  const { pode } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: null,
  });
  assert.equal(pode, true, "sem nenhum bloqueio -> liberado");
}

// ---------- materializacaoEspontanea.ativa = false ----------
{
  const { pode } = runPodeMaterializarEspontaneo({
    cfg: { ativa: false, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: null,
  });
  assert.equal(pode, false, "ativa:false -> nunca espontâneo");
}

// ---------- app em segundo plano (document.hidden) ----------
{
  const { pode } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: true, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: null,
  });
  assert.equal(pode, false, "app escondido -> bloqueado");
}

// ---------- Jarbas dormindo ----------
{
  const { pode } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: true, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: null,
  });
  assert.equal(pode, false, "dormindo -> bloqueado");
}

// ---------- já tem algo materializado agora ----------
{
  const { pode } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: false, isMaterialized: true,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: null,
  });
  assert.equal(pode, false, "já materializado -> bloqueado (não empilha criações)");
}

// ---------- limite diário ----------
{
  const { pode: dentroDoLimite } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 0 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: { day: HOJE, count: 3, lastAt: AGORA - 3600000 },
  });
  assert.equal(dentroDoLimite, true, "3 de 4 hoje -> ainda liberado");

  const { pode: noLimite } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 0 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: { day: HOJE, count: 4, lastAt: AGORA - 3600000 },
  });
  assert.equal(noLimite, false, "4 de 4 hoje (no limite) -> bloqueado");

  const { pode: diaVirou } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 0 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: { day: "2026-10-08", count: 4, lastAt: AGORA - 90000000 },
  });
  assert.equal(diaVirou, true, "contador era de ontem -> zera, liberado de novo hoje");
}

// ---------- intervalo mínimo entre criações espontâneas ----------
{
  const { pode: cedoDemais } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: { day: HOJE, count: 1, lastAt: AGORA - 10 * 60000 },
  });
  assert.equal(cedoDemais, false, "só 10min desde a última (mínimo 20) -> bloqueado");

  const { pode: jaPassou } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: { day: HOJE, count: 1, lastAt: AGORA - 25 * 60000 },
  });
  assert.equal(jaPassou, true, "25min desde a última (mínimo 20) -> liberado de novo");
}

// ---------- registerSpontMaterialization incrementa e persiste corretamente ----------
{
  const { registrar, localStorage } = runPodeMaterializarEspontaneo({
    cfg: { ativa: true, maxPorDia: 4, intervaloMinimoMin: 20 },
    hidden: false, dormindo: false, isMaterialized: false,
    nowMs: AGORA, hojeISO: HOJE, estadoAnterior: { day: HOJE, count: 2, lastAt: AGORA - 3600000 },
  });
  registrar();
  const salvo = JSON.parse(localStorage.getItem("raiz_materializacao_espontanea_estado"));
  assert.equal(salvo.count, 3, "registerSpontMaterialization incrementa o contador do dia");
  assert.equal(salvo.day, HOJE);
}

console.log("podeMaterializarEspontaneo: OK");
console.log("registerSpontMaterialization: OK");
console.log("_face2-espontaneo.test.mjs: todos os testes passaram");
