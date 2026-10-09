import assert from "node:assert/strict";
import {
  COMPANION_EMOTIONS,
  companionPrompt,
  validarCenaMaterializar,
  validarSvgMaterializar,
  classificarOrigemMaterializar,
  materializarEspontaneoBloqueado,
  construirMaterializeFromArgs,
} from "./index.js";

// ---------- vocabulário de emotion ----------
{
  assert.equal(COMPANION_EMOTIONS.length, 11, "11 expressões escolhíveis pelo modelo");
  for (const e of ["neutro", "feliz", "pensando", "surpreso", "focado", "bravo", "muito_bravo", "confirmado", "curioso", "piscadinha", "empatico"]) {
    assert.ok(COMPANION_EMOTIONS.includes(e), `vocabulário inclui "${e}"`);
  }
  for (const estadoSistema of ["dormindo", "acordando", "alerta"]) {
    assert.ok(!COMPANION_EMOTIONS.includes(estadoSistema), `"${estadoSistema}" é estado de sistema, nunca escolhível pelo modelo`);
  }
  console.log("COMPANION_EMOTIONS: OK");
}

// ---------- companionPrompt: formato JSON reflete o vocabulário ----------
{
  const prompt = companionPrompt({});
  for (const e of COMPANION_EMOTIONS) {
    assert.ok(prompt.includes(`"${e}"`) || prompt.includes(`${e}|`) || prompt.includes(`|${e}"`), `prompt menciona "${e}" nas opções`);
  }
  assert.ok(prompt.includes('"emotion":"'), "formato JSON pedido no prompt");
  assert.ok(!prompt.includes("dormindo|") && !/"emotion":"[^"]*\bdormindo\b/.test(prompt), "dormindo nunca aparece como opção escolhível");
  console.log("companionPrompt (formato emotion): OK");
}

// ---------- companionPrompt: respeita aparencia.expressoesAtivas ----------
{
  const promptLimitado = companionPrompt({ aparencia: { expressoesAtivas: ["neutro", "feliz", "curioso"] } });
  const m = promptLimitado.match(/"emotion":"([^"]+)"/);
  assert.ok(m, "formato encontrado");
  const opcoes = m[1].split("|");
  assert.deepEqual(opcoes.sort(), ["curioso", "feliz", "neutro"].sort(), "só as expressões ativas aparecem como opção");

  const promptCompleto = companionPrompt({});
  const mCompleto = promptCompleto.match(/"emotion":"([^"]+)"/);
  assert.equal(mCompleto[1].split("|").length, 11, "sem expressoesAtivas, todas as 11 valem");
  console.log("companionPrompt (expressoesAtivas): OK");
}

// ---------- companionPrompt: menciona materializar e reflete o gate espontâneo ----------
{
  const promptLiberado = companionPrompt({ podeMaterializarEspontaneo: true });
  assert.ok(/materializar por conta própria|materializar espontaneamente|sem pedido/i.test(promptLiberado), "prompt liberado menciona materialização espontânea");

  const promptBloqueado = companionPrompt({ podeMaterializarEspontaneo: false });
  assert.ok(/não é um bom momento pra materializar por conta própria/i.test(promptBloqueado), "prompt bloqueado avisa que não é hora de materializar sozinho");
  console.log("companionPrompt (materializar espontâneo): OK");
}

