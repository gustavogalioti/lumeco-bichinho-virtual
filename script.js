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

// itens de aconchego e seus efeitos
const ITEM_EFFECTS = {
  cobertor: { sonoDecayMult: 0.7 },       // sono cai 30% mais devagar
  travesseiro: { sonoGainMult: 1.2 },     // dormir rende 20% a mais
  brinquedo: { unlocksToy: true },
};

const TOY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h entre brincadeiras
const TOY_GAIN = 10; // sobe um pouco os 3 status

const CROPS = {
  baga: {
    name: 'Baga Simples', icon: '🫐',
    growMs: 20 * 60 * 1000, unlockDay: 0,
    effect: { fome: 22 },
  },
  fruta: {
    name: 'Fruta Solar', icon: '🍑',
    growMs: 90 * 60 * 1000, unlockDay: 2,
    effect: { fome: 30, higiene: 10 },
  },
  estrela: {
    name: 'Fruta Estelar', icon: '🌟',
    growMs: 4 * 60 * 60 * 1000, unlockDay: 4,
    effect: { fome: 25, sono: 15, higiene: 15 },
  },
};

const FISH_ITEM = { name: 'Peixinho', icon: '🐟', effect: { sono: 25 } };
const FARM_SLOTS = 3;
const FISH_ZONE = { start: 0.42, end: 0.58 }; // fração do ciclo de 1.6s
const FISH_CYCLE_MS = 1600;

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
  pillow: document.getElementById('pillow'),
  blanket: document.getElementById('blanket'),
  toyBtn: document.getElementById('toyBtn'),
  itemCobertor: document.getElementById('itemCobertor'),
  itemTravesseiro: document.getElementById('itemTravesseiro'),
  itemBrinquedo: document.getElementById('itemBrinquedo'),
  plots: document.getElementById('plots'),
  inventory: document.getElementById('inventory'),
  farmSub: document.getElementById('farmSub'),
  btnFish: document.getElementById('btnFish'),
  fishGame: document.getElementById('fishGame'),
  fishMarker: document.getElementById('fishMarker'),
  btnCatch: document.getElementById('btnCatch'),
  pondMsg: document.getElementById('pondMsg'),
  ingredients: document.getElementById('ingredients'),
  btnCook: document.getElementById('btnCook'),
  namingBox: document.getElementById('namingBox'),
  dishNameInput: document.getElementById('dishNameInput'),
  btnConfirmName: document.getElementById('btnConfirmName'),
  btnCancelName: document.getElementById('btnCancelName'),
  dishes: document.getElementById('dishes'),
  chatSub: document.getElementById('chatSub'),
  chatSetup: document.getElementById('chatSetup'),
  workerUrlInput: document.getElementById('workerUrlInput'),
  btnSaveWorker: document.getElementById('btnSaveWorker'),
  chatBox: document.getElementById('chatBox'),
  chatLog: document.getElementById('chatLog'),
  chatInput: document.getElementById('chatInput'),
  btnSendChat: document.getElementById('btnSendChat'),
  btnReconfigWorker: document.getElementById('btnReconfigWorker'),
};

// ---------- estado ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return withDefaults(JSON.parse(raw));
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
    items: { cobertor: false, travesseiro: false, brinquedo: false },
    lastToy: 0,
    farm: { slots: emptySlots() },
    inventory: { baga: 0, fruta: 0, estrela: 0, peixe: 0 },
    recipes: {},
    dishInventory: {},
    chat: { history: [], memory: '', msgCount: 0 },
  };
}

function emptySlots() {
  return Array.from({ length: FARM_SLOTS }, () => ({ crop: null, plantedAt: null }));
}

// garante que estados salvos antes dos itens existirem continuem funcionando
function withDefaults(s) {
  if (!s.items) s.items = { cobertor: false, travesseiro: false, brinquedo: false };
  if (typeof s.lastToy !== 'number') s.lastToy = 0;
  if (!s.farm || !Array.isArray(s.farm.slots)) s.farm = { slots: emptySlots() };
  while (s.farm.slots.length < FARM_SLOTS) s.farm.slots.push({ crop: null, plantedAt: null });
  if (!s.inventory) s.inventory = { baga: 0, fruta: 0, estrela: 0, peixe: 0 };
  for (const k of ['baga', 'fruta', 'estrela', 'peixe']) {
    if (typeof s.inventory[k] !== 'number') s.inventory[k] = 0;
  }
  if (!s.recipes) s.recipes = {};
  if (!s.dishInventory) s.dishInventory = {};
  if (!s.chat) s.chat = { history: [], memory: '', msgCount: 0 };
  if (!Array.isArray(s.chat.history)) s.chat.history = [];
  if (typeof s.chat.memory !== 'string') s.chat.memory = '';
  if (typeof s.chat.msgCount !== 'number') s.chat.msgCount = 0;
  return s;
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

  const sonoDecayMult = state.items.cobertor ? ITEM_EFFECTS.cobertor.sonoDecayMult : 1;

  state.fome = clamp(state.fome - DECAY.fome * minutes);
  state.sono = clamp(state.sono - DECAY.sono * sonoDecayMult * minutes);
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

  renderItems();
  renderFarm();
  renderKitchen();
}

