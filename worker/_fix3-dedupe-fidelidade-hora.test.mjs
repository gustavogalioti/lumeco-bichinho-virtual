// FIX-3: duplicatas (PARTE A, defesa em profundidade do lado do Worker), briefing
// completo e fiel (PARTE B) e consciência de hora em todo texto fixo (PARTE C).
import assert from "node:assert/strict";
import {
  selecionarPendenciasVencidas,
  parseAgendaTexto,
  montarBriefingDeterministico,
  falaEhFielAoDeterministico,
  tituloBriefingPorPeriodo,
  periodoDoDia,
  construirTelasTarefas,
  construirTelasContas,
} from "./index.js";

// ═══════════════════════════ PARTE A: dedupe (defesa em profundidade) ═══════════════════

// ---------- selecionarPendenciasVencidas: dedupe por texto normalizado/contenção ----------
{
  const items = [
    { id: "1", kind: "pendencia", text: "Retornar pro Sr. Oscar", status: "ativo", followUpAt: "2026-01-10" },
    { id: "2", kind: "pendencia", text: "retornar pro sr oscar", status: "ativo", followUpAt: "2026-01-05" }, // igual normalizado, prazo mais antigo
    { id: "3", kind: "pendencia", text: "ligar pro Pedro", status: "ativo", followUpAt: "2026-01-08" },
    { id: "4", kind: "pendencia", text: "ligar pro Pedro na sexta de manhã", status: "ativo", followUpAt: "2026-01-09" }, // contém o texto do id 3
  ];
  const r = selecionarPendenciasVencidas(items, "2026-01-10");
  assert.equal(r.length, 2, "duas pendências duplicadas viram uma só (defesa em profundidade)");
  const oscar = r.find((p) => normalizeTexto(p.text).includes("oscar"));
  assert.equal(oscar.id, "2", "mantém a de prazo (followUpAt) mais antigo");
  const pedro = r.find((p) => normalizeTexto(p.text).includes("pedro"));
  assert.equal(pedro.id, "3", "contenção: a mais curta (prazo mais antigo) prevalece sobre a que a contém");
}
console.log("selecionarPendenciasVencidas: dedupe por texto/contenção, mantém prazo mais antigo: OK");
function normalizeTexto(s) { return (s || "").toLowerCase(); }

// ---------- parseAgendaTexto: dedupe por hora+título normalizado ----------
{
  const texto = "10:00 Reunião Jr. MH + Zezé; 10:00 REUNIAO JR. MH + ZEZE; 15:00 CFP";
  const r = parseAgendaTexto(texto);
  assert.equal(r.length, 2, "duas entradas de agenda com mesma hora+título (maiúsculas diferentes) viram uma só");
  assert.deepEqual(r.map((e) => e.hora), ["10:00", "15:00"]);
}
console.log("parseAgendaTexto: dedupe por hora+título normalizado: OK");

// ---------- montarBriefingDeterministico: duplicata de TAREFA na entrada ----------
{
  const r = montarBriefingDeterministico({
    climaTexto: "", agendaTexto: "", contasTextos: [], pendenciasTextos: [], filaItens: [],
    tarefasItens: [
      { id: "1", titulo: "Revisar proposta", status: "now" },
      { id: "2", titulo: "revisar proposta", status: "now" }, // mesmo título, id diferente
      { id: "3", titulo: "Ligar pro fornecedor", status: "today" },
    ],
    hour: 9,
  });
  assert.equal(r.card.tarefas.total, 2, "tarefa duplicada (mesmo título normalizado) não conta duas vezes");
  assert.equal(r.card.tarefas.destaques.filter((d) => normalizeTexto(d).includes("revisar")).length, 1, "só aparece uma vez nos destaques");
}
console.log("montarBriefingDeterministico: dedupe de tarefa duplicada na entrada: OK");

// ---------- montarBriefingDeterministico: duplicata de CONTA/PENDÊNCIA na entrada ----------
{
  const r = montarBriefingDeterministico({
    climaTexto: "", agendaTexto: "", tarefasItens: [], filaItens: [],
    contasTextos: ['Conta "Internet" vence hoje.', 'conta "internet" vence hoje.'],
    pendenciasTextos: ['"ligar pro Pedro"', '"ligar pro pedro"'],
    hour: 9,
  });
  assert.equal(r.card.contas.length, 1, "conta duplicada (texto igual normalizado) não conta duas vezes");
  assert.equal(r.card.pendencias.length, 1, "pendência duplicada (texto igual normalizado) não conta duas vezes");
}
console.log("montarBriefingDeterministico: dedupe de conta/pendência duplicada na entrada: OK");

