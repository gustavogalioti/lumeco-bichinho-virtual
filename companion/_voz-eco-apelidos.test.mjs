// Testa as funções puras de voz (normalização, detecção de apelido, similaridade/eco,
// janela de continuidade) extraídas DIRETO do companion/index.html — não uma
// reimplementação — num sandbox node:vm, mesmo padrão de companion/_face2-espontaneo.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const inicio = html.indexOf("const VOZ_CONFIG_DEFAULTS");
const fimMarcador = "function endContinuityWindow(){ continuityUntil = 0; }";
const fimIdx = html.indexOf(fimMarcador, inicio);
assert.ok(inicio !== -1 && fimIdx !== -1, "achou o trecho de voz/eco/apelidos no companion/index.html");
const trecho = html.slice(inicio, fimIdx + fimMarcador.length);

function makeSandbox({ mem, history, now }) {
  const sandbox = { mem, history, console };
  vm.createContext(sandbox);
  // Mantém o Date real (precisa de "new Date(...)" pra parsear os "at" do histórico) —
  // só troca o Date.now() pro instante fixo do teste.
  if (now !== undefined) vm.runInContext(`Date.now = function(){ return ${now}; };`, sandbox);
  vm.runInContext(trecho + `
    this.__normalizeVoiceText = normalizeVoiceText;
    this.__levenshteinDistance = levenshteinDistance;
    this.__isWakeToken = isWakeToken;
    this.__findWakeWordMatch = findWakeWordMatch;
    this.__textSimilarity = textSimilarity;
    this.__isLikelyEcho = isLikelyEcho;
    this.__shouldDiscardAsEcho = shouldDiscardAsEcho;
    this.__vozConfig = vozConfig;
    this.__startContinuityWindow = startContinuityWindow;
    this.__continuityActive = continuityActive;
    this.__endContinuityWindow = endContinuityWindow;
    this.__getContinuityUntil = () => continuityUntil;
  `, sandbox);
  return sandbox;
}

function sb(opts = {}) {
  return makeSandbox({ mem: opts.mem || { config: {} }, history: opts.history || [], now: opts.now || Date.now() });
}

// ---------- normalização ----------
{
  const s = sb();
  assert.equal(s.__normalizeVoiceText('Jarbas, Você Está Aí?'), 'jarbas voce esta ai', 'minúsculas, sem acento, sem pontuação');
  assert.equal(s.__normalizeVoiceText('  múltiplos   espaços  '), 'multiplos espacos', 'colapsa espaços');
  assert.equal(s.__normalizeVoiceText(''), '', 'vazio -> vazio');
  console.log('normalizeVoiceText: OK');
}

// ---------- detecção de apelido ----------
{
  const s = sb();
  const apelidos = ['jarbas','jarbinhas','jarbuxo','jarbera','jarbo','jarbleatles'];
  for (const ap of apelidos) {
    assert.equal(s.__isWakeToken(ap, apelidos), true, `aceita o apelido "${ap}"`);
  }
  // variações de reconhecimento de voz
  for (const variacao of ['jorbas', 'jarbaz', 'jarbinha', 'Jarbas,', 'JARBO']) {
    assert.equal(s.__isWakeToken(variacao, apelidos), true, `aceita a variação "${variacao}"`);
  }
  // palavras comuns nunca devem disparar
  for (const comum of ['sim', 'não', 'bar', 'jar', 'carro', 'trabalho']) {
    assert.equal(s.__isWakeToken(comum, apelidos), false, `rejeita a palavra comum "${comum}"`);
  }
  // token curto (<=3 letras) nunca vale, mesmo que pareça
  assert.equal(s.__isWakeToken('jar', apelidos), false, 'token de 3 letras não vale');
  console.log('isWakeToken: OK');
}

// ---------- findWakeWordMatch (posição + "resto" no texto original) ----------
{
  const s = sb();
  const apelidos = ['jarbas','jarbinhas','jarbuxo','jarbera','jarbo','jarbleatles'];
  const m1 = s.__findWakeWordMatch('jarbas, qual a previsão do tempo', apelidos);
  assert.equal(m1.matched, true);
  assert.equal(m1.rest, 'qual a previsão do tempo', 'extrai o resto depois do apelido, sem a vírgula');

  const m2 = s.__findWakeWordMatch('jorbas me conta uma piada', apelidos);
  assert.equal(m2.matched, true);
  assert.equal(m2.rest, 'me conta uma piada', 'variação "jorbas" também extrai o resto certo');

  const m3 = s.__findWakeWordMatch('oi jarbas', apelidos);
  assert.equal(m3.matched, true);
  assert.equal(m3.rest, '', 'só o apelido sozinho -> resto vazio (entra em "pode falar...")');

  const m4 = s.__findWakeWordMatch('bom dia pra você', apelidos);
  assert.equal(m4.matched, false, 'sem apelido nenhum -> não casa');

  // última ocorrência, igual ao lastIndexOf de antes
  const m5 = s.__findWakeWordMatch('jarbas espera, jarbas me mostra a agenda', apelidos);
  assert.equal(m5.rest, 'me mostra a agenda', 'usa a ÚLTIMA ocorrência do apelido na frase');
  console.log('findWakeWordMatch: OK');
}

