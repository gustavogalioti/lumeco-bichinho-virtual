import assert from "node:assert/strict";
import {
  isDormindo,
  eventoAcordaNoSono,
  gatilhoPermitidoAgora,
  isPrioritarioTipo,
  mergeFilaItem,
  enqueuePushItem,
  upsertPushSubscription,
  removePushSubscriptionsByEndpoint,
  sendWebPushToAll,
} from "./index.js";

const CONFIG = { sonoInicio: "23:00", sonoFim: "07:00", maxAvisosDia: 5, antecedenciaCompromissoMin: 30, vigiaAtivo: true };

// America/Sao_Paulo é fixo UTC-3 (sem horário de verão desde 2019) — monta uma data
// num horário local de SP sem depender do fuso da máquina que roda o teste.
const spDate = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00-03:00`);

// ---------- isDormindo ----------
{
  // (regra ambiente) dentro da janela, sem nenhuma atividade -> dormindo
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "02:00"), config: CONFIG, explicito: null, ultimaAtividade: null }),
    true,
    "madrugada dentro da janela, sem atividade -> dormindo"
  );

  // fora da janela, sem estado explícito -> acordado
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "14:00"), config: CONFIG, explicito: null, ultimaAtividade: null }),
    false,
    "tarde, fora da janela -> acordado"
  );

  // atividade recente (40 min atrás) dentro da janela -> tira do sono
  {
    const agora = spDate("2026-01-10", "02:00");
    const usuarioAt = new Date(agora.getTime() - 40 * 60000).toISOString();
    assert.equal(
      isDormindo({ agora, config: CONFIG, explicito: null, ultimaAtividade: { usuarioAt, painelAt: null } }),
      false,
      "atividade há 40min dentro da janela -> acordado (ainda não passou de 90min)"
    );
  }
  // mesma janela, mas atividade há 95 min -> volta a dormir
  {
    const agora = spDate("2026-01-10", "02:00");
    const usuarioAt = new Date(agora.getTime() - 95 * 60000).toISOString();
    assert.equal(
      isDormindo({ agora, config: CONFIG, explicito: null, ultimaAtividade: { usuarioAt, painelAt: null } }),
      true,
      "atividade há 95min (>90) dentro da janela -> dormindo de novo"
    );
  }

  // estado explícito "acordado" encerra o sono mesmo dentro da janela
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "02:00"), config: CONFIG, explicito: "acordado", explicitoDesde: spDate("2026-01-10", "01:00").toISOString(), ultimaAtividade: null }),
    false,
    "estado explícito acordado sempre vence"
  );

  // ---- correção: "vou dormir" às 22:30 (sono DA NOITE) ----
  // desde=22:30; a própria mensagem de "boa noite" já é a ultimaAtividade registrada.
  const desdeNoite = spDate("2026-01-10", "22:30").toISOString();
  const ultimaAtividadeNoite = { usuarioAt: desdeNoite, painelAt: null };
  for (const hhmm of ["22:40", "23:10", "23:40", "00:30", "03:00"]) {
    const dia = hhmm < "22:30" ? "2026-01-11" : "2026-01-10"; // 00:30/03:00 já são do dia seguinte
    assert.equal(
      isDormindo({ agora: spDate(dia, hhmm), config: CONFIG, explicito: "dormindo", explicitoDesde: desdeNoite, ultimaAtividade: ultimaAtividadeNoite }),
      true,
      `"vou dormir" às 22:30 -> dormindo às ${hhmm}`
    );
  }
  // atividade DE MADRUGADA (às 03:00, antes do limiar de 5h) não acorda
  {
    const usuarioAt = spDate("2026-01-11", "03:00").toISOString();
    assert.equal(
      isDormindo({ agora: spDate("2026-01-11", "03:00"), config: CONFIG, explicito: "dormindo", explicitoDesde: desdeNoite, ultimaAtividade: { usuarioAt, painelAt: null } }),
      true,
      "atividade às 03:00 (antes do limiar de 5h) não acorda"
    );
  }
  // atividade depois do limiar de 5h (às 05:20) acorda
  {
    const usuarioAt = spDate("2026-01-11", "05:20").toISOString();
    assert.equal(
      isDormindo({ agora: spDate("2026-01-11", "05:20"), config: CONFIG, explicito: "dormindo", explicitoDesde: desdeNoite, ultimaAtividade: { usuarioAt, painelAt: null } }),
      false,
      "atividade às 05:20 (depois do limiar de 5h) acorda"
    );
  }
  // "bom dia" (acordado) acorda sempre, mesmo em plena janela de sono da noite
  assert.equal(
    isDormindo({ agora: spDate("2026-01-11", "01:00"), config: CONFIG, explicito: "acordado", explicitoDesde: spDate("2026-01-11", "01:00").toISOString(), ultimaAtividade: null }),
    false,
    '"bom dia" (acordado) acorda sempre'
  );

  // ---- correção: soneca (fora da janela da noite) ----
  const desdeSoneca = spDate("2026-01-10", "15:00").toISOString();
  // sem nenhuma atividade nova, a soneca continua dormindo (ex: 15:30)
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "15:30"), config: CONFIG, explicito: "dormindo", explicitoDesde: desdeSoneca, ultimaAtividade: { usuarioAt: desdeSoneca, painelAt: null } }),
    true,
    "soneca às 15:00, sem atividade nova -> continua dormindo pouco depois"
  );
  // atividade às 16:00 (depois de desde+10min) encerra a soneca
  {
    const usuarioAt = spDate("2026-01-10", "16:00").toISOString();
    assert.equal(
      isDormindo({ agora: spDate("2026-01-10", "16:00"), config: CONFIG, explicito: "dormindo", explicitoDesde: desdeSoneca, ultimaAtividade: { usuarioAt, painelAt: null } }),
      false,
      "soneca às 15:00 -> atividade às 16:00 acorda"
    );
  }
  // depois de 4h (19:00+), a soneca expira por conta própria mesmo sem atividade nova
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "19:30"), config: CONFIG, explicito: "dormindo", explicitoDesde: desdeSoneca, ultimaAtividade: { usuarioAt: desdeSoneca, painelAt: null } }),
    false,
    "soneca às 15:00 expira depois de 4h (19:30), mesmo sem atividade nova"
  );

  // ---- sem `desde`: cai na regra ambiente (janela + 90min), nunca no mecanismo antigo ----
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "02:00"), config: CONFIG, explicito: "dormindo", ultimaAtividade: null }),
    true,
    "sem desde, dentro da janela e sem atividade -> dormindo (regra ambiente)"
  );
  assert.equal(
    isDormindo({ agora: spDate("2026-01-10", "14:00"), config: CONFIG, explicito: "dormindo", ultimaAtividade: null }),
    false,
    "sem desde, fora da janela -> acordado (regra ambiente, sem mecanismo antigo de 5h)"
  );
}
console.log("isDormindo: OK");

// ---------- eventoAcordaNoSono (exceções que acordam) ----------
{
  assert.equal(eventoAcordaNoSono("06:45", CONFIG), true, "06:45 está dentro da janela 23:00-07:00");
  assert.equal(eventoAcordaNoSono("07:30", CONFIG), true, "07:30 está até 60min depois do fim (07:00+60=08:00)");
  assert.equal(eventoAcordaNoSono("08:30", CONFIG), false, "08:30 já passou da extensão de 60min");
  assert.equal(eventoAcordaNoSono("14:00", CONFIG), false, "14:00 é bem fora da janela");
  assert.equal(eventoAcordaNoSono("23:30", CONFIG), true, "23:30 está dentro da janela (depois do início)");
}
console.log("eventoAcordaNoSono: OK");

// ---------- gatilhoPermitidoAgora (orçamento: isentos x não isentos; dormindo: só agenda-exceção) ----------
{
  // dormindo: só agenda dentro da janela de exceção passa
  assert.equal(gatilhoPermitidoAgora({ tipo: "agenda", hhmm: "06:30", dormindo: true, orcamentoEsgotado: false, config: CONFIG }), true);
  assert.equal(gatilhoPermitidoAgora({ tipo: "agenda", hhmm: "14:00", dormindo: true, orcamentoEsgotado: false, config: CONFIG }), false, "agenda fora da janela de exceção não passa durante o sono");
  assert.equal(gatilhoPermitidoAgora({ tipo: "conta", dormindo: true, orcamentoEsgotado: false, config: CONFIG }), false, "conta nunca passa durante o sono");
  assert.equal(gatilhoPermitidoAgora({ tipo: "espontaneo", dormindo: true, orcamentoEsgotado: false, config: CONFIG }), false, "espontâneo nunca passa durante o sono");

  // orçamento esgotado (e não dormindo): só prioritários (agenda/lembrete/alarme) passam
  assert.equal(gatilhoPermitidoAgora({ tipo: "agenda", hhmm: "14:00", dormindo: false, orcamentoEsgotado: true, config: CONFIG }), true, "agenda é isenta do orçamento");
  assert.equal(gatilhoPermitidoAgora({ tipo: "lembrete", dormindo: false, orcamentoEsgotado: true, config: CONFIG }), true, "lembrete é isento do orçamento");
  assert.equal(gatilhoPermitidoAgora({ tipo: "conta", dormindo: false, orcamentoEsgotado: true, config: CONFIG }), false, "conta NÃO é isenta do orçamento");
  assert.equal(gatilhoPermitidoAgora({ tipo: "tarefa", dormindo: false, orcamentoEsgotado: true, config: CONFIG }), false, "tarefa NÃO é isenta do orçamento");
  assert.equal(gatilhoPermitidoAgora({ tipo: "espontaneo", dormindo: false, orcamentoEsgotado: true, config: CONFIG }), false, "espontâneo NÃO é isento do orçamento");

  // nem dormindo nem orçamento esgotado: tudo passa
  assert.equal(gatilhoPermitidoAgora({ tipo: "conta", dormindo: false, orcamentoEsgotado: false, config: CONFIG }), true);
  assert.equal(isPrioritarioTipo("agenda"), true);
  assert.equal(isPrioritarioTipo("conta"), false);
}
console.log("gatilhoPermitidoAgora / isPrioritarioTipo: OK");

// ---------- mergeFilaItem (fila de avisos adiados) ----------
{
  let r = mergeFilaItem([], { tipo: "conta", texto: "Conta X vence hoje." });
  assert.equal(r.list.length, 1);
  assert.equal(r.descartados, 0);
  assert.equal(r.adicionado, true, "item novo -> adicionado=true");

  // dedupe: mesmo tipo+texto não duplica NEM conta como "adicionado" (correção F2-3a:
  // enqueuePushItem só deve gravar/logar quando adicionado=true — sem isso, o cron a
  // cada 15min geraria dezenas de escritas/eventos idênticos pro mesmo gatilho).
  r = mergeFilaItem(r.list, { tipo: "conta", texto: "Conta X vence hoje." });
  assert.equal(r.list.length, 1, "não duplica o mesmo tipo+texto");
  assert.equal(r.adicionado, false, "já estava na fila -> adicionado=false (nenhuma escrita deve acontecer)");

  // corte no limite (20): descarta os mais antigos
  let fila = [];
  for (let i = 0; i < 20; i++) {
    const res = mergeFilaItem(fila, { tipo: "tarefa", texto: `Tarefa ${i}` });
    assert.equal(res.adicionado, true);
    fila = res.list;
  }
  assert.equal(fila.length, 20);
  const r21 = mergeFilaItem(fila, { tipo: "tarefa", texto: "Tarefa 20" });
  assert.equal(r21.list.length, 20, "nunca passa de 20");
  assert.equal(r21.descartados, 1, "descartou 1 item mais antigo");
  assert.equal(r21.adicionado, true);
  assert.equal(r21.list[0].texto, "Tarefa 1", "descartou o mais antigo (Tarefa 0), manteve o resto");
  assert.equal(r21.list[19].texto, "Tarefa 20", "o novo item fica no fim");
}
console.log("mergeFilaItem: OK");

// ---------- enqueuePushItem: só grava no KV e loga quando o item é novo de verdade ----------
{
  const store = new Map();
  const putCalls = [];
  const env = {
    COMPANION_KV: {
      get: async (key) => (store.has(key) ? store.get(key) : null),
      put: async (key, value) => { putCalls.push(key); store.set(key, value); },
    },
  };
  const logBatch = [];
  const item = { tipo: "conta", texto: "Conta Y venceu ontem.", criadoEm: new Date().toISOString() };

  await enqueuePushItem(env, item, logBatch, "sono");
  assert.equal(putCalls.length, 1, "primeira vez: grava no KV");
  assert.equal(logBatch.length, 1, "primeira vez: registra no Diário");

  // Mesmo gatilho de novo (simulando o próximo tick do cron, 15min depois, ainda não
  // resolvido) — não deve gravar nem logar de novo.
  await enqueuePushItem(env, { ...item, criadoEm: new Date().toISOString() }, logBatch, "sono");
  assert.equal(putCalls.length, 1, "segunda vez (já na fila): nenhuma escrita nova no KV");
  assert.equal(logBatch.length, 1, "segunda vez (já na fila): nenhum evento novo no Diário");

  // Item de agenda carrega hhmm+dia (pra quem consumir a fila descartar horário já
  // passado) — confere que enqueuePushItem persiste esses campos sem alterá-los.
  const agendaItem = { tipo: "agenda", texto: 'Compromisso "Reunião" começa às 06:30.', hhmm: "06:30", dia: "2026-01-11", criadoEm: new Date().toISOString() };
  await enqueuePushItem(env, agendaItem, logBatch, "sono");
  const filaSalva = JSON.parse(store.get("push:fila"));
  const salvo = filaSalva.find((f) => f.tipo === "agenda");
  assert.ok(salvo, "item de agenda foi gravado na fila");
  assert.equal(salvo.hhmm, "06:30");
  assert.equal(salvo.dia, "2026-01-11");
}
console.log("enqueuePushItem (dedupe real): OK");

// ---------- upsertPushSubscription / removePushSubscriptionsByEndpoint (vários aparelhos) ----------
{
  const subA = { endpoint: "https://push.example/a", keys: { p256dh: "1", auth: "1" } };
  const subB = { endpoint: "https://push.example/b", keys: { p256dh: "2", auth: "2" } };

  let list = upsertPushSubscription([], subA);
  assert.equal(list.length, 1);
  list = upsertPushSubscription(list, subB);
  assert.equal(list.length, 2, "aparelho novo adiciona, não substitui");

  // mesmo endpoint, chaves novas (rotação) -> atualiza no lugar, sem duplicar
  const subARot = { endpoint: "https://push.example/a", keys: { p256dh: "1-nova", auth: "1-nova" } };
  list = upsertPushSubscription(list, subARot);
  assert.equal(list.length, 2, "mesmo endpoint nunca duplica");
  assert.equal(list.find((s) => s.endpoint === subA.endpoint).keys.p256dh, "1-nova", "atualiza as chaves no lugar");

  // limite de 5: o 6º endpoint distinto descarta o mais antigo
  let list5 = [];
  for (let i = 0; i < 5; i++) list5 = upsertPushSubscription(list5, { endpoint: `https://push.example/${i}` });
  assert.equal(list5.length, 5);
  list5 = upsertPushSubscription(list5, { endpoint: "https://push.example/5" });
  assert.equal(list5.length, 5, "nunca passa de 5");
  assert.equal(list5.find((s) => s.endpoint === "https://push.example/0"), undefined, "descartou o mais antigo (0)");
  assert.ok(list5.find((s) => s.endpoint === "https://push.example/5"), "o novo (5) entrou");

  // remoção por endpoint (404/410)
  const removed = removePushSubscriptionsByEndpoint(list, [subA.endpoint]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].endpoint, subB.endpoint);
}
console.log("upsertPushSubscription / removePushSubscriptionsByEndpoint: OK");

