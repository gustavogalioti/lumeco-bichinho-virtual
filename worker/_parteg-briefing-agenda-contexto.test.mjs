import assert from "node:assert/strict";
import {
  periodoDoDia,
  saudacaoPorHora,
  detectarSaudacaoDeAbertura,
  TAREFAS_COLUNAS_PADRAO,
  filtrarTarefasPorColunas,
  resumoAssuntosRecentes,
  montarEstadoConversaLine,
  respostaViolaConsciencia,
  extrairAberturaBriefing,
  montarBriefingDeterministico,
  verificarConflitoHorario,
  construirCardAgendaPorData,
  AGENDA_PEDIDO_REGEX,
  normalizeText,
} from "./index.js";

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// ---------- PARTE A: briefing natural — 6 amostras, sempre com saudação + sem lista/emoji ----------
{
  const amostras = [
    {
      nome: "manhã corrida",
      hour: 7, dayOfMonth: 20,
      input: {
        climaTexto: "Em São Paulo agora: nublado, 18°C.",
        agendaTexto: "08:00 Reunião de alinhamento; 09:30 Call com cliente; 14:00 Dentista",
        tarefasItens: [
          { id: "1", titulo: "Revisar proposta", status: "now" },
          { id: "2", titulo: "Responder e-mail urgente", status: "today" },
          { id: "3", titulo: "Ligar pro fornecedor", status: "now" },
        ],
        contasTextos: ['Conta "Internet" vence hoje.'],
        pendenciasTextos: ['"ligar pro Pedro"'],
        filaItens: [],
      },
      saudacaoEsperada: "Bom dia",
    },
    {
      nome: "dia vazio",
      hour: 8, dayOfMonth: 21,
      input: { climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [] },
      saudacaoEsperada: "Bom dia",
    },
    {
      nome: "muitas tarefas",
      hour: 9, dayOfMonth: 22,
      input: {
        climaTexto: "", agendaTexto: "",
        tarefasItens: Array.from({ length: 15 }, (_, i) => ({ id: String(i), titulo: `Tarefa ${i}`, status: i % 2 ? "now" : "today" })),
        contasTextos: [], pendenciasTextos: [], filaItens: [],
      },
      saudacaoEsperada: "Bom dia",
    },
    {
      nome: "só compromissos",
      hour: 14, dayOfMonth: 23,
      input: {
        climaTexto: "", agendaTexto: "10:00 Reunião; 16:00 Apresentação",
        tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [],
      },
      saudacaoEsperada: "Boa tarde",
    },
    {
      nome: "fim de noite",
      hour: 22, dayOfMonth: 24,
      input: {
        climaTexto: "", agendaTexto: "",
        tarefasItens: [{ id: "1", titulo: "Rever relatório", status: "now" }],
        contasTextos: [], pendenciasTextos: [], filaItens: [],
      },
      saudacaoEsperada: "Boa noite",
    },
    {
      nome: "madrugada, fila do sono",
      hour: 4, dayOfMonth: 25,
      input: {
        climaTexto: "", agendaTexto: "",
        tarefasItens: [], contasTextos: [], pendenciasTextos: [],
        filaItens: [{ tipo: "tarefa", texto: 'Tarefa "X" está parada em Para Agora.' }],
      },
      saudacaoEsperada: "Boa noite",
    },
  ];

  for (const amostra of amostras) {
    const resultado = montarBriefingDeterministico({ ...amostra.input, hour: amostra.hour, dayOfMonth: amostra.dayOfMonth });
    assert.ok(
      resultado.fala.startsWith(`${amostra.saudacaoEsperada}, Gustavo!`),
      `[${amostra.nome}] deveria começar com "${amostra.saudacaoEsperada}, Gustavo!" (fala: "${resultado.fala}")`
    );
    assert.ok(resultado.fala.length <= 450, `[${amostra.nome}] fala <= 450 caracteres (tem ${resultado.fala.length})`);
    assert.ok(!EMOJI_REGEX.test(resultado.fala), `[${amostra.nome}] fala nunca tem emoji ("${resultado.fala}")`);
    assert.ok(!/^\d+[.)]\s/m.test(resultado.fala), `[${amostra.nome}] fala nunca numera itens como lista ("${resultado.fala}")`);
    assert.ok(!/resumo do dia/i.test(resultado.fala), `[${amostra.nome}] fala nunca diz "resumo do dia" ("${resultado.fala}")`);
    assert.ok(!/briefing/i.test(resultado.fala), `[${amostra.nome}] fala nunca diz "briefing" ("${resultado.fala}")`);
  }
}
console.log("PARTE A (6 amostras de briefing natural): OK");