// ---------- construirTelasTarefas / construirTelasContas: dedupe + nunca quebra sem título ----------
{
  const r = construirTelasTarefas([
    { id: "1", titulo: "Revisar relatório", status: "now" },
    { id: "2", titulo: "Revisar relatório", status: "now" }, // duplicata
    { id: "3", titulo: "Revisar relatório", status: "today" }, // mesmo título, coluna diferente -> NÃO é duplicata
  ]);
  assert.deepEqual(r, { porColuna: { now: 1, today: 1 } }, "dedupe é por título+coluna, não só título");

  // sem `titulo` (dados antigos/outros chamadores) -> nunca deduplica por engano, preserva comportamento de sempre
  const semTitulo = construirTelasTarefas([{ id: "1", status: "now" }, { id: "2", status: "now" }]);
  assert.deepEqual(semTitulo, { porColuna: { now: 2 } }, "sem título, cada item conta (nunca deduplica no escuro)");

  const contas = construirTelasContas([
    { id: "1", titulo: "Aluguel", status: "pendente", data: "5" },
    { id: "2", titulo: "aluguel", status: "pendente", data: "5" }, // duplicata
    { id: "3", titulo: "Aluguel", status: "pendente", data: "20" }, // vencimento diferente -> não é duplicata
  ], 10);
  assert.equal(contas.total, 2, "conta duplicada (nome+vencimento iguais) não conta duas vezes");
}
console.log("construirTelasTarefas/construirTelasContas: dedupe + nunca quebra sem título: OK");

// ═══════════════════════════ PARTE B: briefing completo e fiel ═══════════════════════════

// ---------- 12 cenários: todo item do card precisa aparecer na fala determinística ----------
{
  const cenarios = [
    {
      nome: "dia cheio (tudo)",
      input: {
        climaTexto: "Em São Paulo agora: nublado, 18°C.",
        agendaTexto: "08:00 Reunião de alinhamento; 14:00 Dentista",
        tarefasItens: [{ id: "1", titulo: "Revisar proposta", status: "now" }],
        contasTextos: ['Conta "Internet" vence hoje.'],
        pendenciasTextos: ['"ligar pro Pedro"'],
        filaItens: [{ tipo: "tarefa", texto: 'Tarefa "X" parada.' }],
        hour: 9,
      },
      chaves: ["São Paulo", "Reunião de alinhamento", "Dentista", "Revisar proposta", "Internet", "Pedro", "parada"],
    },
    {
      nome: "dia vazio",
      input: { climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 9 },
      chaves: ["tranquilo"],
    },
    {
      nome: "20 tarefas",
      input: {
        climaTexto: "", agendaTexto: "", contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 9,
        tarefasItens: Array.from({ length: 20 }, (_, i) => ({ id: String(i), titulo: `Tarefa Alpha ${i}`, status: "now" })),
      },
      chaves: ["20 tarefas", "Tarefa Alpha 0", "mais 12"],
    },
    {
      nome: "duplicata de agenda na entrada",
      input: {
        climaTexto: "", agendaTexto: "10:00 Reunião; 10:00 reuniao", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 9,
      },
      chaves: ["Reunião"],
      extra: (r) => assert.equal(r.card.agenda.length, 1, "agenda duplicada vira 1 item só no card"),
    },
    {
      nome: "duplicata de tarefa na entrada",
      input: {
        climaTexto: "", agendaTexto: "", contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 9,
        tarefasItens: [{ id: "1", titulo: "Ligar fornecedor", status: "now" }, { id: "2", titulo: "ligar fornecedor", status: "now" }],
      },
      chaves: ["1 tarefa", "Ligar fornecedor"],
    },
    {
      nome: "duplicata de conta na entrada",
      input: {
        climaTexto: "", agendaTexto: "", tarefasItens: [], pendenciasTextos: [], filaItens: [], hour: 9,
        contasTextos: ['Conta "Água" vence hoje.', 'conta "agua" vence hoje.'],
      },
      chaves: ["Água"],
    },
    {
      nome: "duplicata de pendência na entrada",
      input: {
        climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], filaItens: [], hour: 9,
        pendenciasTextos: ['"responder o cliente"', '"responder o cliente"'],
      },
      chaves: ["responder o cliente"],
    },
    {
      nome: "só contas",
      input: { climaTexto: "", agendaTexto: "", tarefasItens: [], pendenciasTextos: [], filaItens: [], hour: 9, contasTextos: ['Conta "Luz" vence hoje.', 'Conta "Gás" está atrasada.'] },
      chaves: ["Luz", "Gás"],
    },
    {
      nome: "só pendências",
      input: { climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], filaItens: [], hour: 9, pendenciasTextos: ['"ligar pro banco"', '"revisar contrato"'] },
      chaves: ["ligar pro banco", "revisar contrato"],
    },
    {
      nome: "só agenda",
      input: { climaTexto: "", agendaTexto: "09:00 Call; 11:00 Reunião; 16:00 Apresentação", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 8 },
      chaves: ["Call", "Reunião", "Apresentação"],
    },
    {
      nome: "só enquanto você dormia",
      input: {
        climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], pendenciasTextos: [], hour: 7,
        filaItens: [{ tipo: "conta", texto: "x" }, { tipo: "conta", texto: "y" }],
      },
      chaves: ["dormia", "2 contas"],
    },
    {
      nome: "tarde com agenda futura e passada",
      input: {
        climaTexto: "", agendaTexto: "09:00 Reunião da manhã; 17:00 Call da tarde", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 15, minute: 0,
      },
      chaves: ["Call da tarde"],
      extra: (r) => assert.ok(!r.fala.includes("Reunião da manhã"), "compromisso que já passou (09:00, agora são 15h) não entra como 'o que te espera'"),
    },
  ];

  assert.equal(cenarios.length, 12, "exatamente 12 cenários, como pedido");

  for (const c of cenarios) {
    const r = montarBriefingDeterministico(c.input);
    for (const chave of c.chaves) {
      assert.ok(r.fala.includes(chave), `[${c.nome}] fala deveria conter "${chave}" (fala: "${r.fala}")`);
    }
    assert.ok(r.body.length <= 140, `[${c.nome}] body <= 140 caracteres (o teto de 1400 vale só pra reescrita do LLM, não pro determinístico)`);
    // a própria fala determinística é fiel a si mesma (cobre 100% do seu próprio card), por construção
    assert.ok(falaEhFielAoDeterministico(r.fala, r.card), `[${c.nome}] fala é fiel ao próprio card`);
    if (c.extra) c.extra(r);
  }
}
console.log("PARTE B (12 cenários): fala determinística cobre todo item do card: OK");

