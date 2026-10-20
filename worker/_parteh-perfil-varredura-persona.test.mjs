import assert from "node:assert/strict";
import {
  perfilVazio,
  normalizarPerfil,
  truncarPerfilParaLimite,
  montarPerfilLine,
  montarNovidadesPainelLine,
  montarIdeiaDoDiaLine,
  anexarIdeiaDoDiaNoBriefing,
  devoConsolidarPerfilAgora,
  devoVarrerPainelAgora,
  diffPainelDigest,
  varrerPainelSeNecessario,
  companionPrompt,
} from "./index.js";

// ---------- PARTE A: perfilVazio / normalizarPerfil ----------
{
  const vazio = perfilVazio();
  assert.deepEqual(vazio.pessoal, []);
  assert.equal(vazio.humorRecente, "");
  assert.equal(vazio.atualizadoEm, null);

  const normal = normalizarPerfil({
    pessoal: [{ texto: "Vai viajar em dezembro", data: "2026-10-01", fonte: "conversa" }],
    profissional: ["string solta também vira item"],
    emFoco: [],
    planos: [{ texto: "" }, { texto: "   " }, null, "ok"], // lixo descartado, só o válido sobra
    preocupacoes: [{ semTexto: true }],
    humorRecente: "animado",
  });
  assert.equal(normal.pessoal.length, 1);
  assert.equal(normal.pessoal[0].texto, "Vai viajar em dezembro");
  assert.equal(normal.profissional[0].texto, "string solta também vira item");
  assert.equal(normal.planos.length, 1, "descarta item vazio/malformado, mantém só o válido");
  assert.equal(normal.planos[0].texto, "ok");
  assert.equal(normal.preocupacoes.length, 0, "item sem texto nenhum é descartado");
  assert.equal(normal.humorRecente, "animado");

  assert.deepEqual(normalizarPerfil(null), perfilVazio(), "entrada nula -> perfil vazio, nunca quebra");
  assert.deepEqual(normalizarPerfil("string qualquer"), perfilVazio(), "entrada não-objeto -> perfil vazio");

  const categoriaGrande = Array.from({ length: 30 }, (_, i) => ({ texto: `item ${i}` }));
  const limitado = normalizarPerfil({ pessoal: categoriaGrande });
  assert.equal(limitado.pessoal.length, 20, "cada categoria já cai pra no máximo 20 itens na normalização");
}
console.log("perfilVazio / normalizarPerfil: OK");

// ---------- PARTE A: truncarPerfilParaLimite — nunca passa do limite, corta o mais antigo ----------
{
  const perfilGrande = {
    pessoal: Array.from({ length: 20 }, (_, i) => ({ texto: `Fato pessoal número ${i} com um texto razoavelmente longo pra pesar no JSON`, data: `2026-01-${String(i + 1).padStart(2, "0")}` })),
    profissional: [],
    emFoco: [],
    planos: [],
    preocupacoes: [],
    humorRecente: "",
    atualizadoEm: null,
  };
  const limitado = truncarPerfilParaLimite(perfilGrande, 1500);
  assert.ok(JSON.stringify(limitado).length <= 1500, `respeita o limite de 1500 (ficou com ${JSON.stringify(limitado).length})`);
  assert.ok(limitado.pessoal.length < perfilGrande.pessoal.length, "cortou itens pra caber");
  // o que sobrou são os itens de data MAIS RECENTE (os mais antigos foram cortados primeiro)
  const datasRestantes = limitado.pessoal.map((i) => i.data).sort();
  const datasOriginais = perfilGrande.pessoal.map((i) => i.data).sort();
  assert.equal(datasRestantes[datasRestantes.length - 1], datasOriginais[datasOriginais.length - 1], "manteve o item mais recente");
  assert.ok(!datasRestantes.includes(datasOriginais[0]), "cortou o item mais antigo primeiro");

  const pequeno = { pessoal: [{ texto: "só isso", data: "2026-10-01" }], profissional: [], emFoco: [], planos: [], preocupacoes: [], humorRecente: "ok", atualizadoEm: "2026-10-01T00:00:00.000Z" };
  assert.deepEqual(truncarPerfilParaLimite(pequeno, 1500).pessoal, pequeno.pessoal, "perfil que já cabe não perde nada");
}
console.log("truncarPerfilParaLimite: OK");

