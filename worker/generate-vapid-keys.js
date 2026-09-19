/**
 * Gera um par de chaves VAPID (P-256) pra notificações push do Jarbas.
 * Roda local, uma vez só — as chaves NUNCA passam pelo Git nem pelo Worker
 * até você mesmo colar no `wrangler secret put`.
 *
 * Uso:
 *   node generate-vapid-keys.js
 */
const { webcrypto } = require("crypto");

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

(async () => {
  const keyPair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rawPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const jwkPrivate = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);

  console.log("\nVAPID_PUBLIC_KEY:");
  console.log(base64url(rawPublic));
  console.log("\nVAPID_PRIVATE_KEY:");
  console.log(jwkPrivate.d);
  console.log("\nAgora rode, dentro da pasta worker/:");
  console.log("  wrangler secret put VAPID_PUBLIC_KEY");
  console.log("  wrangler secret put VAPID_PRIVATE_KEY");
  console.log("  wrangler secret put VAPID_SUBJECT   (ex: mailto:seuemail@exemplo.com)");
  console.log("\nColando o valor correspondente em cada um quando ele pedir.\n");
})();
