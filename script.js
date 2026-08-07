/* =========================================================
   Raiz — árvore de estimação
   Crescimento infinito: rega + conversa fazem a árvore crescer.
   Cada semente gera uma espécie única (folha, cor, personalidade).
   ========================================================= */

const STORAGE_KEY = 'raiz-state-v1';
const TICK_MS = 15000;

// ---------- genoma / espécies ----------

const LEAF_SHAPES = ['redonda', 'coracao', 'agulha', 'leque'];

const PALETTES = [
  { id: 'salvia',    leaf: '#8fae86', leafDark: '#6f8f68', flower: null,      name: 'Sálvia Serena',      mood: 'calma e serena',              weight: 19 },
  { id: 'cerejeira', leaf: '#f3b6c9', leafDark: '#e08fab', flower: '#ffffff', name: 'Flor-de-Cerejeira',   mood: 'doce e carinhosa',            weight: 19 },
  { id: 'outono',    leaf: '#d98d3f', leafDark: '#b8702a', flower: null,      name: 'Dourada do Outono',   mood: 'sábia e um pouco nostálgica', weight: 19 },
  { id: 'esmeralda', leaf: '#3f8f6b', leafDark: '#276b4f', flower: null,      name: 'Esmeralda Firme',     mood: 'firme e protetora',           weight: 19 },
  { id: 'lavanda',   leaf: '#b6a6e0', leafDark: '#9483c9', flower: '#d8cdf0', name: 'Lavanda Sonhadora',   mood: 'sonhadora e curiosa',         weight: 19 },
  { id: 'prisma',    leaf: '#e8a9d8', leafDark: '#8fa9e0', flower: '#ffe38a', name: 'Prisma (rara!)',      mood: 'rara e cheia de surpresas',   weight: 5  },
];

const TRUNK_STYLES = ['reto', 'tortuoso'];

function pickPalette() {
  const total = PALETTES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of PALETTES) {
    if (r < p.weight) return p.id;
    r -= p.weight;
  }
  return PALETTES[0].id;
}

function randomGenome() {
  return {
    leafShape: LEAF_SHAPES[Math.floor(Math.random() * LEAF_SHAPES.length)],
    palette: pickPalette(),
    trunk: TRUNK_STYLES[Math.floor(Math.random() * TRUNK_STYLES.length)],
    seed: Math.floor(Math.random() * 100000),
  };
}

function paletteOf(genome) {
  return PALETTES.find(p => p.id === genome.palette) || PALETTES[0];
}

// ---------- estágios ----------

const STAGES = [
  { id: 0, name: 'Semente',           minGrowth: 0 },
  { id: 1, name: 'Semente brotando',  minGrowth: 8 },
  { id: 2, name: 'Broto',             minGrowth: 30 },
  { id: 3, name: 'Muda',              minGrowth: 100 },
  { id: 4, name: 'Árvore jovem',      minGrowth: 300 },
  { id: 5, name: 'Árvore adulta',     minGrowth: 800 },
];

function currentStage() {
  let stage = STAGES[0];
  for (const s of STAGES) {
    if (state.growth >= s.minGrowth) stage = s;
  }
  return stage;
}

function metros() {
  return state.growth / 60;
}

function formatHeight(m) {
  if (m < 1) return Math.round(m * 100) + ' cm';
  return m.toFixed(1).replace('.', ',') + ' m';
}

function equivalenciaFor(m) {
  if (m < 0.05) return '';
  if (m < 0.3) return 'do tamanho de uma muda de vaso';
  if (m < 1.5) return 'quase da sua altura';
  if (m < 3) return 'equivalente a um andar de prédio';
  if (m < 6) return 'equivalente a uma casa de dois andares';
  if (m < 12) return 'equivalente a um prédio de 3-4 andares';
  if (m < 25) return 'equivalente a um prédio de 8 andares';
  if (m < 45) return 'do tamanho de uma sequoia jovem';
  return 'mais alta que a maioria dos prédios da sua cidade';
}