// ---------- similaridade / eco (casos reais do log do Gustavo) ----------
{
  const s = sb();
  const jarbasFala = 'Esse dia de café em família promete ser bom! Aproveita bastante! Se precisar de mais alguma coisa, só avisar.';
  const ecoTranscrito = 'esse dia de café em família promete ser bom aproveita bastante se precisar de mais alguma coisa só avisar';
  assert.ok(s.__textSimilarity(ecoTranscrito, jarbasFala) >= 0.65, 'eco do log do Gustavo é reconhecido como muito parecido');

  // frases novas do usuário, mesmo com alguma palavra em comum, devem passar
  const casosNovos = [
    'e amanhã como fica',
    'pode repetir isso',
    'qual é a previsão pra amanhã',
    'sim',
    'não, pode deixar',
  ];
  for (const texto of casosNovos) {
    const sim = s.__textSimilarity(texto, jarbasFala);
    assert.ok(sim < 0.65, `"${texto}" não deveria ser considerado eco (similaridade ${sim.toFixed(2)})`);
  }

  // ---- ECO-2: a regra de contenção agora exige 4+ palavras E 18+ caracteres
  // normalizados (antes bastavam 8 caracteres) — entrada sintética (substring que NÃO
  // cai em limite de palavra) pra isolar só o ramo de contenção, sem a sobreposição de
  // palavras (que combinaria com o mesmo resultado e mascararia o teste): ----
  const naCurta = 'xyzxyzxy'; // 8 caracteres, 1 palavra só — satisfazia o limiar antigo
  const nbComSubstring = 'aaaxyzxyzxybbb'; // contém naCurta como substring, mas não como palavra própria
  assert.ok(s.__textSimilarity(naCurta, nbComSubstring) < 0.65, 'contenção de 8 caracteres/1 palavra não dispara mais (exige 4+ palavras e 18+ caracteres)');

  console.log('textSimilarity: OK');
}

// ---------- isLikelyEcho usando o histórico de verdade ----------
{
  const nowMs = Date.parse('2026-10-10T10:11:30Z');
  const history = [
    { role: 'user', content: 'bom dia jarbas', at: '2026-10-10T10:10:00.000Z' },
    { role: 'assistant', content: 'Esse dia de café em família promete ser bom! Aproveita bastante! Se precisar de mais alguma coisa, só avisar.', at: '2026-10-10T10:11:00.000Z' },
  ];
  const s = sb({ history, now: nowMs });
  assert.equal(
    s.__isLikelyEcho('esse dia de café em família promete ser bom aproveita bastante se precisar de mais alguma coisa só avisar', nowMs),
    true,
    'transcrição idêntica à última fala do Jarbas é descartada como eco'
  );
  assert.equal(s.__isLikelyEcho('jarbas, muda de assunto', nowMs), false, 'fala nova e diferente do usuário passa');
  assert.equal(s.__isLikelyEcho('sim', nowMs), false, 'resposta curta e genuína não é confundida com eco');

  // fora da janela de 120s -> não conta mais como referência de eco
  const historyAntigo = [
    { role: 'assistant', content: 'Esse dia de café em família promete ser bom!', at: '2026-10-10T10:05:00.000Z' }, // 6min30s atrás
  ];
  const s2 = sb({ history: historyAntigo, now: nowMs });
  assert.equal(s2.__isLikelyEcho('esse dia de café em família promete ser bom', nowMs), false, 'fala do Jarbas fora da janela de 120s não é usada pra detectar eco');
  console.log('isLikelyEcho: OK');
}

