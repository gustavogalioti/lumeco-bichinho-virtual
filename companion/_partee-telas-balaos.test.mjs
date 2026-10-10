// Testa as funções puras (truncamento do balão) e a lógica de visibilidade das telas
// (responsivo + fallback de fonte vazia), extraídas DIRETO do companion/index.html —
// não uma reimplementação — num sandbox node:vm, mesmo padrão de
// companion/_voz-eco-apelidos.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function slice(inicioMarcador, fimMarcador) {
  const inicio = html.indexOf(inicioMarcador);
  assert.ok(inicio !== -1, `achou o início "${inicioMarcador.slice(0, 50)}..."`);
  const fimIdx = html.indexOf(fimMarcador, inicio);
  assert.ok(fimIdx !== -1, `achou o fim "${fimMarcador.slice(0, 50)}..."`);
  return html.slice(inicio, fimIdx + fimMarcador.length);
}

const trechoLayout = slice(
  "function narrowScreen(){ return innerWidth < 760; }",
  "if(alvo !== ajustarFaceScaleAnterior){ ajustarFaceScaleAnterior = alvo; faceScale = alvo; }\n}"
);
const trechoTelas = slice(
  "// ---------- Telas: dados reais (agenda/tarefas/contas), sem IA ----------",
  "  ajustarFaceScale();\n}"
);
const trechoBolha = slice(
  "function truncarBolha(text, max){",
  "  return s.slice(0, limite-1).trim() + '…';\n}"
);

// Fake DOM mínimo: só o suficiente pra telaEl()/aplicarVisibilidadeTelas() rodarem
// sem um browser de verdade — cada "elemento" é um objeto plano com style/classList.
function fakeEl() {
  return { style: {}, innerHTML: "", classList: { list: new Set(), toggle(c, on) { on ? this.list.add(c) : this.list.delete(c); }, contains(c) { return this.list.has(c); } } };
}

function makeSandbox({ innerWidth, telasOn, dadosTelas }) {
  const elements = { tAgenda: fakeEl(), tTarefas: fakeEl(), tTv: fakeEl(), tMercado: fakeEl() };
  const OV = { classList: { list: new Set(), toggle(c, on) { on ? this.list.add(c) : this.list.delete(c); }, contains(c) { return this.list.has(c); } } };
  const sandbox = {
    innerWidth, innerHeight: 800,
    CLASSIC_FACE: false,
    opts: { telas: telasOn !== false, sinapses: true },
    faceScale: 1,
    OV,
    document: { getElementById: (id) => elements[id] || null },
    console,
  };
  vm.createContext(sandbox);
  // trechoTelas já declara "let dadosTelas = {...padrão do lab...}" — roda a extração
  // primeiro, e só DEPOIS sobrescreve a variável (reatribuição, não um novo "let", senão
  // a declaração do próprio trecho criaria um binding novo que ignoraria o que setamos
  // no objeto do sandbox antes de createContext).
  vm.runInContext(trechoLayout + "\n" + trechoTelas + "\n" + trechoBolha + `
    this.__truncarBolha = truncarBolha;
    this.__telaTemDados = telaTemDados;
    this.__aplicarVisibilidadeTelas = aplicarVisibilidadeTelas;
    this.__ajustarFaceScale = ajustarFaceScale;
    this.__getFaceScale = () => faceScale;
    this.__setDadosTelas = (d) => { dadosTelas = d; };
  `, sandbox);
  if (dadosTelas) sandbox.__setDadosTelas(dadosTelas);
  sandbox.__elements = elements;
  sandbox.__OV = OV;
  return sandbox;
}

// ---------- truncarBolha ----------
{
  const s = makeSandbox({ innerWidth: 1200 });
  assert.equal(s.__truncarBolha("oi"), "oi", "texto curto passa direto");
  assert.equal(s.__truncarBolha("", 220), "", "vazio -> vazio");
  assert.equal(s.__truncarBolha(null), "", "null -> nunca quebra");
  const longo = "palavra ".repeat(40);
  const cortado = s.__truncarBolha(longo, 220);
  assert.equal(cortado.length, 220, "nunca passa do limite");
  assert.ok(cortado.endsWith("…"), "texto longo do balão é cortado com “…”");
  const exato = "x".repeat(220);
  assert.equal(s.__truncarBolha(exato, 220), exato, "no limite exato, não corta");
  console.log("truncarBolha: OK");
}

// ---------- telaTemDados: fallback de fonte vazia (notícias/mercado) ----------
{
  const semFonte = makeSandbox({ innerWidth: 1200, dadosTelas: { noticias: [], mercado: [] } });
  assert.equal(semFonte.__telaTemDados("tv"), false, "notícias sem fonte -> sem dados");
  assert.equal(semFonte.__telaTemDados("mercado"), false, "mercado sem fonte -> sem dados");
  assert.equal(semFonte.__telaTemDados("agenda"), true, "agenda sempre tem dados reais do painel");
  assert.equal(semFonte.__telaTemDados("tarefas"), true, "tarefas sempre tem dados reais do painel");

  const comFonte = makeSandbox({ innerWidth: 1200, dadosTelas: { noticias: [{ categoria: "X", titulo: "Y" }], mercado: [{ nome: "Dólar", valor: "R$5" }] } });
  assert.equal(comFonte.__telaTemDados("tv"), true);
  assert.equal(comFonte.__telaTemDados("mercado"), true);
  console.log("telaTemDados (fallback de fonte vazia): OK");
}

