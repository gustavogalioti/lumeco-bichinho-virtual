import assert from "node:assert/strict";
import {
  normalizarPerfil,
  truncarPerfilParaLimite,
  normalizarPerfilVetos,
  vetosAtivos,
  textoEquivalenteAVeto,
  itemVetado,
  adicionarVeto,
  filtrarItensVetados,
  preservarManuaisNoPerfil,
} from "./index.js";

// ---------- normalizarPerfilVetos: saneamento de entrada malformada ----------
{
  assert.deepEqual(normalizarPerfilVetos(null), []);
  assert.deepEqual(normalizarPerfilVetos("string qualquer"), []);
  const vetos = normalizarPerfilVetos([
    { texto: "Vai se mudar para o Rio", data: "2026-01-01" },
    { texto: "" }, // descartado: texto vazio
    { semTexto: true }, // descartado: sem campo texto
    null,
    "string solta", // descartado: não é objeto
    { texto: "Tem um gato novo", data: 12345 }, // data inválida -> null, mas item sobrevive
  ]);
  assert.equal(vetos.length, 2);
  assert.equal(vetos[0].texto, "vai se mudar para o rio", "normaliza: minúsculas, sem acento, sem pontuação");
  assert.equal(vetos[1].data, null, "data que não é string vira null, nunca quebra");

  const muitos = Array.from({ length: 150 }, (_, i) => ({ texto: `veto ${i}`, data: "2026-01-01" }));
  assert.equal(normalizarPerfilVetos(muitos).length, 100, "corta em 100, nunca cresce sem limite");
}
console.log("normalizarPerfilVetos: OK");

// ---------- vetosAtivos: expiração em 180 dias ----------
{
  const hoje = "2026-10-20";
  const vetos = [
    { texto: "veto recente", data: "2026-10-01" }, // 19 dias — ativo
    { texto: "veto no limite", data: "2026-04-23" }, // ~180 dias — ainda ativo (<=)
    { texto: "veto expirado", data: "2026-01-01" }, // bem mais de 180 dias — expirado
    { texto: "veto sem data", data: null }, // nunca expira por segurança
  ];
  const ativos = vetosAtivos(vetos, hoje);
  const textos = ativos.map((v) => v.texto);
  assert.ok(textos.includes("veto recente"));
  assert.ok(textos.includes("veto no limite"));
  assert.ok(!textos.includes("veto expirado"), "veto com mais de 180 dias não conta mais");
  assert.ok(textos.includes("veto sem data"), "sem data -> nunca expira (por segurança)");
}
console.log("vetosAtivos (expiração de 180 dias): OK");

// ---------- textoEquivalenteAVeto / itemVetado: igual, contenção, variação de texto ----------
{
  assert.equal(textoEquivalenteAVeto("vai se mudar para o rio", "vai se mudar para o rio"), true, "idêntico");
  assert.equal(textoEquivalenteAVeto("ele disse que vai se mudar para o rio em dezembro", "vai se mudar para o rio"), true, "contenção (frase maior contém o veto)");
  assert.equal(textoEquivalenteAVeto("vai se mudar para o rio em dezembro", "vai se mudar para o rio"), true, "variação de texto (bastante sobreposição de palavras)");
  assert.equal(textoEquivalenteAVeto("gosta de futebol", "vai se mudar para o rio"), false, "textos diferentes não batem");
  assert.equal(textoEquivalenteAVeto("", "vai se mudar para o rio"), false, "texto vazio nunca bate");

  const ativosNorm = normalizarPerfilVetos([{ texto: "Vai se mudar para o Rio", data: "2026-10-01" }]);
  assert.equal(itemVetado("Ele disse que vai se mudar para o Rio em dezembro", ativosNorm), true, "itemVetado usa a mesma comparação, com texto não-normalizado de entrada");
  assert.equal(itemVetado("Gosta de futebol", ativosNorm), false);
}
console.log("textoEquivalenteAVeto / itemVetado: OK");

// ---------- adicionarVeto: dedupe, mais recente primeiro, capado em 100 ----------
{
  let vetos = [];
  vetos = adicionarVeto(vetos, "Vai se mudar para o Rio", "2026-10-01");
  assert.equal(vetos.length, 1);
  vetos = adicionarVeto(vetos, "Tem um gato novo", "2026-10-05");
  assert.equal(vetos.length, 2);
  assert.equal(vetos[0].texto, "tem um gato novo", "o mais recente fica primeiro");

  // dedupe: o mesmo texto (normalizado) não duplica, só atualiza a posição/data
  vetos = adicionarVeto(vetos, "vai se mudar para o rio", "2026-10-10");
  assert.equal(vetos.length, 2, "não duplica o mesmo veto");
  assert.equal(vetos[0].texto, "vai se mudar para o rio");
  assert.equal(vetos[0].data, "2026-10-10", "atualiza a data pra mais recente");

  let cheio = [];
  for (let i = 0; i < 105; i++) cheio = adicionarVeto(cheio, `veto numero ${i}`, "2026-10-01");
  assert.equal(cheio.length, 100, "nunca passa de 100 vetos");
}
console.log("adicionarVeto (dedupe + limite de 100): OK");

