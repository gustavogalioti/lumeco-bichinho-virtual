// Testa registerCreation (limite de peso de mem.creations) extraído DIRETO do
// companion/index.html — não uma reimplementação — num sandbox node:vm, mesmo padrão
// de companion/_voz-eco-apelidos.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const inicio = html.indexOf("const JARBAS_CREATIONS_MAX");
const fimMarcador = "    return c;\n  });\n}";
const fimIdx = html.indexOf(fimMarcador, inicio);
assert.ok(inicio !== -1 && fimIdx !== -1, "achou registerCreation no companion/index.html");
const trecho = html.slice(inicio, fimIdx + fimMarcador.length);

function sb(initialMem) {
  const sandbox = { mem: initialMem || {} };
  vm.createContext(sandbox);
  vm.runInContext(trecho + `
    this.__registerCreation = registerCreation;
    this.__JARBAS_CREATIONS_MAX = JARBAS_CREATIONS_MAX;
    this.__JARBAS_CREATIONS_SVG_COM_PREVIA = JARBAS_CREATIONS_SVG_COM_PREVIA;
  `, sandbox);
  return sandbox;
}

// ---------- limite de 60 criações ----------
{
  const s = sb({ creations: [] });
  assert.equal(s.__JARBAS_CREATIONS_MAX, 60);
  for (let i = 0; i < 65; i++) {
    s.__registerCreation({ titulo: `criação ${i}`, kind: "cena", data: [{ e: "✨", x: 0, y: 0, s: 100 }], motivo: "teste", origem: "pedido" });
  }
  assert.equal(s.mem.creations.length, 60, "nunca passa de 60 criações");
  // unshift -> a mais recente (criação 64) fica em [0]; as 5 mais antigas (0..4) caem fora
  assert.equal(s.mem.creations[0].title, "criação 64", "a mais recente fica na frente");
  assert.ok(!s.mem.creations.some(c => c.title === "criação 0"), "a criação mais antiga é descartada ao passar de 60");
  assert.ok(!s.mem.creations.some(c => c.title === "criação 4"), "a 5ª criação mais antiga também é descartada");
  assert.ok(s.mem.creations.some(c => c.title === "criação 5"), "a criação 60 mais recentes (a partir da 6ª) sobrevive");
  console.log("limite de 60 criações: OK");
}

// ---------- SVG: só as 15 mais recentes guardam `data` ----------
{
  const s = sb({ creations: [] });
  assert.equal(s.__JARBAS_CREATIONS_SVG_COM_PREVIA, 15);
  const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  for (let i = 0; i < 20; i++) {
    s.__registerCreation({ titulo: `svg ${i}`, kind: "svg", data: svg, motivo: `motivo ${i}`, origem: "pedido" });
  }
  assert.equal(s.mem.creations.length, 20);
  // as 15 mais recentes (índices 0..14, svg 19..5) mantêm o data
  for (let i = 0; i < 15; i++) {
    assert.equal(s.mem.creations[i].data, svg, `posição ${i} (mais recente) mantém o SVG`);
    assert.ok(!s.mem.creations[i].semPrevia, `posição ${i} não está marcada como sem prévia`);
  }
  // da 16ª em diante (índices 15..19, svg 4..0) perde o data, mas preserva o resto
  for (let i = 15; i < 20; i++) {
    const c = s.mem.creations[i];
    assert.equal(c.data, null, `posição ${i} (mais antiga) perde o SVG`);
    assert.equal(c.semPrevia, true, `posição ${i} marcada como sem prévia`);
    assert.ok(c.title.startsWith("svg "), "título preservado");
    assert.ok(c.at, "data (timestamp) preservada");
    assert.equal(c.origem, "pedido", "origem preservada");
    assert.ok(c.motivo.startsWith("motivo "), "motivo preservado");
  }
  console.log("SVG com prévia só nas 15 mais recentes: OK");
}

// ---------- cena de emoji e forma mantêm `data` mesmo além da posição 15 ----------
{
  const s = sb({ creations: [] });
  const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  // 10 SVGs antigos primeiro (vão ficar nas posições mais antigas)
  for (let i = 0; i < 10; i++) {
    s.__registerCreation({ titulo: `svg antigo ${i}`, kind: "svg", data: svg, motivo: "x", origem: "pedido" });
  }
  // 10 cenas/formas mais recentes por cima
  for (let i = 0; i < 5; i++) {
    s.__registerCreation({ titulo: `cena ${i}`, kind: "cena", data: [{ e: "🎈", x: 0, y: 0, s: 100 }], motivo: "x", origem: "pedido" });
  }
  for (let i = 0; i < 5; i++) {
    s.__registerCreation({ titulo: `forma ${i}`, kind: "forma", data: "bola", motivo: "x", origem: "pedido" });
  }
  // agora temos 20 no total: 10 formas/cenas (mais recentes, posições 0-9) + 10 SVGs
  // antigos (posições 10-19) — todos os SVGs antigos estão na posição >= 15? Não todos,
  // só os que caem a partir do índice 15 perdem o data; cena/forma nunca perdem, não
  // importa a posição.
  const cenasEFormas = s.mem.creations.filter(c => c.kind === "cena" || c.kind === "forma");
  assert.equal(cenasEFormas.length, 10);
  for (const c of cenasEFormas) {
    assert.ok(c.data !== null, `${c.kind} "${c.title}" mantém data mesmo na posição ${s.mem.creations.indexOf(c)}`);
    assert.ok(!c.semPrevia, `${c.kind} nunca é marcada como semPrevia`);
  }
  console.log("cena/forma mantêm data sempre: OK");
}

console.log("_eco2-criacoes-limite.test.mjs: todos os testes passaram");