// ---------- validarCenaMaterializar ----------
{
  assert.equal(validarCenaMaterializar(null), null, "null -> null");
  assert.equal(validarCenaMaterializar([]), null, "vazio -> null");
  assert.equal(validarCenaMaterializar("não é array"), null, "não-array -> null");

  // clamp de x/y/s
  const clamped = validarCenaMaterializar([{ e: "🏖️", x: 999, y: -999, s: 9999 }]);
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0].x, 150, "x clampado em 150");
  assert.equal(clamped[0].y, -150, "y clampado em -150");
  assert.equal(clamped[0].s, 220, "s clampado em 220 (máx)");

  const clampedMin = validarCenaMaterializar([{ e: "☀️", x: 0, y: 0, s: 1 }]);
  assert.equal(clampedMin[0].s, 40, "s clampado em 40 (mín)");

  // corta em 6 itens
  const oito = Array.from({ length: 8 }, (_, i) => ({ e: "🎈", x: i, y: i, s: 100 }));
  const cortado = validarCenaMaterializar(oito);
  assert.equal(cortado.length, 6, "corta cena em no máximo 6 itens");

  // item sem emoji é descartado, mas os outros sobrevivem
  const comVazio = validarCenaMaterializar([{ e: "", x: 0, y: 0, s: 100 }, { e: "🏆", x: 0, y: 0, s: 100 }]);
  assert.equal(comVazio.length, 1, "item sem emoji é descartado");
  assert.equal(comVazio[0].e, "🏆");

  // todos inválidos -> null
  assert.equal(validarCenaMaterializar([{ e: "" }, { e: "  " }]), null, "cena sem nenhum item válido -> null");

  // e cortado em 12 caracteres
  const longo = validarCenaMaterializar([{ e: "a".repeat(30), x: 0, y: 0, s: 100 }]);
  assert.equal(longo[0].e.length, 12, "e cortado em 12 caracteres");

  console.log("validarCenaMaterializar: OK");
}

// ---------- validarSvgMaterializar ----------
{
  assert.equal(validarSvgMaterializar(""), null, "svg vazio -> null");
  assert.equal(validarSvgMaterializar(null), null, "não-string -> null");

  assert.equal(validarSvgMaterializar('<svg><script>alert(1)</script></svg>'), null, "rejeita <script>");
  assert.equal(validarSvgMaterializar('<svg><foreignObject><div/></foreignObject></svg>'), null, "rejeita <foreignObject>");
  assert.equal(validarSvgMaterializar('<svg onload="alert(1)"><circle/></svg>'), null, "rejeita atributo on*");
  assert.equal(validarSvgMaterializar('<svg><image href="https://evil.com/x.png"/></svg>'), null, "rejeita <image> com href externo");
  assert.equal(validarSvgMaterializar('<svg><image href="//evil.com/x.png"/></svg>'), null, "rejeita <image> protocol-relative");
  assert.equal(validarSvgMaterializar('<svg><rect fill="url(http://evil.com/track.png)"/></svg>'), null, "rejeita url(http...)");
  assert.equal(validarSvgMaterializar('<svg><rect style="background:url(\'https://evil.com/x\')"/></svg>'), null, "rejeita url(https...) em style");

  const grandeDemais = `<svg>${"<!-- " + "x".repeat(6100) + " -->"}</svg>`;
  assert.equal(validarSvgMaterializar(grandeDemais), null, "rejeita SVG acima de 6KB");

  const limpo = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="lime"/></svg>';
  assert.equal(validarSvgMaterializar(limpo), limpo, "aceita SVG limpo e simples");

  const comUrlLocal = '<svg><rect fill="url(#gradient)"/></svg>';
  assert.equal(validarSvgMaterializar(comUrlLocal), comUrlLocal, "url(#local) (referência interna) não é bloqueado");

  console.log("validarSvgMaterializar: OK");
}

// ---------- classificarOrigemMaterializar ----------
{
  assert.equal(classificarOrigemMaterializar("materializa uma praia pra mim", {}), "pedido", "pedido explícito com 'materializa'");
  assert.equal(classificarOrigemMaterializar("desenha isso", {}), "pedido", "pedido explícito com 'desenha'");
  assert.equal(classificarOrigemMaterializar("me mostra algo legal", {}), "pedido", "'mostra' conta como pedido");
  assert.equal(classificarOrigemMaterializar("materializa o que resume nossa conversa", {}), "pedido", "'materializa' vence mesmo com 'resume' na frase");
  assert.equal(classificarOrigemMaterializar("resume o que a gente tá conversando", {}), "conversa", "'resume' sozinho -> resumo visual da conversa");
  assert.equal(classificarOrigemMaterializar("hoje foi um dia incrível", { podeMaterializarEspontaneo: true }), "espontaneo", "sem gatilho + gate liberado -> espontâneo");
  assert.equal(classificarOrigemMaterializar("hoje foi um dia incrível", { podeMaterializarEspontaneo: false }), "pedido", "sem gatilho + gate fechado -> cai pra pedido (nunca espontâneo sem liberação)");
  console.log("classificarOrigemMaterializar: OK");
}