function renderItems() {
  els.itemCobertor.classList.toggle('on', state.items.cobertor);
  els.itemTravesseiro.classList.toggle('on', state.items.travesseiro);
  els.itemBrinquedo.classList.toggle('on', state.items.brinquedo);

  els.pillow.classList.toggle('equipped', state.items.travesseiro);
  els.blanket.classList.toggle('equipped', state.items.cobertor);

  els.toyBtn.classList.toggle('equipped', state.items.brinquedo);
  updateToyCooldown();
}

function updateToyCooldown() {
  if (!state.items.brinquedo) return;
  const remaining = TOY_COOLDOWN_MS - (Date.now() - state.lastToy);
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    els.toyBtn.disabled = true;
    els.toyBtn.title = `Volta a brincar em ${mins} min`;
  } else {
    els.toyBtn.disabled = false;
    els.toyBtn.title = 'Brincar';
  }
}

function toggleItem(item) {
  state.items[item] = !state.items[item];
  saveState();
  render();
}

function playWithToy() {
  const remaining = TOY_COOLDOWN_MS - (Date.now() - state.lastToy);
  if (remaining > 0) return;
  applyElapsedDecay();
  state.fome = clamp(state.fome + TOY_GAIN);
  state.sono = clamp(state.sono + TOY_GAIN);
  state.higiene = clamp(state.higiene + TOY_GAIN);
  state.lastToy = Date.now();
  saveState();
  render();
  bounceCreature();
  showBubble('Que divertido! 🧸');
  burstSparkles();
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
  let gain = GAIN[stat];
  if (stat === 'sono' && state.items.travesseiro) {
    gain = gain * ITEM_EFFECTS.travesseiro.sonoGainMult;
  }
  state[stat] = clamp(state[stat] + gain);
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

// ---------- fazenda ----------

function unlockedCrops() {
  const days = ageDays();
  return Object.entries(CROPS)
    .filter(([, c]) => days >= c.unlockDay)
    .map(([id]) => id);
}

let pendingSlot = null; // índice do canteiro mostrando o seletor de plantio (não é salvo)

function renderFarm() {
  const unlocked = unlockedCrops();
  els.farmSub.textContent = unlocked.length > 1
    ? 'toque num canteiro vazio'
    : `próximo plantio libera no dia ${nextUnlockDay()}`;

  els.plots.innerHTML = state.farm.slots.map((slot, i) => plotMarkup(slot, i, unlocked)).join('');

  els.plots.querySelectorAll('[data-plant]').forEach(btn => {
    btn.addEventListener('click', () => plantSlot(Number(btn.dataset.slot), btn.dataset.plant));
  });
  els.plots.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingSlot = Number(btn.dataset.open);
      renderFarm();
    });
  });
  els.plots.querySelectorAll('[data-harvest]').forEach(btn => {
    btn.addEventListener('click', () => harvestSlot(Number(btn.dataset.harvest)));
  });

  renderInventory();
}

function nextUnlockDay() {
  const days = ageDays();
  const next = Object.values(CROPS).map(c => c.unlockDay).filter(d => d > days).sort((a, b) => a - b)[0];
  return next !== undefined ? Math.ceil(next) : '—';
}

function plotMarkup(slot, i, unlocked) {
  if (!slot.crop) {
    if (pendingSlot === i && unlocked.length > 0) {
      return `<div class="plot">
        <div class="plot-picker">
          ${unlocked.map(id => `<button data-slot="${i}" data-plant="${id}">${CROPS[id].icon}</button>`).join('')}
        </div>
      </div>`;
    }
    return `<button class="plot" data-open="${i}">
      <span class="plot-icon">+</span>
      <span class="plot-label">plantar</span>
    </button>`;
  }

  const crop = CROPS[slot.crop];
  const elapsed = Date.now() - slot.plantedAt;
  const ratio = Math.min(1, elapsed / crop.growMs);

  if (ratio >= 1) {
    return `<button class="plot ready" data-harvest="${i}">
      <span class="plot-icon">${crop.icon}</span>
      <span class="plot-label">colher</span>
    </button>`;
  }

  const remainMin = Math.ceil((crop.growMs - elapsed) / 60000);
  return `<div class="plot growing">
    <span class="plot-icon">${crop.icon}</span>
    <span class="plot-label">${remainMin < 60 ? remainMin + ' min' : Math.ceil(remainMin / 60) + ' h'}</span>
    <div class="plot-bar"><div class="plot-bar-fill" style="width:${Math.round(ratio * 100)}%"></div></div>
  </div>`;
}