// ---------- ajustarFaceScale: 0.8 largo / 0.76 compacto / 0.9 estreito / 1 sem telas ----------
{
  assert.equal((() => { const s = makeSandbox({ innerWidth: 1600 }); s.__ajustarFaceScale(); return s.__getFaceScale(); })(), .8, "largo (>=880) com telas -> 0.8");
  assert.equal((() => { const s = makeSandbox({ innerWidth: 800 }); s.__ajustarFaceScale(); return s.__getFaceScale(); })(), .76, "compacto (760-879) com telas -> 0.76");
  assert.equal((() => { const s = makeSandbox({ innerWidth: 500 }); s.__ajustarFaceScale(); return s.__getFaceScale(); })(), .9, "estreito (<760) com telas -> 0.9");
  assert.equal((() => { const s = makeSandbox({ innerWidth: 1600, telasOn: false }); s.__ajustarFaceScale(); return s.__getFaceScale(); })(), 1, "telas desligadas -> 1 (rosto cheio)");
  console.log("ajustarFaceScale: OK");
}

// ---------- aplicarVisibilidadeTelas: responsivo + nunca mostra tela vazia ----------
{
  // largo (>=880): todas as telas com dados aparecem
  const largo = makeSandbox({ innerWidth: 1600, dadosTelas: { noticias: [{ categoria: "X", titulo: "Y" }], mercado: [{ nome: "Dólar", valor: "R$5" }] } });
  largo.__aplicarVisibilidadeTelas();
  assert.equal(largo.__elements.tAgenda.style.display, "", "agenda visível em tela larga");
  assert.equal(largo.__elements.tTarefas.style.display, "", "tarefas visível em tela larga");
  assert.equal(largo.__elements.tTv.style.display, "", "notícias visível quando tem fonte");
  assert.equal(largo.__elements.tMercado.style.display, "", "mercado visível quando tem fonte");

  // compacto (760-879): telas de baixo (tarefas/mercado) somem, mesmo com dados
  const compacto = makeSandbox({ innerWidth: 800, dadosTelas: { noticias: [{ categoria: "X", titulo: "Y" }], mercado: [{ nome: "Dólar", valor: "R$5" }] } });
  compacto.__aplicarVisibilidadeTelas();
  assert.equal(compacto.__elements.tAgenda.style.display, "", "agenda continua visível no compacto");
  assert.equal(compacto.__elements.tTarefas.style.display, "none", "tarefas (linha de baixo) some no compacto (<880px)");
  assert.equal(compacto.__elements.tMercado.style.display, "none", "mercado (linha de baixo) some no compacto (<880px)");

  // estreito (<760) COM notícias configuradas: agenda + notícias (como no lab)
  const estreitoComNoticias = makeSandbox({ innerWidth: 500, dadosTelas: { noticias: [{ categoria: "X", titulo: "Y" }], mercado: [] } });
  estreitoComNoticias.__aplicarVisibilidadeTelas();
  assert.equal(estreitoComNoticias.__elements.tAgenda.style.display, "", "estreito com notícias: agenda visível");
  assert.equal(estreitoComNoticias.__elements.tTv.style.display, "", "estreito com notícias: notícias visível");
  assert.equal(estreitoComNoticias.__elements.tTarefas.style.display, "none", "estreito com notícias: tarefas escondida (só 2 telas)");

  // estreito (<760) SEM fonte de notícias: cai pro par agenda+tarefas (as 2 com dados)
  const estreitoSemNoticias = makeSandbox({ innerWidth: 500, dadosTelas: { noticias: [], mercado: [] } });
  estreitoSemNoticias.__aplicarVisibilidadeTelas();
  assert.equal(estreitoSemNoticias.__elements.tAgenda.style.display, "", "estreito sem notícias: agenda visível");
  assert.equal(estreitoSemNoticias.__elements.tTarefas.style.display, "", "estreito sem notícias: tarefas assume o 2º lugar (tem dados reais)");
  assert.equal(estreitoSemNoticias.__elements.tTv.style.display, "none", "estreito sem notícias: notícias (sem fonte) escondida");

  // telas desligadas: classe sem-telas aplicada (CSS some com tudo)
  const desligado = makeSandbox({ innerWidth: 1600, telasOn: false });
  desligado.__aplicarVisibilidadeTelas();
  assert.equal(desligado.__OV.classList.contains("sem-telas"), true, "telas desligadas -> overlay recebe a classe sem-telas");

  console.log("aplicarVisibilidadeTelas (responsivo + fallback de fonte vazia): OK");
}

console.log("_partee-telas-balaos.test.mjs: todos os testes passaram");
