// PARTE F: lousa real — regex de pedido, validação de itens (coordenadas/pontos/texto),
// descarte de item inválido, montagem a partir dos argumentos crus da ferramenta.
import assert from "node:assert/strict";
import {
  LOUSA_PEDIDO_REGEX,
  LOUSA_FORMAS,
  validarItensLousa,
  construirLousaFromArgs,
} from "./index.js";

// ---------- LOUSA_PEDIDO_REGEX ----------
{
  const casam = ["explica como funciona juros compostos", "me explica isso", "desenha uma casa", "desenhe um gráfico", "mostra como calcular", "calcula 12 vezes 8", "resume isso num esquema", "faz um esquema simples"];
  casam.forEach((t) => assert.ok(LOUSA_PEDIDO_REGEX.test(t), `deveria casar: "${t}"`));
  const naoCasam = ["qual a minha agenda", "bom dia", "tudo bem com você?"];
  naoCasam.forEach((t) => assert.ok(!LOUSA_PEDIDO_REGEX.test(t), `não deveria casar: "${t}"`));
  console.log("LOUSA_PEDIDO_REGEX: OK");
}

// ---------- validarItensLousa: coordenadas, pontos, texto, itens inválidos descartados ----------
{
  // texto: coordenadas fora do range são fixadas (clamp), não descartadas
  assert.deepEqual(
    validarItensLousa([{ tipo: "texto", x: -50, y: 9999, texto: "12 × 8 = 96", tam: 40 }]),
    [{ tipo: "texto", x: 0, y: 225, texto: "12 × 8 = 96", tam: 40 }]
  );
  // texto vazio ou só caracteres de controle -> item descartado
  assert.equal(validarItensLousa([{ tipo: "texto", x: 10, y: 10, texto: "" }]), null);
  assert.equal(validarItensLousa([{ tipo: "texto", x: 10, y: 10, texto: "\x01\x02" }]), null);
  // texto maior que 60 caracteres é cortado, nunca descartado
  const textoLongo = "a".repeat(80);
  const r1 = validarItensLousa([{ tipo: "texto", x: 10, y: 10, texto: textoLongo }]);
  assert.equal(r1[0].texto.length, 60);
  // tam fora do range é fixado entre 10 e 60
  const r2 = validarItensLousa([{ tipo: "texto", x: 10, y: 10, texto: "x", tam: 999 }]);
  assert.equal(r2[0].tam, 60);
  console.log("validarItensLousa (texto): OK");
}
{
  // linha: pontos fora do range 0-300x0-225 são fixados; linha com 1 ponto só é descartada
  const r = validarItensLousa([{ tipo: "linha", pontos: [[-10, -10], [400, 400], [150, 112]] }]);
  assert.deepEqual(r, [{ tipo: "linha", pontos: [[0, 0], [300, 225], [150, 112]] }]);
  assert.equal(validarItensLousa([{ tipo: "linha", pontos: [[10, 10]] }]), null, "menos de 2 pontos -> descartado");
  assert.equal(validarItensLousa([{ tipo: "linha", pontos: [] }]), null);
  assert.equal(validarItensLousa([{ tipo: "linha" }]), null, "sem pontos -> descartado");
  // até 40 pontos por linha — além disso é cortado, nunca descarta a linha inteira
  const muitosPontos = Array.from({ length: 50 }, (_, i) => [i, i]);
  const r2 = validarItensLousa([{ tipo: "linha", pontos: muitosPontos }]);
  assert.equal(r2[0].pontos.length, 40);
  console.log("validarItensLousa (linha): OK");
}
{
  // forma: só os 5 nomes válidos; qualquer outro nome é descartado
  LOUSA_FORMAS.forEach((nome) => {
    assert.deepEqual(validarItensLousa([{ tipo: "forma", nome }]), [{ tipo: "forma", nome }]);
  });
  assert.equal(validarItensLousa([{ tipo: "forma", nome: "arvore" }]), null, "forma fora da lista -> descartada");
  assert.equal(validarItensLousa([{ tipo: "forma" }]), null);
  console.log("validarItensLousa (forma): OK");
}
{
  // tipo desconhecido é descartado; item sem objeto válido é descartado; até 8 itens no total
  assert.equal(validarItensLousa([{ tipo: "svg", d: "M0 0" }]), null);
  assert.equal(validarItensLousa([null, undefined, 5, "x"]), null);
  assert.equal(validarItensLousa([]), null);
  assert.equal(validarItensLousa(null), null);
  const nove = Array.from({ length: 9 }, () => ({ tipo: "forma", nome: "estrela" }));
  const r = validarItensLousa(nove);
  assert.equal(r.length, 8, "no máximo 8 itens, mesmo que o modelo mande mais");
  // mistura: item inválido no meio não derruba os outros itens válidos
  const misto = validarItensLousa([
    { tipo: "forma", nome: "casa" },
    { tipo: "forma", nome: "nao-existe" },
    { tipo: "texto", x: 10, y: 10, texto: "ok" },
  ]);
  assert.equal(misto.length, 2, "item inválido no meio é descartado, os outros sobrevivem");
  console.log("validarItensLousa (descarte seletivo + limites gerais): OK");
}

// ---------- construirLousaFromArgs ----------
{
  const r = construirLousaFromArgs({ titulo: "Juros compostos", itens: [{ tipo: "texto", x: 40, y: 110, texto: "12 × 8 = 96" }] });
  assert.equal(r.titulo, "Juros compostos");
  assert.equal(r.itens.length, 1);
  assert.equal(construirLousaFromArgs({ titulo: "X", itens: [] }), null, "sem itens válidos -> null, nunca abre lousa vazia");
  assert.equal(construirLousaFromArgs({ titulo: "X", itens: [{ tipo: "svg" }] }), null);
  assert.equal(construirLousaFromArgs({ itens: [{ tipo: "forma", nome: "estrela" }] }).titulo, "Lousa", "sem título -> usa padrão");
  const tituloLongo = construirLousaFromArgs({ titulo: "x".repeat(100), itens: [{ tipo: "forma", nome: "casa" }] });
  assert.equal(tituloLongo.titulo.length, 60);
  console.log("construirLousaFromArgs: OK");
}

console.log("_partef-lousa.test.mjs: todos os testes passaram");