// ---------- falaEhFielAoDeterministico: checagem ZERO TOLERÂNCIA por item do card (não mais % de palavras-chave) ----------
{
  const card = {
    agenda: [{ hora: "09:00", titulo: "Reunião com o Vini" }],
    tarefas: { destaques: ["Revisar proposta", "Ligar pro fornecedor"] },
    contas: ['Conta "Internet" vence hoje.'],
    pendencias: ['"ligar pro Pedro"'],
  };

  const reescritaFiel = 'Bom dia, Gustavo! Vem ver o que te espera. Hoje às 09:00 você tem a Reunião com o Vini. Tem 2 tarefas pedindo atenção: Revisar proposta e Ligar pro fornecedor. E a conta de Internet vence hoje também. Você tinha dito que ia ligar pro Pedro. Bora!';
  assert.equal(falaEhFielAoDeterministico(reescritaFiel, card), true, "reescrita natural, mas com todo item do card presente, é aprovada");

  // horário por extenso/formato alternativo também conta como presente
  const reescritaHoraPorExtenso = reescritaFiel.replace("às 09:00", "às nove horas");
  assert.equal(falaEhFielAoDeterministico(reescritaHoraPorExtenso, card), true, "horário por extenso ('nove horas') também é aceito");
  const reescritaHoraCurta = reescritaFiel.replace("às 09:00", "às 9h");
  assert.equal(falaEhFielAoDeterministico(reescritaHoraCurta, card), true, "horário em '9h' também é aceito");

  const reescritaOmitindoConta = reescritaFiel.replace(" E a conta de Internet vence hoje também.", "");
  assert.equal(falaEhFielAoDeterministico(reescritaOmitindoConta, card), false, "reescrita que OMITE a conta (fato real) é reprovada");

  const reescritaOmitindoUmaTarefa = reescritaFiel.replace(" e Ligar pro fornecedor", "");
  assert.equal(falaEhFielAoDeterministico(reescritaOmitindoUmaTarefa, card), false, "reescrita que omite SÓ 1 das 2 tarefas já é reprovada (zero tolerância por item)");

  const reescritaOmitindoPendencia = reescritaFiel.replace(" Você tinha dito que ia ligar pro Pedro.", "");
  assert.equal(falaEhFielAoDeterministico(reescritaOmitindoPendencia, card), false, "reescrita que OMITE a pendência é reprovada");

  const reescritaOmitindoHorario = reescritaFiel.replace("às 09:00 ", "");
  assert.equal(falaEhFielAoDeterministico(reescritaOmitindoHorario, card), false, "reescrita que mantém o título do compromisso mas OMITE o horário é reprovada");

  assert.equal(falaEhFielAoDeterministico("", card), false, "fala vazia nunca é fiel a um card com conteúdo");
  assert.equal(falaEhFielAoDeterministico("qualquer coisa", {}), true, "card vazio -> sempre considerado fiel (nada obrigatório)");
}
console.log("falaEhFielAoDeterministico (zero tolerância por item, inclusive horário): OK");