// ---------- PARTE A: variação de abertura por dia do mês (nunca sempre a mesma frase) ----------
{
  const dias = [1, 2, 3, 4, 5, 6];
  const aberturas = new Set(
    dias.map((d) => extrairAberturaBriefing(montarBriefingDeterministico({ climaTexto: "", agendaTexto: "", tarefasItens: [], contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 8, dayOfMonth: d }).fala))
  );
  assert.ok(aberturas.size > 1, "varia a abertura leve ao longo dos dias, nunca sempre igual");
}
console.log("PARTE A (variação de abertura): OK");

// ---------- PARTE A: extrairAberturaBriefing ----------
{
  assert.equal(extrairAberturaBriefing("Bom dia, Gustavo! Deixa eu te contar como tá o dia. Você tem 1 reunião."), "Deixa eu te contar como tá o dia.");
  assert.equal(extrairAberturaBriefing(""), "");
}
console.log("extrairAberturaBriefing: OK");

// ---------- PARTE B: colunas padrão de tarefas (Para Agora + De Hoje) ----------
{
  assert.deepEqual(TAREFAS_COLUNAS_PADRAO, ["now", "today"]);

  const tarefas = [
    { id: "1", titulo: "Agora", status: "now" },
    { id: "2", titulo: "Hoje", status: "today" },
    { id: "3", titulo: "Pendente de verdade", status: "todo" },
    { id: "4", titulo: "Em andamento", status: "doing" },
    { id: "5", titulo: "Concluída", status: "done" },
  ];

  const padrao = filtrarTarefasPorColunas(tarefas);
  assert.deepEqual(padrao.map((t) => t.id).sort(), ["1", "2"], "sem `colunas`, só Para Agora + De Hoje entram");

  const pendentes = filtrarTarefasPorColunas(tarefas, ["todo"]);
  assert.deepEqual(pendentes.map((t) => t.id), ["3"], "coluna explícita (pendentes) respeitada");

  const todas = filtrarTarefasPorColunas(tarefas, ["now", "today", "todo", "doing", "done"]);
  assert.equal(todas.length, 5, "'todas as tarefas' -> todas as colunas");

  assert.deepEqual(filtrarTarefasPorColunas(null), [], "tarefasItens null -> nunca quebra");

  // o briefing/card de tarefas também respeita o padrão, mesmo sem pedir explicitamente
  const briefing = montarBriefingDeterministico({
    climaTexto: "", agendaTexto: "", tarefasItens: tarefas, contasTextos: [], pendenciasTextos: [], filaItens: [], hour: 9,
  });
  assert.equal(briefing.card.tarefas.total, 2, "card de tarefas do briefing já sai filtrado pro padrão");
}
console.log("PARTE B (colunas padrão de tarefas): OK");

// ---------- PARTE C: período do dia / saudação por hora ----------
{
  assert.equal(periodoDoDia(3), "madrugada");
  assert.equal(periodoDoDia(8), "manha");
  assert.equal(periodoDoDia(15), "tarde");
  assert.equal(periodoDoDia(20), "noite");
  assert.equal(saudacaoPorHora(7), "Bom dia");
  assert.equal(saudacaoPorHora(14), "Boa tarde");
  assert.equal(saudacaoPorHora(21), "Boa noite");
  assert.equal(saudacaoPorHora(3), "Boa noite");
}
console.log("periodoDoDia / saudacaoPorHora: OK");