// ---------- PARTE A: montarPerfilLine ----------
{
  assert.equal(montarPerfilLine(null), "");
  assert.equal(montarPerfilLine(perfilVazio()), "", "perfil sem nenhum item -> linha vazia (nunca aparece no prompt)");

  const perfil = normalizarPerfil({
    pessoal: [{ texto: "Mora em São Paulo" }],
    profissional: [{ texto: "Trabalha com o Jarbas" }],
    emFoco: [{ texto: "Lançamento do app" }],
    planos: [],
    preocupacoes: [],
    humorRecente: "animado",
  });
  const linha = montarPerfilLine(perfil);
  assert.ok(linha.includes("Mora em São Paulo"), `inclui o fato pessoal (linha: "${linha}")`);
  assert.ok(linha.includes("Lançamento do app"), "inclui o que está em foco");
  assert.ok(linha.includes("Humor recente: animado"), "inclui o humor");
  assert.ok(!linha.includes("Planos:"), "categoria vazia não aparece na linha");
  assert.ok(linha.toLowerCase().includes("nunca recite"), "a própria linha instrui a não recitar como lista");
}
console.log("montarPerfilLine: OK");

// ---------- PARTE B: montarNovidadesPainelLine — só as não mostradas ----------
{
  assert.equal(montarNovidadesPainelLine([]), "");
  assert.equal(montarNovidadesPainelLine(null), "");

  const fila = [
    { texto: 'Tarefa nova: "Revisar contrato"', mostrada: false },
    { texto: 'Conta alterada: "Internet" → paga', mostrada: true }, // já mostrada, não entra
    { texto: 'Compromisso novo: "Dentista"', mostrada: false },
  ];
  const linha = montarNovidadesPainelLine(fila);
  assert.ok(linha.includes("Revisar contrato"), `inclui a novidade não mostrada (linha: "${linha}")`);
  assert.ok(linha.includes("Dentista"), "inclui a segunda novidade não mostrada");
  assert.ok(!linha.includes("Internet"), "nunca repete uma novidade já mostrada");
}
console.log("montarNovidadesPainelLine: OK");

// ---------- PARTE C: montarIdeiaDoDiaLine / anexarIdeiaDoDiaNoBriefing ----------
{
  assert.equal(montarIdeiaDoDiaLine([]), "");
  assert.equal(montarIdeiaDoDiaLine(null), "");
  const linha = montarIdeiaDoDiaLine([{ texto: "Você podia simplificar X combinando com Y.", data: "2026-10-19" }]);
  assert.ok(linha.includes("Você podia simplificar X combinando com Y."), `usa a ideia mais recente (linha: "${linha}")`);

  assert.equal(anexarIdeiaDoDiaNoBriefing([], "2026-10-20"), "");
  assert.equal(anexarIdeiaDoDiaNoBriefing([{ texto: "ideia de ontem", data: "2026-10-19" }], "2026-10-20"), "", "ideia de outro dia NUNCA entra no briefing de hoje");
  const frase = anexarIdeiaDoDiaNoBriefing([{ texto: "ideia de hoje", data: "2026-10-20" }], "2026-10-20");
  assert.ok(frase.includes("ideia de hoje"), `anexa a ideia gerada HOJE (frase: "${frase}")`);
}
console.log("montarIdeiaDoDiaLine / anexarIdeiaDoDiaNoBriefing: OK");

// ---------- PARTE A: devoConsolidarPerfilAgora (gatilho diário) ----------
{
  const hoje = "2026-10-20";
  assert.equal(
    devoConsolidarPerfilAgora({ hour: 2, dateStr: hoje, ultimaConsolidacao: null, atividadeDesdeMs: Date.now() }),
    false,
    "antes das 03:00 nunca consolida, mesmo com atividade"
  );
  assert.equal(
    devoConsolidarPerfilAgora({ hour: 3, dateStr: hoje, ultimaConsolidacao: null, atividadeDesdeMs: Date.now() }),
    true,
    "a partir das 03:00, sem consolidação prévia e com atividade -> consolida"
  );
  assert.equal(
    devoConsolidarPerfilAgora({ hour: 10, dateStr: hoje, ultimaConsolidacao: { dataStr: hoje, emMs: Date.now() }, atividadeDesdeMs: Date.now() }),
    false,
    "já consolidou hoje -> não consolida de novo no mesmo dia"
  );
  assert.equal(
    devoConsolidarPerfilAgora({ hour: 10, dateStr: hoje, ultimaConsolidacao: { dataStr: "2026-10-19", emMs: 1000 }, atividadeDesdeMs: null }),
    false,
    "sem nenhuma atividade registrada -> nada pra consolidar"
  );
  assert.equal(
    devoConsolidarPerfilAgora({ hour: 10, dateStr: hoje, ultimaConsolidacao: { dataStr: "2026-10-19", emMs: 1000 }, atividadeDesdeMs: 500 }),
    false,
    "atividade mais antiga que a última consolidação -> nada mudou, não consolida"
  );
  assert.equal(
    devoConsolidarPerfilAgora({ hour: 10, dateStr: hoje, ultimaConsolidacao: { dataStr: "2026-10-19", emMs: 1000 }, atividadeDesdeMs: 2000 }),
    true,
    "dia novo + atividade depois da última consolidação -> consolida"
  );
}
console.log("devoConsolidarPerfilAgora: OK");