function plantSlot(i, cropId) {
  state.farm.slots[i] = { crop: cropId, plantedAt: Date.now() };
  pendingSlot = null;
  saveState();
  renderFarm();
}

function harvestSlot(i) {
  const slot = state.farm.slots[i];
  if (!slot.crop) return;
  state.inventory[slot.crop] = (state.inventory[slot.crop] || 0) + 1;
  state.farm.slots[i] = { crop: null, plantedAt: null };
  saveState();
  renderFarm();
  showBubble(`Colheu ${CROPS[slot.crop].name}!`);
  burstSparkles();
}

function renderInventory() {
  const items = [
    ...Object.entries(state.inventory)
      .filter(([id, n]) => id !== 'peixe' && n > 0)
      .map(([id, n]) => ({ id, n, ...CROPS[id] })),
    ...(state.inventory.peixe > 0 ? [{ id: 'peixe', n: state.inventory.peixe, ...FISH_ITEM }] : []),
  ];

  if (items.length === 0) {
    els.inventory.innerHTML = `<span class="inv-empty">nada colhido ainda</span>`;
    return;
  }

  els.inventory.innerHTML = items.map(it => `
    <button class="inv-item" data-give="${it.id}">
      <span class="inv-icon">${it.icon}</span>
      <span class="inv-count">${it.n}</span>
    </button>
  `).join('');

  els.inventory.querySelectorAll('[data-give]').forEach(btn => {
    btn.addEventListener('click', () => giveFood(btn.dataset.give));
  });
}

function giveFood(id) {
  if (!state.inventory[id] || state.inventory[id] <= 0) return;
  applyElapsedDecay();
  const effect = id === 'peixe' ? FISH_ITEM.effect : CROPS[id].effect;
  for (const [stat, amount] of Object.entries(effect)) {
    state[stat] = clamp(state[stat] + amount);
  }
  state.inventory[id] -= 1;
  saveState();
  render();
  bounceCreature();
  showBubble('Que gostoso!');
  burstSparkles();
}

// ---------- conversar (via Worker/Groq) ----------

const WORKER_URL_KEY = 'lumeco-worker-url';
const SUMMARY_EVERY = 8; // a cada N mensagens do usuário, resume e enxuga o histórico
const HISTORY_KEEP_AFTER_SUMMARY = 6;
const HISTORY_MAX = 20;

function getWorkerUrl() {
  return localStorage.getItem(WORKER_URL_KEY) || '';
}

function setWorkerUrl(url) {
  localStorage.setItem(WORKER_URL_KEY, url);
}

function initChatUI() {
  const saved = getWorkerUrl();
  if (saved) {
    els.chatSetup.classList.add('hidden');
    els.chatBox.classList.remove('hidden');
    els.chatSub.textContent = 'ele responde do jeito dele';
    renderChatLog();
  } else {
    els.chatSetup.classList.remove('hidden');
    els.chatBox.classList.add('hidden');
    els.chatSub.textContent = 'configure o servidor';
  }
}

function saveWorkerUrlFromInput() {
  const url = els.workerUrlInput.value.trim();
  if (!url) return;
  setWorkerUrl(url);
  initChatUI();
}

function reconfigureWorker() {
  els.workerUrlInput.value = getWorkerUrl();
  els.chatBox.classList.add('hidden');
  els.chatSetup.classList.remove('hidden');
  els.chatSub.textContent = 'configure o servidor';
}

