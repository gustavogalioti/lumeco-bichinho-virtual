/* =========================================================
   Lumeco — bichinho virtual
   Evolução simples de Tamagotchi: 3 status (fome, sono, higiene)
   geram um 4º status derivado (brilho), que guia a evolução.
   ========================================================= */

const STORAGE_KEY = 'lumeco-state-v1';

const STAGES = [
  { id: 0, name: 'Ovo',    minDays: 0 },
  { id: 1, name: 'Filhote', minDays: 1 / 24 * 2 },   // ~2h depois de nascer
  { id: 2, name: 'Jovem',   minDays: 1.5 },
  { id: 3, name: 'Adulto',  minDays: 3.5 },
];

// taxas de decaimento (pontos perdidos por minuto)
const DECAY = {
  fome:    100 / (10 * 60),  // esvazia em ~10h
  sono:    100 / (14 * 60),  // ~14h
  higiene: 100 / (18 * 60),  // ~18h
};

const GAIN = {
  fome: 30,
  sono: 35,
  higiene: 40,
};

const TICK_MS = 15000; // recalcula a cada 15s enquanto a página está aberta

let state = loadState();

// ---------- elementos ----------
const els = {
  stageLabel: document.getElementById('stageLabel'),
  ageLabel: document.getElementById('ageLabel'),
  terrarium: document.getElementById('terrarium'),
  terrariumGlow: document.getElementById('terrariumGlow'),
  creatureSvg: document.getElementById('creatureSvg'),
  creatureShadow: document.getElementById('creatureShadow'),
  bubble: document.getElementById('speechBubble'),
  sparkles: document.getElementById('sparkles'),
  hint: document.getElementById('hint'),
  valFome: document.getElementById('valFome'),
  valSono: document.getElementById('valSono'),
  valHigiene: document.getElementById('valHigiene'),
  valBrilho: document.getElementById('valBrilho'),
  barFome: document.getElementById('barFome'),
  barSono: document.getElementById('barSono'),
  barHigiene: document.getElementById('barHigiene'),
  barBrilho: document.getElementById('barBrilho'),
  btnFeed: document.getElementById('btnFeed'),
  btnSleep: document.getElementById('btnSleep'),
  btnClean: document.getElementById('btnClean'),
  btnReset: document.getElementById('btnReset'),
};

// ---------- estado ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignora storage corrompido */ }
  return freshState();
}