// ---------- PARTE B: devoVarrerPainelAgora (intervalo de 6h) ----------
{
  const agora = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(devoVarrerPainelAgora(null, agora), true, "nunca varreu antes -> varre");
  assert.equal(devoVarrerPainelAgora(new Date(agora - 5 * 3600000).toISOString(), agora), false, "5h atrás -> ainda não chegou a hora");
  assert.equal(devoVarrerPainelAgora(new Date(agora - 6 * 3600000).toISOString(), agora), true, "exatamente 6h -> já pode varrer");
  assert.equal(devoVarrerPainelAgora(new Date(agora - 7 * 3600000).toISOString(), agora), true, "mais de 6h -> varre");
  assert.equal(devoVarrerPainelAgora("data inválida", agora), true, "valor corrompido no KV -> trata como nunca varreu, nunca quebra");
}
console.log("devoVarrerPainelAgora: OK");

// ---------- PARTE B: diffPainelDigest — tarefa nova/alterada/removida, sem IA ----------
{
  const mudancasBase = {
    tarefas: { itens: [{ id: "1", titulo: "Revisar relatório", status: "now", hash: "h1" }] },
    contas: { itens: [] }, agenda: { itens: [] }, ideias: { itens: [] }, lembretes: { itens: [] }, listas: { itens: [] }, diario: { itens: [] }, recados: { itens: [] },
  };
  const r1 = diffPainelDigest(null, mudancasBase);
  assert.equal(r1.isFirstRun, true);
  assert.equal(r1.events.length, 0, "primeira execução nunca gera evento (só estabelece a base)");

  // nada mudou
  const r2 = diffPainelDigest(r1.current, mudancasBase);
  assert.equal(r2.changedSources.length, 0, "nada mudou -> nenhuma fonte marcada como alterada");
  assert.equal(r2.events.length, 0);

  // tarefa nova
  const comTarefaNova = { ...mudancasBase, tarefas: { itens: [...mudancasBase.tarefas.itens, { id: "2", titulo: "Ligar pro cliente", status: "today", hash: "h2" }] } };
  const r3 = diffPainelDigest(r1.current, comTarefaNova);
  assert.deepEqual(r3.changedSources, ["tarefas"]);
  assert.ok(r3.events[0].resumo.includes("Tarefa nova") && r3.events[0].resumo.includes("Ligar pro cliente"));

  // conta nova
  const comContaNova = { ...mudancasBase, contas: { itens: [{ id: "c1", titulo: "Internet", status: "pendente", hash: "hc1" }] } };
  const r4 = diffPainelDigest(r1.current, comContaNova);
  assert.deepEqual(r4.changedSources, ["contas"]);
  assert.ok(r4.events[0].resumo.includes("Conta nova") && r4.events[0].resumo.includes("Internet"));

  // tarefa "movida de coluna" = mesmo id, hash mudou (status mudou)
  const tarefaMovida = { ...mudancasBase, tarefas: { itens: [{ id: "1", titulo: "Revisar relatório", status: "done", hash: "h1-novo" }] } };
  const r5 = diffPainelDigest(r1.current, tarefaMovida);
  assert.ok(r5.events[0].resumo.includes("Tarefa alterada") && r5.events[0].resumo.includes("done"));

  // compromisso removido
  const comAgenda = { ...mudancasBase, agenda: { itens: [{ id: "a1", titulo: "Reunião", status: null, hash: "ha1", data: "2026-10-20" }] } };
  const base6 = diffPainelDigest(null, comAgenda).current;
  const r6 = diffPainelDigest(base6, mudancasBase); // agenda ficou vazia
  assert.ok(r6.events[0].resumo.includes("Compromisso removida") || r6.events[0].resumo.includes("removida"));
}
console.log("diffPainelDigest (tarefa/conta/compromisso novos, alterados, removidos, sem IA): OK");

// ---------- PARTE B: varrerPainelSeNecessario — intervalo, snapshot, sem escrita sem mudança ----------
function makeMockEnv(storeInicial) {
  const store = new Map(Object.entries(storeInicial || {}));
  const putCalls = [];
  return {
    env: {
      COMPANION_KV: {
        get: async (key) => (store.has(key) ? store.get(key) : null),
        put: async (key, value) => { putCalls.push(key); store.set(key, value); },
      },
    },
    store, putCalls,
  };
}

