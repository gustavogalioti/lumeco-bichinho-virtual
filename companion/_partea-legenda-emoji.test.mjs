// Testa as funções puras de legenda (PARTE A) e de remoção de emoji antes do TTS (PARTE
// C), extraídas DIRETO do companion/index.html — não uma reimplementação — num sandbox
// node:vm, mesmo padrão de companion/_voz-eco-apelidos.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function extrair(inicioMarcador, fimMarcador) {
  const inicio = html.indexOf(inicioMarcador);
  assert.ok(inicio !== -1, `achou o início "${inicioMarcador.slice(0, 40)}..."`);
  const fimIdx = html.indexOf(fimMarcador, inicio);
  assert.ok(fimIdx !== -1, `achou o fim "${fimMarcador.slice(0, 40)}..."`);
  return html.slice(inicio, fimIdx + fimMarcador.length);
}

const trechoLegenda = extrair(
  "function truncarLegenda(text, maxChars){",
  "  return s.slice(0, limite - 1).trim() + '…';\n}"
);
const trechoEmoji = extrair(
  "function stripEmojiForSpeech(text){",
  "    .trim();\n}"
);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(trechoLegenda + "\n" + trechoEmoji + `
  this.__truncarLegenda = truncarLegenda;
  this.__stripEmojiForSpeech = stripEmojiForSpeech;
`, sandbox);

// ---------- truncarLegenda ----------
{
  assert.equal(sandbox.__truncarLegenda("oi"), "oi", "texto curto passa direto");
  assert.equal(sandbox.__truncarLegenda("", 180), "", "vazio -> vazio");
  assert.equal(sandbox.__truncarLegenda(null), "", "null -> vazio, nunca quebra");

  const longo = "a".repeat(200);
  const cortado = sandbox.__truncarLegenda(longo, 180);
  assert.equal(cortado.length, 180, "nunca passa do limite");
  assert.ok(cortado.endsWith("…"), "texto longo é cortado com “…”");

  // limite exato: nem corta nem sobra
  const exato = "b".repeat(180);
  assert.equal(sandbox.__truncarLegenda(exato, 180), exato, "no limite exato, não corta");

  console.log("truncarLegenda: OK");
}

// ---------- stripEmojiForSpeech ----------
{
  assert.equal(sandbox.__stripEmojiForSpeech("Pronto, aqui está! 🌏"), "Pronto, aqui está!", "remove emoji simples, mantém o texto");
  assert.equal(sandbox.__stripEmojiForSpeech("☀️ Vai fazer sol hoje"), "Vai fazer sol hoje", "remove emoji + variation selector (variation selector sozinho não deixa espaço duplo)");
  assert.equal(sandbox.__stripEmojiForSpeech("🎉🎂 Parabéns!!"), "Parabéns!!", "remove sequência de emojis colados");
  assert.equal(sandbox.__stripEmojiForSpeech("sem emoji nenhum"), "sem emoji nenhum", "texto sem emoji não muda");
  assert.equal(sandbox.__stripEmojiForSpeech(""), "", "vazio -> vazio");
  assert.equal(sandbox.__stripEmojiForSpeech(null), null, "não-string -> devolve como veio (nunca quebra o chamador)");
  // espaços duplos deixados pela remoção colapsam em um só
  assert.equal(sandbox.__stripEmojiForSpeech("oi 😀 tudo bem?"), "oi tudo bem?", "colapsa o espaço duplo deixado pelo emoji removido");
  console.log("stripEmojiForSpeech: OK");
}

console.log("_partea-legenda-emoji.test.mjs: todos os testes passaram");
