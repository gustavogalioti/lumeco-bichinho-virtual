# Lumeco proxy (Cloudflare Worker)

Guarda a chave da Groq em segredo e conversa com o modelo em nome do site.
O site (GitHub Pages) nunca vê a chave — só fala com este Worker.

## Passo a passo

1. Se ainda não tiver, crie uma conta gratuita em https://dash.cloudflare.com
2. Pegue uma chave de API em https://console.groq.com/keys
3. Instale o wrangler (CLI do Cloudflare) e faça login:
   ```
   npm install -g wrangler
   wrangler login
   ```
4. Dentro desta pasta (`worker/`), faça o deploy:
   ```
   wrangler deploy
   ```
5. Configure a chave da Groq como segredo (não fica no código nem no Git):
   ```
   wrangler secret put GROQ_API_KEY
   ```
   Cole a chave quando ele pedir.
6. (Opcional) Se quiser trocar o modelo padrão (`llama-3.1-8b-instant`):
   ```
   wrangler secret put GROQ_MODEL
   ```
7. O `wrangler deploy` do passo 4 imprime uma URL tipo:
   `https://lumeco-proxy.SEU-SUBDOMINIO.workers.dev`

   Copie essa URL — é ela que você vai colar no site, na seção "Conversar".

## Se trocar de domínio do site

O arquivo `index.js` restringe quem pode chamar o Worker (`ALLOWED_ORIGIN`).
Se o site mudar de endereço, atualize essa constante e rode `wrangler deploy` de novo.