{
  const mudancas1 = { tarefas: { itens: [{ id: "1", titulo: "A", status: "now", hash: "h1" }] }, contas: { itens: [] }, agenda: { itens: [] }, ideias: { itens: [] }, lembretes: { itens: [] }, listas: { itens: [] }, diario: { itens: [] }, recados: { itens: [] } };
  const { env, store, putCalls } = makeMockEnv();
  const logBatch1 = [];
  const r1 = await varrerPainelSeNecessario(env, mudancas1, logBatch1);
  assert.deepEqual(r1.novosCompromissosHoje, [], "primeira execução: sem base pra comparar, sem candidato a aviso");
  assert.ok(store.has("painel:scan:last"), "grava o relógio na primeira execução");
  assert.ok(store.has("painel:snapshot"), "grava o snapshot na primeira execução");
  const chamadasAposPrimeira = putCalls.length;

  // 2ª chamada imediatamente depois (ainda dentro das 6h) -> nem roda de novo
  const logBatch2 = [];
  const r2 = await varrerPainelSeNecessario(env, mudancas1, logBatch2);
  assert.deepEqual(r2.novosCompromissosHoje, []);
  assert.equal(putCalls.length, chamadasAposPrimeira, "dentro das 6h: nenhuma escrita extra no KV");
  assert.equal(logBatch2.length, 0, "dentro das 6h: nenhum evento novo no Diário");
}
console.log("varrerPainelSeNecessario (intervalo de 6h, sem escrita extra sem necessidade): OK");

{
  // força o relógio pra "mais de 6h atrás" e simula uma tarefa nova + compromisso novo pra hoje
  const hojeISO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const mudancasAntes = { tarefas: { itens: [] }, contas: { itens: [] }, agenda: { itens: [] }, ideias: { itens: [] }, lembretes: { itens: [] }, listas: { itens: [] }, diario: { itens: [] }, recados: { itens: [] } };
  const { env } = makeMockEnv();
  await varrerPainelSeNecessario(env, mudancasAntes, []); // estabelece a base

  // reescreve o relógio pra 7h atrás, simulando o intervalo já ter passado
  await env.COMPANION_KV.put("painel:scan:last", new Date(Date.now() - 7 * 3600000).toISOString());

  const mudancasDepois = {
    ...mudancasAntes,
    tarefas: { itens: [{ id: "t1", titulo: "Nova tarefa", status: "now", hash: "ht1" }] },
    agenda: { itens: [{ id: "a1", titulo: "Compromisso de hoje", status: null, hash: "ha1", data: hojeISO }] },
  };
  const logBatch = [];
  const resultado = await varrerPainelSeNecessario(env, mudancasDepois, logBatch);
  assert.equal(resultado.novosCompromissosHoje.length, 1, "achou o compromisso novo marcado pra HOJE");
  assert.equal(resultado.novosCompromissosHoje[0].titulo, "Compromisso de hoje");
  assert.ok(logBatch.some((e) => e.resumo.includes("novidade")), "registra uma linha curta de resumo no Diário, não despeja cada evento");
}
console.log("varrerPainelSeNecessario (passou das 6h: diff real + compromisso novo pra hoje): OK");

{
  // fonte caiu (mudancas null) -> nunca quebra, nunca escreve, candidato vazio
  const { env, putCalls } = makeMockEnv();
  const resultado = await varrerPainelSeNecessario(env, null, []);
  assert.deepEqual(resultado.novosCompromissosHoje, []);
  assert.equal(putCalls.length, 0, "sem mudancas (fonte caiu) -> nenhuma escrita no KV, segue sem quebrar");
}
console.log("varrerPainelSeNecessario (fonte caiu: registra e segue, nunca quebra): OK");

// ---------- PARTE C: persona/independência no prompt + perfil/novidades/ideia injetados ----------
{
  const prompt = companionPrompt(
    { perfil: { pessoal: [{ texto: "gosta de futebol" }], profissional: [], emFoco: [], planos: [], preocupacoes: [], humorRecente: "" }, ideias: [{ texto: "Ideia de teste", data: "2026-10-20" }] },
    "", "", "",
    "Novidade: tarefa nova de teste"
  );
  assert.ok(prompt.includes("gosta de futebol"), "perfil chega no prompt final");
  assert.ok(prompt.includes("Novidade: tarefa nova de teste"), "novidadesPainelLine chega no prompt final");
  assert.ok(prompt.includes("Ideia de teste"), "ideia do dia chega no prompt final");
  assert.ok(/ponto de vista próprio|independente/.test(prompt), "a persona tem o texto de independência/opinião própria");
  assert.ok(/nunca inventa/i.test(prompt), "mantém a regra de nunca inventar fatos");
  assert.ok(/me surpreende|o que você acha/.test(prompt), "instrui o modo opinativo sob pedido explícito");
}
console.log("companionPrompt (persona independente + perfil/novidades/ideia injetados): OK");

console.log("_parteh-perfil-varredura-persona.test.mjs: todos os testes passaram");