// ---------- ECO-2: shouldDiscardAsEcho — toque pra falar PULA a similaridade ----------
{
  const nowMs = Date.parse('2026-10-10T10:11:30Z');
  const jarbasFala = 'Anotei que você tomou café em casa hoje de manhã, junto com um pão na chapa.';
  const history = [{ role: 'assistant', content: jarbasFala, at: '2026-10-10T10:11:00.000Z' }];
  const s = sb({ history, now: nowMs });

  // confirma que, SE a checagem de similaridade rodasse, "tomar café?" seria mesmo
  // candidata a eco (senão o teste de "toque pula" não provaria nada) — repetição da
  // fala inteira do Jarbas garante alta similaridade por sobreposição de palavras.
  const transcricaoRepeticaoTotal = jarbasFala.toLowerCase();

  // TOQUE PRA FALAR (handsFree=false): nunca descarta por similaridade, só pela guarda
  // de "Jarbas falando" — mesmo uma repetição quase total da fala do Jarbas passa, porque
  // a pessoa apertou o botão de propósito.
  assert.equal(
    s.__shouldDiscardAsEcho('tomar café?', nowMs, false, false, 0, 900),
    false,
    'toque pra falar: pergunta curta contida numa fala recente do Jarbas NUNCA é descartada em silêncio'
  );
  assert.equal(
    s.__shouldDiscardAsEcho(transcricaoRepeticaoTotal, nowMs, false, false, 0, 900),
    false,
    'toque pra falar: pula a checagem de similaridade por completo, mesmo pra uma repetição quase total'
  );
  // a guarda de "Jarbas falando" continua valendo em QUALQUER modo
  assert.equal(
    s.__shouldDiscardAsEcho('qualquer coisa', nowMs, false, true, 0, 900),
    true,
    'toque pra falar: ainda descarta enquanto o Jarbas está falando (isSpeaking)'
  );
  assert.equal(
    s.__shouldDiscardAsEcho('qualquer coisa', nowMs, false, false, nowMs - 500, 900),
    true,
    'toque pra falar: ainda descarta dentro da folga de 900ms após o fim da fala'
  );

  // MÃOS LIVRES (handsFree=true): a checagem de similaridade continua valendo —
  // eco real (fala inteira repetida) continua descartado.
  assert.equal(
    s.__shouldDiscardAsEcho(transcricaoRepeticaoTotal, nowMs, true, false, 0, 900),
    true,
    'mãos livres: eco real (repetição da fala inteira) continua descartado'
  );
  assert.equal(
    s.__shouldDiscardAsEcho('jarbas, muda de assunto', nowMs, true, false, 0, 900),
    false,
    'mãos livres: fala nova e diferente do usuário continua passando'
  );
  console.log('shouldDiscardAsEcho: OK');
}

// ---------- vozConfig: apelidos/janela/exigirApelidoSempre, com defaults ----------
{
  const semConfig = sb({ mem: { config: {} } });
  const cfgPadrao = semConfig.__vozConfig();
  assert.deepEqual(Array.from(cfgPadrao.apelidos), ['jarbas','jarbinhas','jarbuxo','jarbera','jarbo','jarbleatles'], 'apelidos padrão quando ausente');
  assert.equal(cfgPadrao.janelaConversaSeg, 20, 'janela padrão de 20s');
  assert.equal(cfgPadrao.exigirApelidoSempre, false, 'exigirApelidoSempre padrão false');

  const comConfig = sb({ mem: { config: { voz: { apelidos: ['bot'], janelaConversaSeg: 5, exigirApelidoSempre: true } } } });
  const cfg2 = comConfig.__vozConfig();
  assert.deepEqual(Array.from(cfg2.apelidos), ['bot']);
  assert.equal(cfg2.janelaConversaSeg, 5);
  assert.equal(cfg2.exigirApelidoSempre, true);
  console.log('vozConfig: OK');
}

// ---------- janela de continuidade ----------
{
  // abre no fim da fala (chamada manual simulando o fim de speak())
  const s = sb({ mem: { config: { voz: { janelaConversaSeg: 10 } } } });
  assert.equal(s.__continuityActive(), false, 'antes de abrir, não está ativa');
  s.__startContinuityWindow();
  assert.equal(s.__continuityActive(), true, 'logo após abrir, está ativa');
  assert.ok(s.__getContinuityUntil() > Date.now(), 'continuityUntil fica no futuro');

  // expira
  const sExpira = sb({ mem: { config: { voz: { janelaConversaSeg: 10 } } }, now: 1000000 });
  sExpira.__startContinuityWindow(); // continuityUntil = 1000000 + 10000 = 1010000
  const simulaDepois = makeSandbox({ mem: sExpira.mem, history: [], now: 1010001 });
  vm.runInContext('continuityUntil = ' + sExpira.__getContinuityUntil() + ';', simulaDepois);
  assert.equal(simulaDepois.continuityActive(), false, 'depois do tempo, a janela expira sozinha');

  // janelaConversaSeg = 0 -> sempre exige apelido (nunca abre)
  const sZero = sb({ mem: { config: { voz: { janelaConversaSeg: 0 } } } });
  sZero.__startContinuityWindow();
  assert.equal(sZero.__continuityActive(), false, 'janelaConversaSeg=0 nunca libera a janela');
  assert.equal(sZero.__getContinuityUntil(), 0, 'continuityUntil fica em 0 quando a janela é 0');

  // exigirApelidoSempre=true ignora a janela mesmo com segundos configurados
  const sSempre = sb({ mem: { config: { voz: { janelaConversaSeg: 60, exigirApelidoSempre: true } } } });
  sSempre.__startContinuityWindow();
  assert.equal(sSempre.__continuityActive(), false, 'exigirApelidoSempre ignora a janela mesmo com segundos > 0');

  // endContinuityWindow fecha na hora
  const sEnd = sb({ mem: { config: { voz: { janelaConversaSeg: 30 } } } });
  sEnd.__startContinuityWindow();
  assert.equal(sEnd.__continuityActive(), true);
  sEnd.__endContinuityWindow();
  assert.equal(sEnd.__continuityActive(), false, 'endContinuityWindow fecha a janela imediatamente');

  console.log('janela de continuidade: OK');
}

console.log('_voz-eco-apelidos.test.mjs: todos os testes passaram');