function renderChatLog() {
  els.chatLog.innerHTML = state.chat.history.map(m => `
    <div class="chat-msg ${m.role}">${escapeHtml(m.content)}</div>
  `).join('');
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function currentPetStateSummary() {
  const stage = currentStage();
  return {
    name: 'Lumeco',
    stage: stage.name,
    day: Math.floor(ageDays()),
    fome: Math.round(state.fome),
    sono: Math.round(state.sono),
    higiene: Math.round(state.higiene),
    brilho: brilho(),
    memory: state.chat.memory,
  };
}

async function sendChatMessage() {
  const text = els.chatInput.value.trim();
  const workerUrl = getWorkerUrl();
  if (!text || !workerUrl) return;

  state.chat.history.push({ role: 'user', content: text });
  state.chat.msgCount += 1;
  els.chatInput.value = '';
  els.btnSendChat.disabled = true;
  renderChatLog();
  saveState();

  // bolha "pensando" temporária, não vai pro histórico salvo
  const pending = document.createElement('div');
  pending.className = 'chat-msg assistant pending';
  pending.textContent = '...';
  els.chatLog.appendChild(pending);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat',
        messages: state.chat.history,
        petState: currentPetStateSummary(),
      }),
    });
    const data = await res.json();
    const reply = data.reply || 'Hmm... (não consegui pensar em nada agora)';

    state.chat.history.push({ role: 'assistant', content: reply });
    trimHistory();
    saveState();
    renderChatLog();
    bounceCreature();
    burstSparkles();

    if (state.chat.msgCount % SUMMARY_EVERY === 0) {
      updateChatMemory();
    }
  } catch (err) {
    pending.remove();
    els.chatLog.insertAdjacentHTML('beforeend', `<div class="chat-msg assistant">(sem conexão com o servidor agora — tenta de novo)</div>`);
  } finally {
    els.btnSendChat.disabled = false;
  }
}

function trimHistory() {
  if (state.chat.history.length > HISTORY_MAX) {
    state.chat.history = state.chat.history.slice(-HISTORY_MAX);
  }
}

async function updateChatMemory() {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) return;
  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'summary', messages: state.chat.history }),
    });
    const data = await res.json();
    if (data.reply) {
      state.chat.memory = data.reply;
      // depois de resumir, enxuga o histórico bruto pra não crescer sem parar
      state.chat.history = state.chat.history.slice(-HISTORY_KEEP_AFTER_SUMMARY);
      saveState();
    }
  } catch (err) {
    // silencioso — só tenta de novo no próximo ciclo
  }
}

// ---------- cozinha ----------

const selectedIngredients = new Set(); // ephemeral, não persiste
let pendingRecipeKey = null;
let pendingIngredientIds = null;

function availableIngredientsList() {
  const list = [];
  for (const [id, n] of Object.entries(state.inventory)) {
    if (n > 0) {
      const cfg = id === 'peixe' ? FISH_ITEM : CROPS[id];
      list.push({ id, n, icon: cfg.icon, name: cfg.name });
    }
  }
  return list;
}

function toggleIngredient(id) {
  if (selectedIngredients.has(id)) {
    selectedIngredients.delete(id);
  } else {
    if (selectedIngredients.size >= 3) return;
    selectedIngredients.add(id);
  }
  renderKitchen();
}

function recipeKeyFor(ids) {
  return ids.slice().sort().join('+');
}

function consumeIngredients(ids) {
  for (const id of ids) {
    state.inventory[id] = Math.max(0, (state.inventory[id] || 0) - 1);
  }
}

function tryCook() {
  const ids = Array.from(selectedIngredients);
  if (ids.length < 2) return;
  const key = recipeKeyFor(ids);

  if (state.recipes[key]) {
    consumeIngredients(ids);
    state.dishInventory[key] = (state.dishInventory[key] || 0) + 1;
    selectedIngredients.clear();
    saveState();
    renderKitchen();
    showBubble(`Preparou ${state.recipes[key].name}!`);
    burstSparkles();
  } else {
    pendingRecipeKey = key;
    pendingIngredientIds = ids;
    els.namingBox.classList.remove('hidden');
    els.dishNameInput.value = '';
    els.dishNameInput.focus();
  }
}

function confirmDishName() {
  const name = els.dishNameInput.value.trim();
  if (!name || !pendingRecipeKey) return;

  consumeIngredients(pendingIngredientIds);
  state.recipes[pendingRecipeKey] = { name, icon: '🍲' };
  state.dishInventory[pendingRecipeKey] = (state.dishInventory[pendingRecipeKey] || 0) + 1;

  selectedIngredients.clear();
  cancelNaming();
  saveState();
  renderKitchen();
  showBubble(`Criou o prato "${name}"!`);
  burstSparkles();
}

function cancelNaming() {
  pendingRecipeKey = null;
  pendingIngredientIds = null;
  els.namingBox.classList.add('hidden');
}