// ---------- economia de crescimento ----------

const DECAY_AGUA_PER_MIN = 100 / (14 * 60); // esvazia em ~14h
const WATER_GAIN = 35;
const GROWTH_PER_WATER = 12;
const GROWTH_TRICKLE_PER_MIN = 0.12; // cresce sozinha aos poucos, mesmo offline
const GROWTH_PER_CHAT_MSG = 3;
const CHAT_GROWTH_DAILY_CAP = 10;

// ---------- elementos ----------

const els = {
  brandName: document.getElementById('brandName'),
  stageLabel: document.getElementById('stageLabel'),
  heightLabel: document.getElementById('heightLabel'),
  garden: document.getElementById('garden'),
  sky: document.getElementById('sky'),
  treeSvg: document.getElementById('treeSvg'),
  bubble: document.getElementById('speechBubble'),
  sparkles: document.getElementById('sparkles'),
  hint: document.getElementById('hint'),
  equivalence: document.getElementById('equivalence'),
  birthCard: document.getElementById('birthCard'),
  birthSpecies: document.getElementById('birthSpecies'),
  treeNameInput: document.getElementById('treeNameInput'),
  btnConfirmTreeName: document.getElementById('btnConfirmTreeName'),
  btnWater: document.getElementById('btnWater'),
  valAgua: document.getElementById('valAgua'),
  valCrescimento: document.getElementById('valCrescimento'),
  barAgua: document.getElementById('barAgua'),
  barCrescimento: document.getElementById('barCrescimento'),
  btnReset: document.getElementById('btnReset'),
  chatSub: document.getElementById('chatSub'),
  chatLocked: document.getElementById('chatLocked'),
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

function freshState() {
  const now = Date.now();
  return {
    born: now,
    lastTick: now,
    agua: 80,
    growth: 0,
    tree: {
      name: null,
      genome: randomGenome(),
    },
    chat: { history: [], memory: '', msgCount: 0, dayKey: '', dayCount: 0 },
  };
}

function withDefaults(s) {
  if (typeof s.agua !== 'number') s.agua = 80;
  if (typeof s.growth !== 'number') s.growth = 0;
  if (!s.tree) s.tree = { name: null, genome: randomGenome() };
  if (!s.tree.genome) s.tree.genome = randomGenome();
  if (!s.chat) s.chat = { history: [], memory: '', msgCount: 0, dayKey: '', dayCount: 0 };
  if (!Array.isArray(s.chat.history)) s.chat.history = [];
  if (typeof s.chat.memory !== 'string') s.chat.memory = '';
  if (typeof s.chat.msgCount !== 'number') s.chat.msgCount = 0;
  if (typeof s.chat.dayKey !== 'string') s.chat.dayKey = '';
  if (typeof s.chat.dayCount !== 'number') s.chat.dayCount = 0;
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return withDefaults(JSON.parse(raw));
  } catch (e) { /* ignora storage corrompido */ }
  return freshState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clamp(v) {
  return Math.max(0, Math.min(100, v));
}

let state = loadState();

// ---------- simulação de tempo ----------

function applyElapsedDecay() {
  const now = Date.now();
  const minutes = (now - state.lastTick) / 60000;
  if (minutes <= 0) return;

  state.agua = clamp(state.agua - DECAY_AGUA_PER_MIN * minutes);
  state.growth += GROWTH_TRICKLE_PER_MIN * minutes;
  state.lastTick = now;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function timeBucket() {
  const h = new Date().getHours();
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 19.5) return 'dusk';
  return 'night';
}

// ---------- render ----------

function render() {
  const stage = currentStage();
  const m = metros();

  els.stageLabel.textContent = stage.name;
  els.heightLabel.textContent = formatHeight(m);
  els.brandName.textContent = state.tree.name || 'Sua semente';
  els.equivalence.textContent = equivalenciaFor(m);

  setValue(els.valAgua, els.barAgua, state.agua);
  els.valCrescimento.textContent = Math.round(state.growth);
  els.barCrescimento.style.width = Math.min(100, (state.growth % 500) / 5) + '%';

  els.btnWater.disabled = state.agua >= 99;

  const bucket = timeBucket();
  els.sky.className = 'sky ' + bucket;

  renderTree(stage, m, bucket);
  renderHint(stage);
  renderBirthCard(stage);
  renderChatGate(stage);
}

function setValue(valueEl, barEl, v) {
  const rounded = Math.round(v);
  valueEl.textContent = rounded;
  barEl.style.width = rounded + '%';
  barEl.style.background = rounded < 25 ? 'var(--danger)' : rounded < 55 ? 'var(--amber)' : 'var(--sage)';
}

function renderHint(stage) {
  if (stage.id === 0) els.hint.textContent = 'Regue todo dia pra sua semente brotar.';
  else if (stage.id === 1) els.hint.textContent = 'Quase lá... continue regando.';
  else if (stage.id === 2) els.hint.textContent = 'Ela nasceu! Continue regando e converse com ela.';
  else if (state.agua < 30) els.hint.textContent = 'As folhas estão murchando — hora de regar.';
  else els.hint.textContent = 'Ela está crescendo bem.';
}

function renderBirthCard(stage) {
  if (stage.id >= 2 && !state.tree.name) {
    const palette = paletteOf(state.tree.genome);
    els.birthCard.classList.remove('hidden');
    els.birthSpecies.textContent = `Espécie: ${palette.name}`;
  } else {
    els.birthCard.classList.add('hidden');
  }
}

function renderChatGate(stage) {
  const unlocked = stage.id >= 2;
  els.chatLocked.classList.toggle('hidden', unlocked);
  if (!unlocked) {
    els.chatSetup.classList.add('hidden');
    els.chatBox.classList.add('hidden');
    els.chatSub.textContent = 'bloqueado';
  } else {
    els.chatSub.textContent = getWorkerUrl() ? 'ela responde do jeito dela' : 'configure o servidor';
    initChatUI();
  }
}

// ---------- árvore procedural (SVG) ----------

function renderTree(stage, m, bucket) {
  const genome = state.tree.genome;
  const palette = paletteOf(genome);
  els.treeSvg.innerHTML = treeMarkup(genome, palette, stage.id, state.growth, bucket);
}

function treeMarkup(genome, palette, stageId, growth, bucket) {
  if (stageId === 0) return seedMarkup();
  if (stageId === 1) return sproutMarkup(palette);

  const stageScale = { 2: 0.28, 3: 0.48, 4: 0.72, 5: 1.0 }[stageId] || 1.0;
  const extraScale = 1 + Math.log10(1 + Math.max(0, growth - 800) / 800) * 0.35;
  const scale = stageId >= 5 ? Math.min(1.65, extraScale) : stageScale;

  const baseY = 196;
  const trunkH = 90 * scale;
  const topY = baseY - trunkH;
  const trunk = genome.trunk === 'tortuoso' ? wavyTrunk(baseY, topY, scale) : straightTrunk(baseY, topY, scale);
  const canopy = renderCanopy(genome, palette, 100, topY, scale);
  const decor = renderDecorations(growth, palette, bucket, 100, topY, scale);

  return `${trunk}${canopy}${decor}`;
}

function seedMarkup() {
  return `
    <ellipse cx="100" cy="199" rx="15" ry="7" fill="#6b4a34" opacity="0.5"/>
    <ellipse cx="100" cy="195" rx="10" ry="7" fill="#8a6a4a"/>
    <ellipse cx="97" cy="192" rx="3" ry="2" fill="#a9825c" opacity="0.7"/>
  `;
}

function sproutMarkup(palette) {
  return `
    ${seedMarkup()}
    <path d="M100 195 Q97 178 107 168" stroke="${palette.leaf}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    <ellipse cx="108" cy="166" rx="7" ry="4.5" fill="${palette.leaf}" transform="rotate(-25 108 166)"/>
  `;
}

function straightTrunk(baseY, topY, scale) {
  const w = 5 + 3 * scale;
  return `<rect x="${100 - w / 2}" y="${topY}" width="${w}" height="${baseY - topY}" rx="${w / 2}" fill="#8a6a4a"/>`;
}

function wavyTrunk(baseY, topY, scale) {
  const w = 5 + 3 * scale;
  const midY = (baseY + topY) / 2;
  return `<path d="M${100 - w / 2} ${baseY}
    C ${100 - w / 2 - 10} ${midY + 15}, ${100 + w / 2 + 8} ${midY - 10}, ${100} ${topY}
    C ${100 - w / 2} ${topY}, ${100 - w / 2} ${topY}, ${100 - w / 2} ${topY}
    L ${100 + w / 2} ${topY}
    C ${100 + w / 2 + 8} ${midY - 10}, ${100 - w / 2 - 10} ${midY + 15}, ${100 + w / 2} ${baseY} Z"
    fill="#8a6a4a"/>`;
}

// gerador pseudo-aleatório determinístico simples, a partir do genoma.seed
function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function renderCanopy(genome, palette, cx, topY, scale) {
  const rng = seededRand(genome.seed);
  const R = 28 * scale + 14;
  let blobs = '';

  if (genome.leafShape === 'redonda') {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.4;
      const d = R * 0.42 * (0.7 + rng() * 0.5);
      const x = cx + Math.cos(a) * d;
      const y = topY - R * 0.15 + Math.sin(a) * d * 0.7;
      const r = R * (0.4 + rng() * 0.22);
      blobs += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${i % 2 ? palette.leafDark : palette.leaf}" opacity="0.94"/>`;
    }
    blobs += `<circle cx="${cx}" cy="${(topY - R * 0.25).toFixed(1)}" r="${(R * 0.5).toFixed(1)}" fill="${palette.leaf}"/>`;
  } else if (genome.leafShape === 'agulha') {
    const layers = 4;
    for (let i = 0; i < layers; i++) {
      const w = R * (1.1 - i * 0.2);
      const y = topY + i * (R * 0.42) - R * 0.35;
      blobs += `<path d="M${cx} ${y - R * 0.42} L${cx - w / 2} ${y} L${cx + w / 2} ${y} Z" fill="${i % 2 ? palette.leafDark : palette.leaf}"/>`;
    }
  } else if (genome.leafShape === 'leque') {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / (n - 1)) * Math.PI;
      const d = R * 0.85;
      const x = cx + Math.cos(a) * d;
      const y = topY + Math.sin(a) * d * 0.6;
      blobs += `<path d="M${cx} ${topY} Q${(cx + x) / 2} ${(topY + y) / 2 - 8} ${x.toFixed(1)} ${y.toFixed(1)}
        Q${(cx + x) / 2} ${(topY + y) / 2 + 8} ${cx} ${topY} Z"
        fill="${i % 2 ? palette.leafDark : palette.leaf}" opacity="0.9"/>`;
    }
  } else { // coracao
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const d = R * 0.45 * (0.7 + rng() * 0.5);
      const x = cx + Math.cos(a) * d;
      const y = topY - R * 0.1 + Math.sin(a) * d * 0.7;
      const s = R * (0.28 + rng() * 0.14);
      blobs += `<path d="M${x} ${y - s}
        C ${x - s} ${y - s * 1.6}, ${x - s * 1.7} ${y + s * 0.3}, ${x} ${y + s * 1.3}
        C ${x + s * 1.7} ${y + s * 0.3}, ${x + s} ${y - s * 1.6}, ${x} ${y - s} Z"
        fill="${i % 2 ? palette.leafDark : palette.leaf}" opacity="0.94"/>`;
    }
  }

  if (palette.flower) {
    const nf = 4;
    for (let i = 0; i < nf; i++) {
      const a = rng() * Math.PI * 2;
      const d = R * (0.3 + rng() * 0.5);
      const x = cx + Math.cos(a) * d;
      const y = topY - R * 0.15 + Math.sin(a) * d * 0.7;
      blobs += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${palette.flower}"/>`;
    }
  }

  return blobs;
}

