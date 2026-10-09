# Incubadora Jarbas

Laboratórios independentes para testar o visual e a interação do Jarbas — rosto,
expressões, cenário, animações — antes de qualquer coisa ser levada para o app
de verdade (`companion/`).

## Regra de ouro

**A incubadora nunca altera o app.** Cada laboratório é um arquivo HTML
independente, autocontido, sem build e sem depender de `companion/` ou
`worker/`. O que for aprovado aqui é portado para o companion em PRs próprios,
depois de testado — nunca direto.

## Como abrir

Pelo GitHub Pages do projeto, em:

```
https://<usuario>.github.io/lumeco-bichinho-virtual/incubadora/
```

(a pasta raiz do Pages já serve `/companion/` do mesmo jeito; `/incubadora/`
funciona igual, sem nenhuma configuração extra). `index.html` lista os
laboratórios disponíveis.

## Laboratórios

| Lab | Nome | Estado |
|---|---|---|
| 1 + 2 | Rosto e materialização | ✅ disponível (`lab-1-2.html`) |
| 3 | Cenário e telas que o Jarbas acompanha | 🔜 em breve |
| 4 | Balões, cartões de dados, lousa e quadro de pensamento | 🔜 em breve |
| 5 | Onde o Jarbas gosta de estar quando está sozinho | 🔜 em breve |

## Dependências

Cada lab carrega o que precisa diretamente via CDN, na própria página — sem
`npm install`, sem build. O Lab 1+2 carrega o **Three.js r128** via cdnjs.

## Aviso

Nos laboratórios, o microfone real **não é usado** — a escuta é sempre
simulada (um botão "escuta simulada" ou similar). Nenhum lab pede permissão
de áudio de verdade.