function freshState() {
  const now = Date.now();
  return {
    born: now,
    lastTick: now,
    fome: 85,
    sono: 85,
    higiene: 85,
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clamp(v) {
  return Math.max(0, Math.min(100, v));
}

// ---------- simulação de tempo ----------

function applyElapsedDecay() {
  const now = Date.now();
  const minutes = (now - state.lastTick) / 60000;
  if (minutes <= 0) return;

  state.fome = clamp(state.fome - DECAY.fome * minutes);
  state.sono = clamp(state.sono - DECAY.sono * minutes);
  state.higiene = clamp(state.higiene - DECAY.higiene * minutes);
  state.lastTick = now;
}

function ageDays() {
  return (Date.now() - state.born) / (1000 * 60 * 60 * 24);
}

function currentStage() {
  const days = ageDays();
  let stage = STAGES[0];
  for (const s of STAGES) {
    if (days >= s.minDays) stage = s;
  }
  return stage;
}

function brilho() {
  return Math.round((state.fome + state.sono + state.higiene) / 3);
}

// ---------- render ----------

function render() {
  const stage = currentStage();
  const b = brilho();
  const days = Math.floor(ageDays());

  els.stageLabel.textContent = stage.name;
  els.ageLabel.textContent = days <= 0 ? 'dia 0' : `dia ${days}`;

  setValue(els.valFome, els.barFome, state.fome);
  setValue(els.valSono, els.barSono, state.sono);
  setValue(els.valHigiene, els.barHigiene, state.higiene);
  setValue(els.valBrilho, els.barBrilho, b);

  const mood = moodFromBrilho(b);
  const glowColor = mood.color;
  els.terrarium.style.setProperty('--glow-color', glowColor);
  els.terrarium.style.setProperty('--glow-strength', String(0.14 + (b / 100) * 0.3));

  renderCreature(stage.id, mood);

  els.btnFeed.disabled = state.fome >= 99;
  els.btnSleep.disabled = state.sono >= 99;
  els.btnClean.disabled = state.higiene >= 99;

  els.hint.textContent = hintFor(stage, mood);
}

function setValue(valueEl, barEl, v) {
  const rounded = Math.round(v);
  valueEl.textContent = rounded;
  barEl.style.width = rounded + '%';
  barEl.style.background = rounded < 25 ? 'var(--coral)' : rounded < 55 ? 'var(--amber)' : 'var(--mint)';
}

function moodFromBrilho(b) {
  if (b >= 70) return { key: 'radiante', color: '#7fe7c4' };
  if (b >= 40) return { key: 'ok', color: '#f2a65a' };
  return { key: 'cansado', color: '#e2637a' };
}

function hintFor(stage, mood) {
  if (stage.id === 0) return 'O ovo está se aquecendo. Cuide bem para ele eclodir.';
  if (mood.key === 'cansado') return `${stage.name} não está bem — alimente, banhe ou deixe dormir.`;
  if (mood.key === 'ok') return `${stage.name} está indo bem. Continue cuidando.`;
  return `${stage.name} está radiante!`;
}

// ---------- criatura (SVG por estágio) ----------

function renderCreature(stageId, mood) {
  const svg = els.creatureSvg;
  const c = mood.color;
  const shadowWidth = { 0: '46%', 1: '55%', 2: '62%', 3: '68%' }[stageId];
  els.creatureShadow.style.width = shadowWidth;

  svg.classList.toggle('sad', mood.key === 'cansado');

  svg.innerHTML = creatureMarkup(stageId, c);
}

function creatureMarkup(stageId, c) {
  switch (stageId) {
    case 0: // Ovo
      return `
        <ellipse cx="100" cy="112" rx="52" ry="64" fill="${c}" opacity="0.16"/>
        <ellipse cx="100" cy="110" rx="42" ry="54" fill="#152a27" stroke="${c}" stroke-width="3"/>
        <circle cx="82" cy="90" r="4" fill="${c}" opacity="0.8"/>
        <circle cx="112" cy="120" r="3" fill="${c}" opacity="0.6"/>
        <circle cx="96" cy="140" r="3.5" fill="${c}" opacity="0.7"/>
        <path d="M100 46 L104 58 L116 60 L104 64 L100 76 L96 64 L84 60 L96 58 Z" fill="${c}"/>
      `;
    case 1: // Filhote
      return `
        <ellipse cx="100" cy="150" rx="34" ry="8" fill="black" opacity="0.001"/>
        <circle cx="100" cy="108" r="46" fill="#152a27" stroke="${c}" stroke-width="3"/>
        <circle cx="83" cy="102" r="7" fill="${c}"/>
        <circle cx="117" cy="102" r="7" fill="${c}"/>
        <circle cx="85" cy="100" r="2.2" fill="#0c1717"/>
        <circle cx="119" cy="100" r="2.2" fill="#0c1717"/>
        <path d="M90 122 Q100 130 110 122" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path d="M100 44 L103 54 L113 56 L103 59 L100 69 L97 59 L87 56 L97 54 Z" fill="${c}"/>
        <ellipse cx="60" cy="112" rx="8" ry="5" fill="${c}" opacity="0.7"/>
        <ellipse cx="140" cy="112" rx="8" ry="5" fill="${c}" opacity="0.7"/>
      `;
    case 2: // Jovem
      return `
        <ellipse cx="100" cy="118" rx="50" ry="54" fill="#152a27" stroke="${c}" stroke-width="3"/>
        <path d="M58 96 Q40 80 46 56 Q64 62 68 88 Z" fill="${c}" opacity="0.75"/>
        <path d="M142 96 Q160 80 154 56 Q136 62 132 88 Z" fill="${c}" opacity="0.75"/>
        <circle cx="82" cy="112" r="8" fill="${c}"/>
        <circle cx="118" cy="112" r="8" fill="${c}"/>
        <circle cx="84" cy="110" r="2.6" fill="#0c1717"/>
        <circle cx="120" cy="110" r="2.6" fill="#0c1717"/>
        <path d="M88 134 Q100 144 112 134" stroke="${c}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <path d="M100 40 L104 52 L116 55 L104 58 L100 70 L96 58 L84 55 L96 52 Z" fill="${c}"/>
        <circle cx="100" cy="118" r="6" fill="${c}" opacity="0.5"/>
      `;
    default: // Adulto
      return `
        <ellipse cx="100" cy="122" rx="54" ry="56" fill="#152a27" stroke="${c}" stroke-width="3.5"/>
        <path d="M52 100 Q22 84 30 46 Q60 52 66 92 Z" fill="${c}" opacity="0.8"/>
        <path d="M148 100 Q178 84 170 46 Q140 52 134 92 Z" fill="${c}" opacity="0.8"/>
        <path d="M76 66 Q100 46 124 66 L118 78 Q100 64 82 78 Z" fill="${c}" opacity="0.9"/>
        <circle cx="80" cy="116" r="9" fill="${c}"/>
        <circle cx="120" cy="116" r="9" fill="${c}"/>
        <circle cx="82" cy="113" r="3" fill="#0c1717"/>
        <circle cx="122" cy="113" r="3" fill="#0c1717"/>
        <path d="M86 140 Q100 152 114 140" stroke="${c}" stroke-width="4" fill="none" stroke-linecap="round"/>
        <circle cx="100" cy="122" r="10" fill="${c}" opacity="0.55"/>
        <path d="M100 30 L105 46 L121 50 L105 54 L100 70 L95 54 L79 50 L95 46 Z" fill="${c}"/>
      `;
  }
}

// ---------- interações ----------

function doAction(stat) {
  applyElapsedDecay();
  state[stat] = clamp(state[stat] + GAIN[stat]);
  saveState();
  render();
  bounceCreature();
  showBubble(bubbleFor(stat));
  burstSparkles();
}

function bounceCreature() {
  els.creatureSvg.classList.remove('bounce');
  // força reflow para reiniciar a animação
  void els.creatureSvg.offsetWidth;
  els.creatureSvg.classList.add('bounce');
}

function bubbleFor(stat) {
  const msgs = {
    fome: ['Nhom nhom!', 'Delícia!', 'Mais um pouco?'],
    sono: ['Zzz...', 'Que soneca boa.', 'Descansando...'],
    higiene: ['Brilhando!', 'Ah, agora sim.', 'Limpinho!'],
  };
  const list = msgs[stat];
  return list[Math.floor(Math.random() * list.length)];
}

let bubbleTimeout;
function showBubble(text) {
  els.bubble.textContent = text;
  els.bubble.classList.add('show');
  clearTimeout(bubbleTimeout);
  bubbleTimeout = setTimeout(() => els.bubble.classList.remove('show'), 1400);
}

function burstSparkles() {
  const container = els.sparkles;
  const rect = container.getBoundingClientRect();
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.textContent = '✦';
    const x = 40 + Math.random() * 20; // % aproximado do centro
    s.style.left = x + '%';
    s.style.bottom = (30 + Math.random() * 10) + '%';
    s.style.animationDelay = (i * 60) + 'ms';
    container.appendChild(s);
    setTimeout(() => s.remove(), 1300 + i * 60);
  }
}

function resetAll() {
  if (!confirm('Recomeçar do zero? Isso apaga o progresso atual.')) return;
  state = freshState();
  saveState();
  render();
}

// ---------- ciclo de vida ----------

function tick() {
  applyElapsedDecay();
  saveState();
  render();
}

els.btnFeed.addEventListener('click', () => doAction('fome'));
els.btnSleep.addEventListener('click', () => doAction('sono'));
els.btnClean.addEventListener('click', () => doAction('higiene'));
els.btnReset.addEventListener('click', resetAll);

applyElapsedDecay();
saveState();
render();
setInterval(tick, TICK_MS);

// recalcula ao voltar para a aba, para refletir o tempo que passou
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    applyElapsedDecay();
    saveState();
    render();
  }
});