function renderDecorations(growth, palette, bucket, cx, topY, scale) {
  let out = '';
  const R = 28 * scale + 14;

  if (growth >= 1600) { // musgo no tronco
    out += `<ellipse cx="${cx - 4}" cy="192" rx="7" ry="4" fill="#6f8f5a" opacity="0.8"/>`;
    out += `<ellipse cx="${cx + 5}" cy="188" rx="5" ry="3" fill="#7fa06a" opacity="0.7"/>`;
  }
  if (growth >= 2000) { // ninho
    const nx = cx + R * 0.5, ny = topY + 2;
    out += `<ellipse cx="${nx}" cy="${ny}" rx="10" ry="6" fill="#7a5236"/>`;
    out += `<circle cx="${nx - 3}" cy="${ny - 2}" r="2.4" fill="#e0dccb"/>`;
    out += `<circle cx="${nx + 3}" cy="${ny - 2}" r="2.4" fill="#e0dccb"/>`;
  }
  if (growth >= 2400 && (bucket === 'night' || bucket === 'dusk')) { // vagalumes
    const rng = seededRand(Math.floor(growth));
    for (let i = 0; i < 5; i++) {
      const x = cx + (rng() - 0.5) * R * 2.2;
      const y = topY + (rng() - 0.5) * R * 1.6;
      out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="#ffe38a" opacity="0.9">
        <animate attributeName="opacity" values="0.2;1;0.2" dur="${(2 + rng() * 2).toFixed(1)}s" repeatCount="indefinite"/>
      </circle>`;
    }
  }
  return out;
}

// ---------- interações ----------

function bounceTree() {
  els.treeSvg.classList.remove('bounce');
  void els.treeSvg.offsetWidth;
  els.treeSvg.classList.add('bounce');
}

let bubbleTimeout;
function showBubble(text, opts = {}) {
  const { duration = 1600, long = false } = opts;
  els.bubble.textContent = text;
  els.bubble.classList.toggle('bubble-long', long);
  els.bubble.classList.add('show');
  clearTimeout(bubbleTimeout);
  bubbleTimeout = setTimeout(() => els.bubble.classList.remove('show'), duration);
}

function burstSparkles() {
  const container = els.sparkles;
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.textContent = '✦';
    s.style.left = (40 + Math.random() * 20) + '%';
    s.style.bottom = (30 + Math.random() * 10) + '%';
    s.style.animationDelay = (i * 60) + 'ms';
    container.appendChild(s);
    setTimeout(() => s.remove(), 1300 + i * 60);
  }
}

const POKE_MESSAGES = {
  seco: ['Estou com sede...', 'Preciso de água.', 'Sinto minhas folhas murchando.'],
  ok: ['Que bom te ver!', 'Isso faz cócegas nas folhas!', 'Oi!'],
  bem: ['Estou tão bem hoje!', 'Sinto o sol nas folhas.', '✨'],
};

let lastPoke = 0;
function pokeTree() {
  const now = Date.now();
  if (now - lastPoke < 500) return;
  lastPoke = now;
  bounceTree();
  const mood = state.agua < 30 ? 'seco' : state.agua < 65 ? 'ok' : 'bem';
  const list = POKE_MESSAGES[mood];
  showBubble(list[Math.floor(Math.random() * list.length)]);
  burstSparkles();
}

function waterTree() {
  applyElapsedDecay();
  state.agua = clamp(state.agua + WATER_GAIN);
  state.growth += GROWTH_PER_WATER;
  saveState();
  render();
  bounceTree();
  showBubble('Ah, que alívio!');
  burstSparkles();
}

function confirmTreeName() {
  const name = els.treeNameInput.value.trim();
  if (!name) return;
  state.tree.name = name;
  saveState();
  render();
}

function resetAll() {
  if (!confirm('Recomeçar do zero? Isso apaga sua árvore atual.')) return;
  state = freshState();
  saveState();
  render();
}

// ---------- conversar (via Worker/Groq) ----------

const WORKER_URL_KEY = 'raiz-worker-url';
const SUMMARY_EVERY = 8;
const HISTORY_KEEP_AFTER_SUMMARY = 6;
const HISTORY_MAX = 20;

function getWorkerUrl() {
  return localStorage.getItem(WORKER_URL_KEY) || '';
}

function setWorkerUrl(url) {
  localStorage.setItem(WORKER_URL_KEY, url);
}

let chatUIInited = false;
function initChatUI() {
  const saved = getWorkerUrl();
  if (saved) {
    els.chatSetup.classList.add('hidden');
    els.chatBox.classList.remove('hidden');
    renderChatLog();
  } else {
    els.chatSetup.classList.remove('hidden');
    els.chatBox.classList.add('hidden');
  }
  chatUIInited = true;
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

function currentTreeStateSummary() {
  const stage = currentStage();
  const palette = paletteOf(state.tree.genome);
  return {
    name: state.tree.name || 'a árvore',
    stage: stage.name,
    metros: formatHeight(metros()),
    mood: palette.mood,
    memory: state.chat.memory,
  };
}

function ensureChatDay() {
  const today = todayKey();
  if (state.chat.dayKey !== today) {
    state.chat.dayKey = today;
    state.chat.dayCount = 0;
  }
}

async function sendChatMessage() {
  const text = els.chatInput.value.trim();
  const workerUrl = getWorkerUrl();
  if (!text || !workerUrl) return;

  state.chat.history.push({ role: 'user', content: text });
  state.chat.msgCount += 1;

  ensureChatDay();
  if (state.chat.dayCount < CHAT_GROWTH_DAILY_CAP) {
    state.growth += GROWTH_PER_CHAT_MSG;
    state.chat.dayCount += 1;
  }

  els.chatInput.value = '';
  els.btnSendChat.disabled = true;
  renderChatLog();
  saveState();

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
        petState: currentTreeStateSummary(),
      }),
    });
    const data = await res.json();
    const reply = data.reply || 'Hmm... (não consegui pensar em nada agora)';

    state.chat.history.push({ role: 'assistant', content: reply });
    trimHistory();
    saveState();
    render();
    renderChatLog();
    bounceTree();
    showBubble(reply, { duration: 4200, long: true });
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
      state.chat.history = state.chat.history.slice(-HISTORY_KEEP_AFTER_SUMMARY);
      saveState();
    }
  } catch (err) { /* tenta de novo no próximo ciclo */ }
}

// ---------- ciclo de vida ----------

function tick() {
  applyElapsedDecay();
  saveState();
  render();
}

els.btnWater.addEventListener('click', waterTree);
els.treeSvg.addEventListener('click', pokeTree);
els.btnConfirmTreeName.addEventListener('click', confirmTreeName);
els.treeNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmTreeName(); });
els.btnReset.addEventListener('click', resetAll);
els.btnSaveWorker.addEventListener('click', saveWorkerUrlFromInput);
els.btnReconfigWorker.addEventListener('click', reconfigureWorker);
els.btnSendChat.addEventListener('click', sendChatMessage);
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

applyElapsedDecay();
saveState();
render();
setInterval(tick, TICK_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    applyElapsedDecay();
    saveState();
    render();
  }
});
