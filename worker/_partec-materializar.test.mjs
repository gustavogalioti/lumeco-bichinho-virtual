// PARTE C: materializar de verdade — testa a regex ampla de pedido (todas as flexões do
// verbo), o mapeamento forma -> materialize, e a rede de segurança que converte uma
// resposta só-emoji num materialize de verdade.
import assert from "node:assert/strict";
import {
  MATERIALIZAR_PEDIDO_REGEX,
  classificarOrigemMaterializar,
  construirMaterializeFromArgs,
  respostaSoEmoji,
  construirMaterializeDeRespostaEmoji,
  normalizeText,
} from "./index.js";

// ---------- MATERIALIZAR_PEDIDO_REGEX: todas as flexões pedidas pelo Gustavo ----------
{
  const devemCasar = [
    "materializa uma bola",
    "materialize um sol",
    "materializar o churrasco",
    "materializando uma cena",
    "desenha isso pra mim",
    "desenhe uma casa",
    "me mostra uma flor",
    "mostre o bolo",
    "imagina uma viagem",
    "imagine isso",
    "crie uma bola",
    "cria uma flor",
  ];
  for (const frase of devemCasar) {
    const n = normalizeText(frase);
    assert.ok(MATERIALIZAR_PEDIDO_REGEX.test(n), `"${frase}" deveria casar com o pedido de materializar`);
  }

  const naoDevemCasar = [
    "qual a minha agenda",
    "que horas são agora",
    "bom dia, como você está",
  ];
  for (const frase of naoDevemCasar) {
    const n = normalizeText(frase);
    assert.ok(!MATERIALIZAR_PEDIDO_REGEX.test(n), `"${frase}" NÃO deveria casar com o pedido de materializar`);
  }
  console.log("MATERIALIZAR_PEDIDO_REGEX: OK");
}

// ---------- classificarOrigemMaterializar com as novas flexões ----------
{
  for (const frase of ["materialize uma bola", "materializando um sol", "cria uma flor", "desenhe o churrasco"]) {
    assert.equal(classificarOrigemMaterializar(frase, {}), "pedido", `"${frase}" -> origem "pedido"`);
  }
  console.log("classificarOrigemMaterializar (flexões PARTE C): OK");
}

// ---------- construirMaterializeFromArgs: parâmetro forma tem prioridade sobre cena ----------
{
  const comForma = construirMaterializeFromArgs({ titulo: "Bola", motivo: "pediu uma bola", forma: "bola" }, "pedido");
  assert.deepEqual(comForma, { titulo: "Bola", kind: "forma", data: "bola", motivo: "pediu uma bola", origem: "pedido" });

  // "coracao" (sem acento, como vem do enum) é mantido como está — o mapeamento pra
  // 'coração' (chave acentuada da biblioteca do app) acontece no app, não aqui.
  const comCoracao = construirMaterializeFromArgs({ titulo: "Coração", motivo: "x", forma: "coracao" }, "pedido");
  assert.equal(comCoracao.kind, "forma");
  assert.equal(comCoracao.data, "coracao");

  // forma inválida -> ignora e cai pro fluxo de cena/svg normal
  const formaInvalida = construirMaterializeFromArgs(
    { titulo: "X", motivo: "y", forma: "dinossauro", cena: [{ e: "🦕", x: 0, y: 0, s: 100 }] },
    "pedido"
  );
  assert.equal(formaInvalida.kind, "cena", "forma fora do enum -> ignora e usa a cena");

  // forma tem prioridade mesmo se cena também vier preenchida
  const formaComCena = construirMaterializeFromArgs(
    { titulo: "Sol", motivo: "y", forma: "sol", cena: [{ e: "☀️", x: 0, y: 0, s: 100 }] },
    "pedido"
  );
  assert.equal(formaComCena.kind, "forma");
  assert.equal(formaComCena.data, "sol");

  console.log("construirMaterializeFromArgs (forma): OK");
}

// ---------- respostaSoEmoji ----------
{
  assert.equal(respostaSoEmoji("🌏"), true, "só um emoji -> true");
  assert.equal(respostaSoEmoji("☀️"), true, "emoji com variation selector -> true");
  assert.equal(respostaSoEmoji("🎉🎂"), true, "dois emojis -> true");
  assert.equal(respostaSoEmoji("🌏!"), true, "emoji + pontuação curta -> true");
  assert.equal(respostaSoEmoji("Pronto, aqui está! 🌏"), false, "emoji + fala real -> false");
  assert.equal(respostaSoEmoji(""), false, "vazio -> false");
  assert.equal(respostaSoEmoji("oi"), false, "texto sem emoji -> false");
  console.log("respostaSoEmoji: OK");
}

// ---------- construirMaterializeDeRespostaEmoji ----------
{
  const sol = construirMaterializeDeRespostaEmoji("☀️");
  assert.equal(sol.kind, "forma");
  assert.equal(sol.data, "sol");
  assert.equal(sol.origem, "pedido");

  const coracao = construirMaterializeDeRespostaEmoji("❤️");
  assert.equal(coracao.kind, "forma");
  assert.equal(coracao.data, "coracao");

  // emoji sem forma correspondente -> cena com ele centralizado, s:190
  const praia = construirMaterializeDeRespostaEmoji("🏖️");
  assert.equal(praia.kind, "cena");
  assert.equal(praia.data.length, 1);
  assert.equal(praia.data[0].e, "🏖️");
  assert.equal(praia.data[0].s, 190);
  assert.equal(praia.data[0].x, 0);
  assert.equal(praia.data[0].y, 0);

  console.log("construirMaterializeDeRespostaEmoji: OK");
}

console.log("_partec-materializar.test.mjs: todos os testes passaram");