// ---------- materializarEspontaneoBloqueado (segunda camada de defesa) ----------
{
  assert.equal(materializarEspontaneoBloqueado("pedido", "materializa uma praia", { podeMaterializarEspontaneo: false }), false, "pedido explícito nunca é bloqueado, mesmo com o gate fechado");
  assert.equal(materializarEspontaneoBloqueado("conversa", "resume a conversa", { podeMaterializarEspontaneo: false }), false, "resumo pedido nunca é bloqueado");
  assert.equal(materializarEspontaneoBloqueado("espontaneo", "que viagem incrível", { podeMaterializarEspontaneo: true }), false, "espontâneo liberado e sem contexto de painel -> passa");
  assert.equal(materializarEspontaneoBloqueado("espontaneo", "que viagem incrível", { podeMaterializarEspontaneo: false }), true, "espontâneo com gate fechado -> bloqueado");
  assert.equal(materializarEspontaneoBloqueado("espontaneo", "qual minha agenda de hoje", { podeMaterializarEspontaneo: true }), true, "espontâneo liberado mas em contexto de agenda -> bloqueado");
  assert.equal(materializarEspontaneoBloqueado("espontaneo", "preciso pagar essa conta", { podeMaterializarEspontaneo: true }), true, "espontâneo liberado mas em contexto de contas -> bloqueado");
  assert.equal(materializarEspontaneoBloqueado("espontaneo", "anota isso no diário", { podeMaterializarEspontaneo: true }), true, "espontâneo liberado mas em contexto de diário -> bloqueado");
  console.log("materializarEspontaneoBloqueado: OK");
}

// ---------- construirMaterializeFromArgs (mapeamento ferramenta -> campo materialize) ----------
{
  const comCena = construirMaterializeFromArgs(
    { titulo: "Praia", motivo: "ela contou que foi pro litoral", cena: [{ e: "🏖️", x: 0, y: 0, s: 200 }] },
    "pedido"
  );
  assert.deepEqual(comCena, {
    titulo: "Praia", kind: "cena", data: [{ e: "🏖️", x: 0, y: 0, s: 200 }], motivo: "ela contou que foi pro litoral", origem: "pedido",
  }, "mapeia cena corretamente, com kind:'cena' e origem repassada");

  const comSvg = construirMaterializeFromArgs(
    { titulo: "Estrela", motivo: "pediu um desenho", svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' },
    "conversa"
  );
  assert.equal(comSvg.kind, "svg", "sem cena válida mas com svg válido -> kind:'svg'");
  assert.equal(comSvg.origem, "conversa");

  const semNada = construirMaterializeFromArgs({ titulo: "Nada", motivo: "teste" }, "pedido");
  assert.equal(semNada, null, "sem cena nem svg válidos -> null");

  const cenaInvalidaComSvgValido = construirMaterializeFromArgs(
    { titulo: "X", motivo: "y", cena: [{ e: "" }], svg: '<svg><rect width="5" height="5"/></svg>' },
    "espontaneo"
  );
  assert.equal(cenaInvalidaComSvgValido.kind, "svg", "cena inválida mas svg válido -> cai pro svg");

  const tituloECurto = construirMaterializeFromArgs({ titulo: "", motivo: "", cena: [{ e: "✨", x: 0, y: 0, s: 100 }] }, "pedido");
  assert.equal(tituloECurto.titulo, "criação", "sem título -> usa 'criação' como padrão");

  console.log("construirMaterializeFromArgs: OK");
}

console.log("_face2-materializar.test.mjs: todos os testes passaram");
