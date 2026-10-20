// Valida o manifest.webmanifest e os ícones do app (rosto do Jarbas como símbolo):
// JSON válido, todo caminho de ícone referenciado existe de verdade em disco, e o
// tamanho real de cada PNG bate com o "sizes" declarado — sem depender de nenhuma
// lib de imagem (lê só o cabeçalho IHDR do PNG, que é padrão e fixo).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${filePath}: assinatura PNG`);
  // IHDR é sempre o primeiro chunk: 8 bytes de assinatura + 4 (length) + 4 ("IHDR") +
  // 4 (width) + 4 (height) big-endian.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ---------- manifest.webmanifest: JSON válido ----------
const manifestPath = path.join(__dirname, "manifest.webmanifest");
assert.ok(fs.existsSync(manifestPath), "manifest.webmanifest existe");
const manifestRaw = fs.readFileSync(manifestPath, "utf8");
let manifest;
assert.doesNotThrow(() => { manifest = JSON.parse(manifestRaw); }, "manifest.webmanifest é JSON válido");
console.log("manifest.webmanifest: JSON válido: OK");

// ---------- campos obrigatórios do manifest ----------
{
  assert.equal(manifest.name, "Jarbas — Companheiro de Voz");
  assert.equal(manifest.short_name, "Jarbas");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#050709");
  assert.equal(manifest.theme_color, "#050709");
  assert.equal(manifest.lang, "pt-BR");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3, "manifest tem pelo menos 3 ícones");
}
console.log("manifest.webmanifest: campos obrigatórios: OK");

// ---------- cada ícone do manifest existe e tem o tamanho real declarado ----------
{
  const porPurpose = {};
  for (const icon of manifest.icons) {
    assert.ok(icon.src && icon.sizes && icon.type, "ícone do manifest tem src/sizes/type");
    assert.ok(!icon.src.startsWith("/"), `${icon.src}: caminho deve ser relativo (sem "/" na frente), pro subcaminho do GitHub Pages`);
    const iconPath = path.join(__dirname, icon.src);
    assert.ok(fs.existsSync(iconPath), `${icon.src}: arquivo existe em companion/`);
    const [wDecl, hDecl] = icon.sizes.split("x").map(Number);
    const { width, height } = pngDimensions(iconPath);
    assert.equal(width, wDecl, `${icon.src}: largura real bate com "sizes"`);
    assert.equal(height, hDecl, `${icon.src}: altura real bate com "sizes"`);
    assert.equal(width, height, `${icon.src}: ícone é quadrado`);
    porPurpose[icon.purpose || "any"] = (porPurpose[icon.purpose || "any"] || 0) + 1;
  }
  assert.ok(porPurpose.any >= 2, "tem pelo menos 2 ícones purpose=any (192 e 512)");
  assert.ok(porPurpose.maskable >= 1, "tem pelo menos 1 ícone purpose=maskable");
}
console.log("manifest.webmanifest: ícones existem e batem com os tamanhos declarados: OK");

// ---------- ícones usados no <head> do index.html (favicons, apple-touch-icon) ----------
{
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const headEnd = html.indexOf("</head>");
  const head = html.slice(0, headEnd);

  assert.ok(head.includes('rel="manifest" href="manifest.webmanifest"'), "head referencia o manifest (caminho relativo)");
  assert.ok(head.includes('<meta name="theme-color" content="#050709">'), "head tem theme-color");
  assert.ok(head.includes('apple-mobile-web-app-capable" content="yes"'), "head tem apple-mobile-web-app-capable");

  const esperados = [
    { re: /rel="icon" type="image\/png" sizes="32x32" href="(icons\/favicon-32\.png)"/, sizes: [32, 32] },
    { re: /rel="icon" type="image\/png" sizes="64x64" href="(icons\/favicon-64\.png)"/, sizes: [64, 64] },
    { re: /rel="apple-touch-icon" href="(icons\/apple-touch-icon\.png)"/, sizes: [180, 180] },
  ];
  for (const { re, sizes } of esperados) {
    const m = head.match(re);
    assert.ok(m, `head referencia ${re}`);
    const href = m[1];
    assert.ok(!href.startsWith("/"), `${href}: caminho deve ser relativo`);
    const filePath = path.join(__dirname, href);
    assert.ok(fs.existsSync(filePath), `${href}: arquivo existe`);
    const { width, height } = pngDimensions(filePath);
    assert.deepEqual([width, height], sizes, `${href}: tamanho real bate com o esperado`);
  }
}
console.log("index.html <head>: favicons e apple-touch-icon existem e batem com o esperado: OK");

// ---------- badge usado no sw.js (push notifications) ----------
{
  const sw = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
  assert.ok(sw.includes("icons/icon-192.png"), "sw.js usa icons/icon-192.png como icon da notificação");
  assert.ok(sw.includes("icons/badge-96.png"), "sw.js usa icons/badge-96.png como badge da notificação");
  assert.ok(sw.includes("self.registration.scope"), "sw.js resolve os ícones a partir do escopo do service worker");

  const badgePath = path.join(__dirname, "icons", "badge-96.png");
  assert.ok(fs.existsSync(badgePath), "icons/badge-96.png existe");
  const { width, height } = pngDimensions(badgePath);
  assert.deepEqual([width, height], [96, 96], "icons/badge-96.png é 96x96");
}
console.log("sw.js: icon/badge da notificação existem: OK");

console.log("_icones-manifest.test.mjs: todos os testes passaram");
