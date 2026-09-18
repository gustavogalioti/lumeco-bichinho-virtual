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

## Notificações push (opcional)

Pra ativar os avisos proativos (compromisso chegando, conta vencendo, tarefa
parada), precisa gerar um par de chaves VAPID e configurar 3 secrets. Isso é
feito uma vez só, local, e a chave privada nunca passa pelo Git:

```
cd worker
node generate-vapid-keys.js
```

O script imprime `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`. Cole cada um em:

```
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` é um contato seu, no formato `mailto:seuemail@exemplo.com`
(alguns serviços de push usam isso pra te avisar se algo der errado).

O `wrangler.toml` já tem um Cron Trigger (`[triggers]`) rodando a cada 15
minutos — depois do primeiro `wrangler deploy` com os secrets configurados,
ele já começa a rodar sozinho. Sem os 3 secrets, o cron roda mas não faz
nada (falha silenciosa, sem gastar chamada à Groq).