// ---------- PARTE C: detectarSaudacaoDeAbertura ----------
{
  assert.equal(detectarSaudacaoDeAbertura("Bom dia!"), "manha");
  assert.equal(detectarSaudacaoDeAbertura("boa tarde jarbas"), "tarde");
  assert.equal(detectarSaudacaoDeAbertura("Boa noite"), "noite");
  assert.equal(detectarSaudacaoDeAbertura("e aí, como vai?"), null);
}
console.log("detectarSaudacaoDeAbertura: OK");

// ---------- PARTE C: resumoAssuntosRecentes ----------
{
  const semAssunto = resumoAssuntosRecentes([{ role: "user", content: "oi" }, { role: "assistant", content: "Oi! Como posso ajudar?" }]);
  assert.equal(semAssunto, "", "sem menção a agenda/tarefas -> sem resumo");

  const comAgendaETarefas = resumoAssuntosRecentes([
    { role: "user", content: "o que eu tenho hoje?" },
    { role: "assistant", content: "Você tem 2 tarefas pra hoje e uma reunião às 10h." },
  ]);
  assert.ok(comAgendaETarefas.includes("a agenda") && comAgendaETarefas.includes("as tarefas"), `deveria citar os dois assuntos (resumo: "${comAgendaETarefas}")`);
  assert.ok(comAgendaETarefas.includes("não pergunte de novo"), "instrui a não repetir pergunta");
}
console.log("resumoAssuntosRecentes: OK");

// ---------- PARTE C: 4 cenários de montarEstadoConversaLine + post-check por regex ----------
{
  // Cenário 1: "bom dia" às 7h, briefing ainda não lido -> entrega o briefing natural agora.
  const cenario1 = montarEstadoConversaLine({
    hour: 7, saudacaoDetectada: "manha", briefingPendente: true, dadosBriefingVazios: false,
    resumoRecente: "", resumoDadosDoDia: "Agenda de hoje: 09:00 Reunião.",
  });
  assert.ok(cenario1.includes("AINDA NÃO contou o dia"), `cenário 1 deveria instruir a contar o dia agora (linha: "${cenario1}")`);
  assert.ok(cenario1.includes("Agenda de hoje: 09:00 Reunião."), "cenário 1 injeta os dados do dia pra narrar");
  assert.equal(
    respostaViolaConsciencia("Bom dia, Gustavo! Como está o dia até agora?", { antesDoMeioDia: true }),
    "pergunta_dia_antes_do_meio_dia",
    "simulação de resposta errada (pergunta proibida antes do meio-dia) é pega pelo validador"
  );

  // Cenário 2: "bom dia" às 7h, briefing já lido -> só devolve a saudação, sem repetir.
  const cenario2 = montarEstadoConversaLine({
    hour: 7, saudacaoDetectada: "manha", briefingPendente: false, dadosBriefingVazios: true,
    resumoRecente: "", resumoDadosDoDia: "",
  });
  assert.ok(cenario2.includes("já contou o dia"), `cenário 2 não deveria repetir o briefing (linha: "${cenario2}")`);
  assert.ok(!cenario2.includes("AINDA NÃO"), "cenário 2 não entra na lógica de entrega do briefing");

  // Cenário 3: "oi" às 15h -> sem saudação de abertura, nenhuma lógica de briefing dispara.
  const cenario3 = montarEstadoConversaLine({
    hour: 15, saudacaoDetectada: null, briefingPendente: false, dadosBriefingVazios: true,
    resumoRecente: "", resumoDadosDoDia: "",
  });
  assert.ok(cenario3.includes("período da tarde"), `cenário 3 identifica o período certo (linha: "${cenario3}")`);
  assert.ok(!cenario3.includes("cumprimentou"), "cenário 3 não acha que houve saudação de abertura");
  assert.equal(
    respostaViolaConsciencia("Oi! Como está o dia até agora?", { antesDoMeioDia: false }),
    null,
    "às 15h a pergunta sobre o dia já é permitida"
  );

  // Cenário 4: pergunta de planos logo depois de listar tarefas/agenda -> nunca repete a pergunta.
  const cenario4 = montarEstadoConversaLine({
    hour: 11, saudacaoDetectada: null, briefingPendente: false, dadosBriefingVazios: true,
    resumoRecente: resumoAssuntosRecentes([{ role: "assistant", content: "Você tem 2 tarefas pra hoje: revisar o relatório e responder o e-mail." }]),
    resumoDadosDoDia: "",
  });
  assert.ok(cenario4.includes("não pergunte de novo"), `cenário 4 carrega a regra de não repetir (linha: "${cenario4}")`);
  assert.equal(
    respostaViolaConsciencia("Você tem 2 tarefas: revisar o relatório e responder o e-mail. Tem alguma coisa específica planejada para hoje?", { acabouDeListar: true }),
    "pergunta_redundante",
    "simulação da pergunta redundante (problema real relatado) é pega pelo validador"
  );
  assert.equal(
    respostaViolaConsciencia("Você tem 2 tarefas: revisar o relatório e responder o e-mail. Quer que eu reorganize alguma coisa?", { acabouDeListar: true }),
    null,
    "oferecer reorganizar em vez de perguntar de novo não é violação"
  );
}
console.log("PARTE C (4 cenários de consciência de hora/conversa): OK");