// ---------- filtrarItensVetados: bloqueia reinserção, inclusive com variação ----------
{
  const perfil = normalizarPerfil({
    planos: [
      { texto: "Vai se mudar para o Rio em dezembro", data: "2026-10-20", fonte: "conversa" }, // deveria ser bloqueado (variação do veto)
      { texto: "Quer aprender a tocar violão", data: "2026-10-20", fonte: "conversa" }, // deveria passar
    ],
    pessoal: [
      { texto: "Vai se mudar para o Rio", data: "2026-10-20", fonte: "manual" }, // manual é ISENTO de veto
    ],
  });
  const vetos = normalizarPerfilVetos([{ texto: "Vai se mudar para o Rio", data: "2026-10-01" }]);
  const filtrado = filtrarItensVetados(perfil, vetos);
  assert.equal(filtrado.planos.length, 1, "bloqueia o item vetado (mesmo com variação de texto)");
  assert.equal(filtrado.planos[0].texto, "Quer aprender a tocar violão");
  assert.equal(filtrado.pessoal.length, 1, "item manual nunca é vetado, mesmo batendo com o texto do veto");

  // sem vetos ativos -> nada é filtrado
  assert.deepEqual(filtrarItensVetados(perfil, []), perfil);
}
console.log("filtrarItensVetados (bloqueia reinserção, inclusive com variação; manual isento): OK");

// ---------- preservarManuaisNoPerfil: manual nunca é alterado/mesclado/removido pela IA ----------
{
  const perfilAnterior = normalizarPerfil({
    profissional: [
      { texto: "Trabalha na empresa X", data: "2026-09-01", fonte: "manual" },
      { texto: "Projeto antigo, já encerrado", data: "2026-08-01", fonte: "conversa" },
    ],
  });
  // a IA devolveu um perfil novo SEM o item manual (ela "esqueceu" ou tentou reescrever)
  // e, por engano/alucinação, marcou um item novo como "fonte:manual" — nunca deveria
  // confiar nisso vindo da IA.
  const perfilDaIA = normalizarPerfil({
    profissional: [
      { texto: "Projeto novo começou essa semana", data: "2026-10-20", fonte: "conversa" },
      { texto: "Item que a IA alucinou como manual", data: "2026-10-20", fonte: "manual" },
    ],
  });
  const resultado = preservarManuaisNoPerfil(perfilAnterior, perfilDaIA);
  const textos = resultado.profissional.map((i) => i.texto);
  assert.ok(textos.includes("Trabalha na empresa X"), "o item manual real volta, mesmo que a IA tenha \"esquecido\" dele");
  assert.ok(textos.includes("Projeto novo começou essa semana"), "itens novos legítimos da IA continuam passando");
  assert.ok(!textos.includes("Item que a IA alucinou como manual"), "nunca confia num \"fonte:manual\" que veio da própria IA");
  assert.equal(resultado.profissional.find((i) => i.texto === "Trabalha na empresa X").fonte, "manual", "o item manual mantém fonte:manual");
}
console.log("preservarManuaisNoPerfil (nunca alterado/mesclado/removido pela IA): OK");

// ---------- truncarPerfilParaLimite: manual é o ÚLTIMO a ser cortado ----------
{
  const manual = { texto: "Fato manual importante, protegido do corte por tamanho sempre que possível de verdade", data: "2026-01-01", fonte: "manual" };
  const naoManuais = Array.from({ length: 20 }, (_, i) => ({
    texto: `Fato não-manual número ${i}, com texto razoavelmente longo pra pesar bastante no JSON serializado`,
    data: `2026-02-${String(i + 1).padStart(2, "0")}`,
    fonte: "conversa",
  }));
  const perfilGrande = { pessoal: [manual, ...naoManuais], profissional: [], emFoco: [], planos: [], preocupacoes: [], humorRecente: "", atualizadoEm: null };

  const limitado = truncarPerfilParaLimite(perfilGrande, 1500);
  assert.ok(JSON.stringify(limitado).length <= 1500, "respeita o limite");
  assert.ok(limitado.pessoal.some((i) => i.fonte === "manual"), "o manual sobrevive ao corte enquanto houver não-manual pra cortar antes");
  assert.ok(limitado.pessoal.length < perfilGrande.pessoal.length, "cortou itens pra caber");

  // só com manuais, nenhum não-manual sobrando -> o corte, como último recurso, pode
  // sim remover manual (senão o limite de 1.500 se tornaria impossível de garantir)
  const soManuais = {
    pessoal: Array.from({ length: 20 }, (_, i) => ({ texto: `Manual número ${i}, com um texto longo o bastante pra pesar de verdade no JSON serializado`, data: `2026-01-${String(i + 1).padStart(2, "0")}`, fonte: "manual" })),
    profissional: [], emFoco: [], planos: [], preocupacoes: [], humorRecente: "", atualizadoEm: null,
  };
  const limitadoSoManuais = truncarPerfilParaLimite(soManuais, 1500);
  assert.ok(JSON.stringify(limitadoSoManuais).length <= 1500, "o limite de 1.500 é respeitado mesmo só com manuais (último recurso)");
}
console.log("truncarPerfilParaLimite (manual é o último a ser cortado): OK");

console.log("_parteh-perfil-manual-veto.test.mjs: todos os testes passaram");