function dishEffect(key) {
  const ids = key.split('+');
  const effect = {};
  for (const id of ids) {
    const base = id === 'peixe' ? FISH_ITEM.effect : CROPS[id].effect;
    for (const [stat, val] of Object.entries(base)) {
      effect[stat] = (effect[stat] || 0) + val;
    }
  }
  for (const stat of Object.keys(effect)) {
    effect[stat] = Math.round(effect[stat] * 1.3); // prato cozido rende mais que os ingredientes crus
  }
  return effect;
}

function giveDish(key) {
  if (!state.dishInventory[key] || state.dishInventory[key] <= 0) return;
  applyElapsedDecay();
  const effect = dishEffect(key);
  for (const [stat, amount] of Object.entries(effect)) {
    state[stat] = clamp(state[stat] + amount);
  }
  state.dishInventory[key] -= 1;
  saveState();
  render();
  bounceCreature();
  showBubble(`${state.recipes[key].name} — delícia especial!`);
  burstSparkles();
}

function renderKitchen() {
  const avail = availableIngredientsList();

  if (avail.length === 0) {
    els.ingredients.innerHTML = `<span class="inv-empty">colha ou pesque algo primeiro</span>`;
  } else {
    els.ingredients.innerHTML = avail.map(it => `
      <button class="ing-chip ${selectedIngredients.has(it.id) ? 'on' : ''}" data-ing="${it.id}">
        <span class="inv-icon">${it.icon}</span>
        <span class="inv-count">${it.n}</span>
      </button>
    `).join('');
    els.ingredients.querySelectorAll('[data-ing]').forEach(btn => {
      btn.addEventListener('click', () => toggleIngredient(btn.dataset.ing));
    });
  }

  els.btnCook.disabled = selectedIngredients.size < 2;

  renderDishes();
}

function renderDishes() {
  const keys = Object.keys(state.dishInventory).filter(k => state.dishInventory[k] > 0);
  if (keys.length === 0) {
    els.dishes.innerHTML = '';
    return;
  }
  els.dishes.innerHTML = keys.map(k => `
    <button class="inv-item" data-give-dish="${k}">
      <span class="inv-icon">${state.recipes[k].icon}</span>
      <span class="inv-count">${state.dishInventory[k]}</span>
      <span class="dish-name">${state.recipes[k].name}</span>
    </button>
  `).join('');
  els.dishes.querySelectorAll('[data-give-dish]').forEach(btn => {
    btn.addEventListener('click', () => giveDish(btn.dataset.giveDish));
  });
}

// ---------- pesca ----------

let fishSessionStart = null;
let fishAnimTimer = null;

function startFishing() {
  fishSessionStart = Date.now();
  els.fishGame.classList.remove('hidden');
  els.btnFish.style.display = 'none';
  els.pondMsg.textContent = 'Toque em "Fisgar!" quando o marcador passar pela área clara.';
}

function attemptCatch() {
  const elapsed = (Date.now() - fishSessionStart) % FISH_CYCLE_MS;
  const half = FISH_CYCLE_MS / 2;
  // replica o progresso ping-pong da animação (0 -> 1 -> 0) usado no CSS
  const progress = elapsed < half ? elapsed / half : 1 - (elapsed - half) / half;

  const success = progress >= FISH_ZONE.start && progress <= FISH_ZONE.end;

  els.fishGame.classList.add('hidden');
  els.btnFish.style.display = '';

  if (success) {
    state.inventory.peixe += 1;
    saveState();
    renderFarm();
    els.pondMsg.textContent = 'Fisgou um peixinho! 🐟';
    burstSparkles();
  } else {
    els.pondMsg.textContent = 'Escapou... tenta de novo.';
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

els.itemCobertor.addEventListener('click', () => toggleItem('cobertor'));
els.itemTravesseiro.addEventListener('click', () => toggleItem('travesseiro'));
els.itemBrinquedo.addEventListener('click', () => toggleItem('brinquedo'));
els.toyBtn.addEventListener('click', playWithToy);
els.btnFish.addEventListener('click', startFishing);
els.btnCatch.addEventListener('click', attemptCatch);
els.btnCook.addEventListener('click', tryCook);
els.btnConfirmName.addEventListener('click', confirmDishName);
els.btnCancelName.addEventListener('click', cancelNaming);
els.dishNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmDishName();
});
els.btnSaveWorker.addEventListener('click', saveWorkerUrlFromInput);
els.btnReconfigWorker.addEventListener('click', reconfigureWorker);
els.btnSendChat.addEventListener('click', sendChatMessage);
els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

applyElapsedDecay();
saveState();
render();
initChatUI();
setInterval(tick, TICK_MS);

// recalcula ao voltar para a aba, para refletir o tempo que passou
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    applyElapsedDecay();
    saveState();
    render();
  }
});