// ---------- falaEhFielAoDeterministico: 20 tarefas, LLM omite só 1 -> reprovado ----------
{
  const r = montarBriefingDeterministico({
    climaTexto: "", agendaTexto: "", contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 9,
    tarefasItens: Array.from({ length: 20 }, (_, i) => ({ id: String(i), titulo: `Tarefa Beta ${i}`, status: "now" })),
  });
  // destaques tem 8 tarefas (Beta 0..7) + marcador "e mais 12" — reescreve citando só 7
  // delas (omite "Tarefa Beta 3"), mantendo o resto do texto igual.
  const reescritaOmitindoUma = r.fala.replace("Tarefa Beta 3 e ", "").replace("Tarefa Beta 3, ", "").replace(", Tarefa Beta 3", "");
  assert.ok(!reescritaOmitindoUma.includes("Tarefa Beta 3"), "setup do teste: a reescrita realmente não cita mais a Tarefa Beta 3");
  assert.equal(falaEhFielAoDeterministico(reescritaOmitindoUma, r.card), false, "20 tarefas no card, LLM omite 1 só -> reprovado (zero tolerância, mesmo entre tantos itens)");
  assert.equal(falaEhFielAoDeterministico(r.fala, r.card), true, "a fala original (sem nada omitido) continua aprovada");
}
console.log("falaEhFielAoDeterministico (20 tarefas, omite 1 só -> reprovado): OK");

// ---------- dia lotado: 8 de cada categoria, NADA é cortado no texto determinístico ----------
{
  const r = montarBriefingDeterministico({
    climaTexto: "Em São Paulo agora: nublado, 20°C.",
    hour: 8, minute: 0,
    agendaTexto: Array.from({ length: 8 }, (_, i) => `0${i}:00 Compromisso número ${i} com nome bem específico`).join("; "),
    tarefasItens: Array.from({ length: 8 }, (_, i) => ({ id: String(i), titulo: `Tarefa número ${i} com descrição razoavelmente longa`, status: i % 2 ? "now" : "today" })),
    contasTextos: Array.from({ length: 8 }, (_, i) => `Conta "Fornecedor Número ${i}" vence hoje.`),
    pendenciasTextos: Array.from({ length: 8 }, (_, i) => `"resolver a pendência número ${i} com o cliente"`),
    filaItens: Array.from({ length: 8 }, (_, i) => ({ tipo: "tarefa", texto: `Tarefa dormindo ${i}` })),
  });

  assert.ok(r.fala.length > 1400, `dia lotado deveria passar de 1400 caracteres (tem ${r.fala.length}) — senão o teste não está testando o corte de verdade`);
  assert.ok(falaEhFielAoDeterministico(r.fala, r.card), "mesmo passando de 1400 caracteres, TODO item do card aparece na fala (nada foi cortado)");
  for (let i = 0; i < 8; i++) {
    assert.ok(r.fala.includes(`Compromisso número ${i}`), `compromisso ${i} não pode ter sido cortado`);
    assert.ok(r.fala.includes(`Tarefa número ${i}`), `tarefa ${i} não pode ter sido cortada`);
    assert.ok(r.fala.includes(`Fornecedor Número ${i}`), `conta ${i} não pode ter sido cortada`);
    assert.ok(r.fala.includes(`pendência número ${i}`), `pendência ${i} não pode ter sido cortada`);
  }
  assert.ok(r.body.length <= 140, "o body (push) continua capado em 140, mesmo com a fala inteira passando de 1400");
}
console.log("dia lotado (8 de cada categoria): texto determinístico nunca é cortado, mesmo > 1400 caracteres: OK");

// ═══════════════════════════ PARTE C: consciência de hora em todo texto fixo ═══════════════