// ---------- PARTE D: agenda por data/intervalo/horário ----------
{
  // regex de oferta da ferramenta cobre as variações pedidas, sem disparar em papo comum
  for (const frase of ["o que tenho amanhã", "tenho algo sexta às 15h", "estou livre dia 25 à tarde", "e a semana que vem", "tenho reunião hoje"]) {
    assert.ok(AGENDA_PEDIDO_REGEX.test(normalizeText(frase)), `deveria oferecer consultar_agenda pra "${frase}"`);
  }
  assert.ok(!AGENDA_PEDIDO_REGEX.test(normalizeText("qual é a capital da frança")), "não dispara em papo comum sem relação com agenda");

  // conflito de horário
  const eventos = [
    { date: "2026-10-23", time: "09:00", title: "Reunião com o Vini" },
    { date: "2026-10-23", time: "15:00", title: "CFP" },
  ];
  assert.deepEqual(verificarConflitoHorario(eventos, "09:00"), { ocupado: true, titulo: "Reunião com o Vini", hora: "09:00" });
  assert.deepEqual(verificarConflitoHorario(eventos, "11:00"), { ocupado: false });
  assert.equal(verificarConflitoHorario(eventos, ""), null, "sem horário pedido -> sem checagem de conflito");
  assert.deepEqual(verificarConflitoHorario([], "09:00"), { ocupado: false }, "dia vazio -> sempre livre");

  // card da agenda por data
  const card = construirCardAgendaPorData(eventos, "2026-10-23", null);
  assert.equal(card.titulo, "Agenda — 23/10");
  assert.deepEqual(card.linhas, ["09:00 Reunião com o Vini", "15:00 CFP"]);
  assert.equal(construirCardAgendaPorData([], "2026-10-25", null), null, "dia vazio -> sem card (nunca inventa)");

  const cardIntervalo = construirCardAgendaPorData(eventos, "2026-10-20", "2026-10-26");
  assert.equal(cardIntervalo.titulo, "Agenda — 20/10 a 26/10");
}
console.log("PARTE D (agenda por data/intervalo/horário): OK");

console.log("_parteg-briefing-agenda-contexto.test.mjs: todos os testes passaram");
