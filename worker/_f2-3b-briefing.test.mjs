import assert from "node:assert/strict";
import {
  deveDispararBriefing,
  selecionarPendenciasVencidas,
  filtrarFilaParaBriefing,
  montarBriefingDeterministico,
} from "./index.js";

const CONFIG = { briefingHora: "07:30", briefingAtivo: true, pendenciasAtivas: true };

// America/Sao_Paulo é fixo UTC-3 (sem horário de verão desde 2019) — monta uma data
// num horário local de SP sem depender do fuso da máquina que roda o teste.
const spDate = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00-03:00`);

// ---------- deveDispararBriefing ----------
{
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "07:30"), config: CONFIG, dormindo: false, jaFeitoHoje: false }),
    true,
    "no horário exato, acordado, ainda não feito -> dispara"
  );
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "10:29"), config: CONFIG, dormindo: false, jaFeitoHoje: false }),
    true,
    "dentro da janela de graça de 3h -> ainda dispara"
  );
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "10:31"), config: CONFIG, dormindo: false, jaFeitoHoje: false }),
    false,
    "depois da janela de graça -> não dispara mais hoje"
  );
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "07:30"), config: CONFIG, dormindo: false, jaFeitoHoje: true }),
    false,
    "já feito hoje -> não dispara de novo"
  );
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "07:30"), config: CONFIG, dormindo: true, jaFeitoHoje: false }),
    false,
    "dormindo -> não dispara (só dispara fora do sono)"
  );
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "07:30"), config: { ...CONFIG, briefingAtivo: false }, dormindo: false, jaFeitoHoje: false }),
    false,
    "briefingAtivo=false -> nunca dispara"
  );
  assert.equal(
    deveDispararBriefing({ agora: spDate("2026-01-10", "07:00"), config: CONFIG, dormindo: false, jaFeitoHoje: false }),
    false,
    "antes do horário configurado -> ainda não dispara"
  );
}
console.log("deveDispararBriefing: OK");

// ---------- selecionarPendenciasVencidas ----------
{
  const items = [
    { id: "1", kind: "pendencia", text: "ligar pro Pedro", status: "ativo", followUpAt: "2026-01-10" },
    { id: "2", kind: "pendencia", text: "atrasada", status: "ativo", followUpAt: "2026-01-05" },
    { id: "3", kind: "pendencia", text: "no futuro", status: "ativo", followUpAt: "2026-01-20" },
    { id: "4", kind: "pendencia", text: "já arquivada", status: "arquivado", followUpAt: "2026-01-01" },
    { id: "5", kind: "duradouro", text: "não é pendência", status: "ativo", followUpAt: "2026-01-01" },
    { id: "6", kind: "pendencia", text: "sem data", status: "ativo", followUpAt: null },
  ];
  const vencidas = selecionarPendenciasVencidas(items, "2026-01-10");
  assert.deepEqual(vencidas.map((p) => p.id).sort(), ["1", "2"], "só pendências ativas com followUpAt <= hoje");

  assert.deepEqual(selecionarPendenciasVencidas([], "2026-01-10"), [], "lista vazia -> nada vencido");
  assert.deepEqual(selecionarPendenciasVencidas(null, "2026-01-10"), [], "items null -> nunca quebra, devolve vazio");
}
console.log("selecionarPendenciasVencidas: OK");

// ---------- filtrarFilaParaBriefing ----------
{
  const idsContasVivas = new Set(["c1"]);
  const idsTarefasVivas = new Set(["t1"]);
  const fila = [
    { tipo: "agenda", texto: "Reunião às 09:00", dia: "2026-01-10", hhmm: "09:00" }, // ainda não passou (agora=08:00)
    { tipo: "agenda", texto: "Dentista às 07:00", dia: "2026-01-10", hhmm: "07:00" }, // já passou
    { tipo: "agenda", texto: "Compromisso de ontem", dia: "2026-01-09", hhmm: "10:00" }, // dia passado
    { tipo: "conta", texto: "Conta de luz", id: "c1" }, // ainda viva
    { tipo: "conta", texto: "Conta já paga", id: "c2" }, // não está mais nos vivos -> descarta
    { tipo: "tarefa", texto: "Tarefa parada", id: "t1" }, // ainda viva
    { tipo: "tarefa", texto: "Tarefa já concluída", id: "t2" }, // descarta
    { tipo: "espontaneo", texto: "Algo que ela comentou" }, // tipo não filtrado -> mantém
  ];
  const resultado = filtrarFilaParaBriefing(fila, { hoje: "2026-01-10", agoraMin: 8 * 60, idsContasVivas, idsTarefasVivas });
  assert.deepEqual(
    resultado.map((i) => i.texto),
    ["Reunião às 09:00", "Conta de luz", "Tarefa parada", "Algo que ela comentou"],
    "descarta agenda passada (hoje ou dia anterior), conta/tarefa que não estão mais vivas"
  );

  assert.deepEqual(filtrarFilaParaBriefing(null, { hoje: "2026-01-10", agoraMin: 0 }), [], "fila null -> nunca quebra");

  // item de agenda sem id/dia (formato antigo) -> por segurança, mantém
  const semDia = [{ tipo: "agenda", texto: "sem metadado" }];
  assert.deepEqual(filtrarFilaParaBriefing(semDia, { hoje: "2026-01-10", agoraMin: 0 }).length, 1, "agenda sem dia -> mantém (nunca descarta por falta de dado)");
}
console.log("filtrarFilaParaBriefing: OK");

// ---------- montarBriefingDeterministico ----------
{
  const cheio = montarBriefingDeterministico({
    climaTexto: "Em São Paulo agora: céu limpo, 22°C.",
    agendaTexto: "09:00 Reunião com o time",
    tarefasTexto: "Revisar relatório",
    contasTextos: ['Conta "Luz" vence hoje.'],
    pendenciasTextos: ['"ligar pro Pedro"'],
    filaTextos: ["Compromisso X começa às 20:00."],
  });
  assert.equal(cheio.title, "Bom dia");
  for (const trecho of ["São Paulo", "Reunião com o time", "Revisar relatório", "Luz", "ligar pro Pedro", "Compromisso X"]) {
    assert.ok(cheio.body.includes(trecho), `texto determinístico deveria mencionar "${trecho}"`);
  }

  // ---- dia tranquilo: nada de clima/agenda/tarefas/contas/pendências/fila ----
  const vazio = montarBriefingDeterministico({
    climaTexto: "",
    agendaTexto: "",
    tarefasTexto: "",
    contasTextos: [],
    pendenciasTextos: [],
    filaTextos: [],
  });
  assert.equal(vazio.title, "Bom dia");
  assert.ok(vazio.body.length > 0, "dia tranquilo ainda produz um texto determinístico (nunca vazio)");
  // Esse é exatamente o texto usado como fallback do gerarBriefing quando a chamada ao
  // LLM falha — e é montado inteiramente por esta função pura, sem nenhuma chamada de
  // rede/IA. Num dia tranquilo (nada de novo pra avisar), o fluxo do cron em
  // runScheduledPush só gera `pendenciaGatilhos`/`candidatos` quando
  // selecionarPendenciasVencidas (testado acima) devolve algo; com a lista vazia,
  // `deterministicosPermitidos.length` fica 0 e `decideNotification` nunca é chamado
  // (ver a guarda `if (!notification && deterministicosPermitidos.length)` em
  // runScheduledPush) — ou seja, zero chamadas de LLM nesse tick.
}
console.log("montarBriefingDeterministico: OK");

console.log("_f2-3b-briefing.test.mjs: todos os testes passaram");