// ---------- tituloBriefingPorPeriodo + periodoDoDia, relógio simulado 07h/11h59/12h/15h/19h/22h/03h ----------
{
  const casos = [
    { hour: 7, minute: 0, periodo: "manha", titulo: "Resumo do dia" },
    { hour: 11, minute: 59, periodo: "manha", titulo: "Resumo do dia" },
    { hour: 12, minute: 0, periodo: "tarde", titulo: "O que falta hoje" },
    { hour: 15, minute: 0, periodo: "tarde", titulo: "O que falta hoje" },
    { hour: 19, minute: 0, periodo: "noite", titulo: "Fechamento do dia" },
    { hour: 22, minute: 0, periodo: "noite", titulo: "Fechamento do dia" },
    { hour: 3, minute: 0, periodo: "madrugada", titulo: "Fechamento do dia" },
  ];
  for (const c of casos) {
    assert.equal(periodoDoDia(c.hour), c.periodo, `${c.hour}h -> período ${c.periodo}`);
    assert.equal(tituloBriefingPorPeriodo(c.hour), c.titulo, `${c.hour}h -> título "${c.titulo}"`);
  }
}
console.log("tituloBriefingPorPeriodo + periodoDoDia (07h/11h59/12h/15h/19h/22h/03h): OK");

// ---------- a abertura leve NUNCA diz "o que te espera hoje" fora do período da manhã ----------
{
  const horasNaoManha = [12, 13, 15, 17, 19, 21, 23, 2, 4];
  for (const hour of horasNaoManha) {
    for (let dia = 1; dia <= 5; dia++) {
      const r = montarBriefingDeterministico({ climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour, dayOfMonth: dia });
      assert.ok(!r.fala.toLowerCase().includes("o que te espera hoje"), `[hour=${hour}, dia=${dia}] não pode dizer "o que te espera hoje" fora da manhã (fala: "${r.fala}")`);
    }
  }
}
console.log("abertura nunca diz 'o que te espera hoje' fora do período da manhã (bug relatado): OK");

// ---------- compromissos que já passaram não são "o que te espera" à tarde/noite; de manhã mostra tudo ----------
{
  const agendaTexto = "07:00 Reunião da manhã; 20:00 Jantar";

  const demanha = montarBriefingDeterministico({ climaTexto: "", agendaTexto, tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 8, minute: 0 });
  assert.ok(demanha.fala.includes("Reunião da manhã"), "de manhã, mostra o dia inteiro (mesmo o que já passou há pouco)");
  assert.ok(demanha.fala.includes("Jantar"), "de manhã, mostra o que ainda vai acontecer também");
  assert.equal(demanha.card.agenda.length, 2, "de manhã, card mostra os 2 compromissos");

  const atarde = montarBriefingDeterministico({ climaTexto: "", agendaTexto, tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 15, minute: 0 });
  assert.ok(!atarde.fala.includes("Reunião da manhã"), "à tarde, compromisso das 07:00 (já passou) não é citado como 'o que te espera'");
  assert.ok(atarde.fala.includes("Jantar"), "à tarde, compromisso das 20:00 (ainda não aconteceu) continua sendo citado");
  assert.equal(atarde.card.agenda.length, 1, "à tarde, card e fala vêm da MESMA lista já filtrada (só o Jantar)");

  // dia inteiro já passou -> nunca inventa "agenda livre" (não é verdade, só já passou tudo)
  const agendaTodaPassada = "07:00 Reunião; 10:00 Call";
  const anoite = montarBriefingDeterministico({ climaTexto: "", agendaTexto: agendaTodaPassada, tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 20, minute: 0 });
  assert.ok(!anoite.fala.toLowerCase().includes("livre"), "à noite, com tudo já passado, nunca diz que a agenda 'tá livre' (seria enganoso)");
  assert.equal(anoite.card.agenda.length, 0, "à noite, card não mostra compromissos que já passaram");
}
console.log("compromissos já passados somem de 'o que te espera' à tarde/noite, mantidos de manhã: OK");

// ---------- título/vocabulário também corretos no "briefing_now" manual e na entrega via chat (mesma função, smoke) ----------
{
  // gerarBriefing/o fluxo de chat chamam tituloBriefingPorPeriodo com a hora do SERVIDOR —
  // aqui confirmamos que a função pura usada nos dois pontos nunca depende de mais nada
  // além da hora (sem efeito colateral, sem estado).
  assert.equal(tituloBriefingPorPeriodo(9), tituloBriefingPorPeriodo(9));
  assert.notEqual(tituloBriefingPorPeriodo(9), tituloBriefingPorPeriodo(21));
}
console.log("tituloBriefingPorPeriodo é pura e determinística: OK");

console.log("_fix3-dedupe-fidelidade-hora.test.mjs: todos os testes passaram");