// ---------- sendWebPushToAll: remove em 404/410, mantém em erro transiente ----------
{
  const subs = [
    { endpoint: "https://push.example/ok" },
    { endpoint: "https://push.example/gone-404" },
    { endpoint: "https://push.example/gone-410" },
    { endpoint: "https://push.example/falha-transiente-500" },
  ];
  const mockSendFn = async (_env, sub) => {
    if (sub.endpoint.endsWith("404")) { const e = new Error("not found"); e.status = 404; throw e; }
    if (sub.endpoint.endsWith("410")) { const e = new Error("gone"); e.status = 410; throw e; }
    if (sub.endpoint.endsWith("500")) { const e = new Error("server error"); e.status = 500; throw e; }
    return; // ok
  };
  const { entregues, endpointsParaRemover } = await sendWebPushToAll({}, subs, { title: "t", body: "b" }, mockSendFn);
  assert.equal(entregues, 1, "só a assinatura ok foi entregue");
  assert.deepEqual(
    endpointsParaRemover.sort(),
    ["https://push.example/gone-404", "https://push.example/gone-410"].sort(),
    "404 e 410 marcados pra remover"
  );
  assert.ok(!endpointsParaRemover.includes("https://push.example/falha-transiente-500"), "erro transiente (500) nunca remove");
}
console.log("sendWebPushToAll: OK");

console.log("_f2-3a-sono.test.mjs: todos os testes passaram");
