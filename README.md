# LLM API

Proxy HTTP (Fastify) que expõe uma API compatível com o OpenAI Chat Completions e repassa as requisições para um backend [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) rodando em Docker.

## Arquitetura

```
Cliente (curl / playground.html / sua app)
        │  POST /v1/chat/completions  (Bearer API_TOKEN)
        ▼
┌───────────────────┐        ┌───────────────────┐
│  llm-api          │        │  llama-server     │
│  Fastify (Node)   │ ─────► │  llama.cpp        │
│  porta 3000       │  HTTP  │  porta 8080       │
└───────────────────┘        └───────────────────┘
        │                           │
        │  recursos:                │  carrega:
        │  - auth Bearer            │  - model.gguf (LLM)
        │  - streaming (SSE)        │  - mmproj (visão/multimodal)
        │  - thinking on/off        │
        │  - multimodal (imagens)   │
```

O serviço `llm-api` apenas autentica e repassa o body (com traduções de parâmetros como `thinking`) para o `llama-server`. Toda a inferência acontece no llama.cpp.

## Pré-requisitos

- [Docker](https://www.docker.com/) com Docker Compose (v2+).
- Os arquivos do modelo em formato GGUF.

## Arquivos do modelo

Os modelos ficam na pasta `models/` na raiz do projeto. Essa pasta é montada dentro do container do `llama-server` em `/models`.

```
llm-api/
└── models/
    ├── model.gguf         (obrigatório - modelo de linguagem)
    └── mmproj.gguf        (necessário para multimodal - projector de visão)
```

### 1. Modelo de linguagem (`model.gguf`)

O `llama-server` é iniciado com `-m /models/model.gguf`, então o arquivo deve se chamar **`model.gguf`** (ou você altera o nome no `docker-compose.yml`).

É possível identificar o modelo lendo os metadados do arquivo GGUF. O campo `general.architecture` e `general.name` dizem qual é o modelo e a família:

```jsonc
// exemplo de metadados do Gemma 4 E2B
general.architecture = "gemma4"
general.name = "gemma-4-E2B-it"
general.file_type = 2      // 2 = Q4_0, 7 = Q8_0, etc.
```

Fontes de modelos GGUF (exemplos):

- Repositórios oficiais: https://huggingface.co/ggml-org
- Quantizações alternativas: https://huggingface.co/unsloth
- Baixar direto (Hugging Face):

```bash
# exemplo: baixar o Gemma 4 E2B Q4_0 para models/model.gguf
curl -L -o models/model.gguf \
  "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_0.gguf"
```

### 2. Projector multimodal (`mmproj.gguf`) — opcional

Para enviar **imagens**, o `llama-server` precisa do projector de visão do modelo. Se você tentar enviar uma imagem sem ele, recebe:

```json
{"error":{"code":500,"message":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj","type":"server_error"}}
```

> A API usa apenas um modelo por vez, então o projector segue o padrão simplificado: basta salvá-lo como **`mmproj.gguf`** em `models/`.

O arquivo `mmproj` deve estar em `models/` e ser referenciado no `docker-compose.yml`:

```yaml
command:
  [
    "-m", "/models/model.gguf",
    "--mmproj", "/models/mmproj.gguf",
    ...
  ]
```

Exemplo de download do projector oficial do Gemma 4 E2B (salve como `mmproj.gguf`):

```bash
curl -L -o models/mmproj.gguf \
  "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/mmproj-gemma-4-E2B-it-Q8_0.gguf"
```

> Dica: use o `mmproj` compatível com o quant do seu modelo. Para modelos Q4/Q5/Q6, o `mmproj-Q8_0` costuma ser o melhor custo/benefício; `BF16` tem maior qualidade, porém mais memória.

Para confirmar que o projector carregou, veja o log do container:

```bash
docker compose logs llama
# deve aparecer algo como:
# load_model: loaded multimodal model, '/models/mmproj.gguf'
```

## Configuração (.env)

Copie/edite o arquivo `.env` na raiz:

```env
# Porta do proxy HTTP (llm-api)
PORT=3000

# Token exigido no header Authorization: Bearer <token>
API_TOKEN=abc123-super-secret

# URL interna do llama-server (nome do serviço no docker-compose)
LLAMA_URL=http://llama:8080

# Limite máximo do body JSON em bytes (aumente para imagens base64)
BODY_LIMIT=26214400

# Tools: máximo de rodadas de chamadas de ferramenta por requisição
MAX_TOOL_ROUNDS=8

# Tools: timeout (ms) para chamadas HTTP de web_search e fetch_page
TOOL_TIMEOUT_MS=15000

# Tools: número de resultados padrão do web_search (1-10)
SEARCH_RESULTS=5

# Tools: máximo de caracteres retornados pelo fetch_page
MAX_PAGE_CHARS=8000

# Translate: tamanho alvo (em caracteres) de cada chunk de texto.
# Textos maiores são quebrados em múltiplas requisições ao modelo e
# reagrupados na resposta final. A quebra nunca corta uma palavra ao meio.
TRANSLATE_CHUNK_CHARS=4000

# Translate: máximo de tentativas por chunk em caso de erro de rede,
# resposta 5xx do modelo ou resposta sem conteúdo. Erros 4xx não são
# repetidos. Cada tentativa extra usa backoff de 250ms * tentativa.
TRANSLATE_CHUNK_RETRIES=3
```

> `API_TOKEN` é **obrigatório** — o app falha ao iniciar se estiver vazio.

## Subindo o app

```bash
# builda a imagem da API e sobe os dois serviços
docker compose up -d --build

# acompanhar os logs
docker compose logs -f

# parar
docker compose down
```

Verifique se está tudo de pé:

```bash
docker compose ps
curl http://localhost:3000/health
# {"status":"ok"}
```

O `llama-server` demora para carregar o modelo na primeira subida (o `/health` do backend responde 503 enquanto carrega).

## Rotas

### `GET /health`

Healthcheck público (sem autenticação).

```bash
curl http://localhost:3000/health
```

Resposta:

```json
{ "status": "ok" }
```

### `GET /v1/tools`

Lista as tools embutidas (schemas em formato OpenAI). Requer autenticação.

```bash
curl http://localhost:3000/v1/tools \
  -H "Authorization: Bearer abc123-super-secret"
```

### `POST /v1/translate`

Traduz um texto usando o modelo (LLM) carregado no `llama-server`. O proxy monta um prompt de sistema dedicado, chama o modelo e devolve apenas o texto traduzido. Requer autenticação.

> **Fila:** as requisições de tradução são enfileiradas em memória e processadas **uma por vez** (FIFO, concorrência 1) para não sobrecarregar o `llama-server`. Se o servidor estiver ocupado, a requisição fica com o HTTP aberto aguardando a vez — a fila é ilimitada, então nunca há falha por lotação. Isso torna o endpoint seguro para o consumo assíncrono em massa (ex.: traduzir páginas de um blog a partir de outro servidor).

> **Chunking:** se o texto ultrapassar `TRANSLATE_CHUNK_CHARS` (padrão `4000`, ~1000 tokens — seguro para o Gemma 4 E2B), ele é quebrado em múltiplos pedaços, cada um traduzido em uma requisição separada ao modelo, e o resultado final é a **junção** de todas as traduções (a quebra respeita palavras e preserva as quebras de linha). Para o cliente é transparente: uma única chamada, um único texto de resposta.

> **Retry:** se um chunk falhar por erro de rede, resposta `5xx` do modelo ou resposta sem conteúdo, ele é tentado novamente até `TRANSLATE_CHUNK_RETRIES` vezes (padrão `3`). Erros `4xx` não são repetidos (não mudariam com nova tentativa). Se a falha persistir e já houver chunks traduzidos, o erro inclui o campo `partial` com o texto parcial.

> **Streaming:** passando `"stream": true`, a resposta vira um fluxo **SSE** com eventos de progresso (`queued`, `start`, `chunk_start`, `delta`, `chunk_retry`, `chunk_end`, `done`/`error`). O cliente recebe resposta imediatamente (com a posição na fila), o texto traduzido aparece **em tempo real** via `delta`, e um keepalive evita que proxies encerrem a conexão durante esperas longas na fila. Útil para clientes interativos (ex.: o playground) que precisam de feedback de progresso e não podem ficar com a requisição "muda" por muito tempo.

```bash
curl http://localhost:3000/v1/translate \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Bom dia, tudo bem?",
    "to": "en",
    "from": "pt"
  }'
```

#### Parâmetros

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `text` | string | **Obrigatório.** Texto a ser traduzido. |
| `to` | string | **Obrigatório.** Idioma de destino (ex.: `en`, `es`, `fr`, `pt`, `ja`). |
| `from` | string | Opcional. Idioma de origem (ex.: `pt`). Se omitido, o modelo tenta detectar. |
| `thinking` | boolean | Opcional. Se `false` (padrão), desliga o pensamento do modelo (`enable_thinking: false` + `reasoning_effort: none`) para uma tradução direta. |
| `stream` | boolean | Opcional. Se `true`, responde em SSE com eventos de progresso (ver abaixo). Padrão: `false`. |

#### Resposta (sem `stream`)

```json
{
  "text": "Good morning, how are you?",
  "from": "pt",
  "to": "en"
}
```

> Erros do `llama-server` são repassados com o status e body originais (com `partial` quando já havia chunks traduzidos). Sem `text` ou `to`, retorna `400` com `error.message` descritivo.

#### Resposta com `stream: true`

Fluxo **SSE** (`text/event-stream`) com eventos nomeados. Exemplo simplificado:

```
event: queued
data: {"position":3}

event: start
data: {"chunks":2}

event: chunk_start
data: {"index":0,"chunks":2}

event: delta
data: {"text":"Bom "}

event: delta
data: {"text":"dia."}

event: chunk_end
data: {"index":0,"chunks":2}

event: done
data: {"text":"Bom dia.","from":"pt","to":"en"}
```

| Evento | Data | Significado |
|---|---|---|
| `queued` | `{ position }` | Posição na fila (resposta imediata). |
| `start` | `{ chunks }` | Total de chunks a traduzir. |
| `chunk_start` | `{ index, chunks }` | Início do chunk `index`. |
| `delta` | `{ text }` | Fragmento traduzido em tempo real. |
| `chunk_retry` | `{ index, attempt }` | Chunk falhou e será tentado de novo. |
| `chunk_end` | `{ index, chunks }` | Chunk concluído. |
| `done` | `{ text, from, to }` | Tradução completa. |
| `error` | `{ status, message, partial }` | Falha após esgotar as tentativas; `partial` tem o texto já traduzido. |

### `POST /v1/chat/completions`

Endpoint compatível com OpenAI. **Requer** o header:

```
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

#### Parâmetros principais

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `model` | string | Nome do modelo (qualquer valor; o backend usa o GGUF carregado). |
| `messages` | array | Histórico de conversa (padrão OpenAI). |
| `stream` | boolean | `true` = resposta em SSE (streaming). |
| `thinking` | boolean | Controle do pensamento do modelo (mapa para `enable_thinking` e `reasoning_effort` no llama.cpp). |
| `stateless` | boolean | `true` = sem contexto: cada requisição é tratada como a primeira (só a mensagem atual é enviada). Útil para tradução. Padrão: `false` (histórico completo). |
| `temperature`, `top_p`, `max_tokens`, ... | vários | Parâmetros de amostragem repassados ao llama.cpp. |

#### Exemplos

**1. Chat simples (sem stream)**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      { "role": "user", "content": "O que é Docker? Explique em poucas palavras." }
    ],
    "stream": false
  }'
```

**2. Com streaming (SSE)**

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      { "role": "user", "content": "Escreva um haiku sobre o mar." }
    ],
    "stream": true
  }'
```

**3. Desligando o pensamento (`thinking: false`)**

Quando o modelo é de raciocínio (ex.: Gemma 4), `thinking: false` desliga o bloco de pensamento:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      { "role": "user", "content": "2 + 2?" }
    ],
    "thinking": false,
    "stream": false
  }'
```

Com `thinking: true` (ou omitido), a resposta vem com `reasoning_content` separado do `content`.

**4. Sem contexto (`stateless: true`)**

Ideal para tradução: cada requisição é tratada como a primeira mensagem — o histórico é ignorado e só a mensagem atual é enviada ao modelo:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      { "role": "user", "content": "Traduza para inglês: Bom dia." }
    ],
    "stateless": true,
    "thinking": false,
    "stream": false
  }'
```

> Apesar de `stateless: true` ignorar o histórico, você ainda envia `messages` normalmente (a API usa o último item). Por padrão (`stateless` omitido ou `false`), o histórico completo é mantido.

**5. Multimodal (imagem, áudio e vídeo)**

Imagens, áudios e vídeos são enviados dentro de `messages[].content` (formato OpenAI). O Gemma 4 aceita:

- **Imagem** (`image_url`) — todos os tamanhos. Aceita URL remota, base64 puro ou data URI (`data:image/png;base64,...`);
- **Áudio** (`input_audio`) — modelos E2B/E4B/12B. `data` em base64 (sem prefixo `data:`) e `format` com a extensão (`wav`, `mp3`, ...), máx. ~30s;
- **Vídeo** (`input_video`) — extensão do llama.cpp. `data` em base64 (sem prefixo `data:`). O `llama-server` decodifica com `ffmpeg` (precisa estar instalado no container) e envia os frames ao modelo, máx. ~60s a 1 fps.

```bash
# imagem em base64 (data URI)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." }
          },
          { "type": "text", "text": "Descreva esta imagem." }
        ]
      }
    ],
    "thinking": false,
    "stream": false
  }'
```

Exemplo com áudio (transcrição):

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "input_audio",
            "input_audio": { "data": "UklGRi4AAABXQVZF...", "format": "wav" }
          },
          { "type": "text", "text": "Transcreva este áudio." }
        ]
      }
    ],
    "stream": false
  }'
```

Exemplo com vídeo:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "input_video",
            "input_video": { "data": "AAAAIGZ0eXBpc29t..." }
          },
          { "type": "text", "text": "O que acontece neste vídeo?" }
        ]
      }
    ],
    "stream": false
  }'
```

> **Requisitos:**
> - Um build recente do llama.cpp com suporte a áudio/vídeo (o Gemma 4 E2B/E4B/12B tem suporte nativo a áudio);
> - `ffmpeg` no container para vídeo (`ghcr.io/ggml-org/llama.cpp:server` recente já inclui);
> - Áudio deve estar em **WAV, MP3 ou FLAC** (formatos do miniaudio). O `playground.html` converte automaticamente uploads e gravações do microfone para **WAV 16kHz mono** antes de enviar;
> - Vídeo é decodificado via `ffmpeg` (H.264/MP4, WebM, etc.);
> - Arquivos grandes podem exigir aumentar `BODY_LIMIT` no `.env`.

Resposta (exemplo real):

```json
{
  "choices": [
    {
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "This image is a solid blue rectangle."
      }
    }
  ],
  "usage": { "prompt_tokens": 60, "completion_tokens": 11, "total_tokens": 71 }
}
```

> Em streaming, o pensamento chega em `delta.reasoning_content` e a resposta em `delta.content`.

## Página de teste (`playground.html`)

Abra o `playground.html` no navegador para testar todos os recursos sem escrever curl:

- Chat com streaming;
- Checkbox "Mostrar pensamento" (liga/desliga o `thinking`);
- Checkbox "Sem contexto (stateless)" (cada mensagem tratada como a primeira);
- Checkbox "Tools" (ativa as tools embutidas com `enable_tools: true`);
- Upload de imagem com preview (enviada como data URI base64);
- Upload de áudio e vídeo com preview (enviados como `input_audio` e `input_video`);
- Gravação de áudio pelo microfone (botão com ícone de microfone, máx. 30s), enviada como `input_audio`;
- Botão "Histórico de erros": registro de todas as falhas com data, status HTTP, endpoint, body enviado e detalhes — para debugar sem abrir o DevTools.

> Lembre-se de ajustar `API_TOKEN` (e, se necessário, `API_URL` e `MODEL`) no topo do arquivo se você mudar o valor no `.env`.

## Como funciona o parâmetro `thinking`

O parâmetro `thinking` (boolean) enviado no body é traduzido pelo serviço `src/services/llama.ts` antes de repassar ao llama.cpp:

```ts
if (typeof thinking === 'boolean') {
  body.chat_template_kwargs = {
    ...(body.chat_template_kwargs ?? {}),
    enable_thinking: thinking,
  }
  if (!thinking) {
    body.reasoning_effort = 'none'
  }
}
```

- `thinking: true` → `chat_template_kwargs.enable_thinking = true`
- `thinking: false` → `chat_template_kwargs.enable_thinking = false` + `reasoning_effort = "none"`
- Omitido → comportamento padrão do llama-server (o template do modelo decide).

> Observação: `--reasoning off` é flag de **inicialização** do `llama-server`, não dá para alternar por request. O controle por request é feito via `chat_template_kwargs.enable_thinking` e `reasoning_effort=none`, que são exatamente os campos usados acima.

## Como funciona o parâmetro `stateless`

Quando `stateless: true`, o serviço descarta todo o histórico e envia apenas o último item de `messages` para o llama.cpp — o modelo trata cada requisição como a primeira:

```ts
if (stateless === true && Array.isArray(body.messages)) {
  body.messages = body.messages.slice(-1)
}
```

- `stateless: true` → somente a mensagem atual é enviada ao modelo.
- `stateless` omitido ou `false` → o histórico completo é repassado (padrão).

> Quando `tools` estão ativas, `stateless` é ignorado — o tool-loop precisa do histórico para anexar os resultados das chamadas.

## Tools (function calling)

O proxy implementa o **tool-calling loop**: o `llama-server` emite `tool_calls`, o proxy executa a tool e devolve o resultado ao modelo, repetindo até a resposta final. Funciona com e sem streaming (SSE).

> Para um guia completo e aprofundado (conceito, fluxo no código, streaming, schemas e as 5 tools em detalhe), veja o [`TOOLS.md`](./TOOLS.md).

### Habilitando

- `enable_tools: true` — injeta automaticamente os schemas das tools embutidas;
- `tools: [...]` — lista de tools em formato OpenAI (o proxy executa apenas as que implementa);
- `max_tool_rounds: N` — limite de rodadas de ferramentas por requisição (padrão 8).

O modelo deve ter suporte a function calling (chat template com tools). Caso contrário, ele simplesmente nunca emite `tool_calls` e o fluxo segue normal.

### Tools embutidas

| Tool | Descrição |
|---|---|
| `web_search` | Busca na web (DuckDuckGo, sem chave) e retorna títulos, URLs e resumos. |
| `fetch_page` | Abre uma URL e retorna o texto legível extraído (truncado). |
| `calculator` | Calculadora avançada: `+ - * / % ^`, parênteses, funções (`sin cos tan ln log sqrt cbrt abs round floor ceil min max`, ...) e constantes (`pi`, `e`). |
| `get_current_time` | Data/hora atual (padrão Brasília/America_Sao_Paulo; aceita fuso IANA via `timezone`), ISO e timestamp. |
| `random_uuid` | Gera um UUID v4. |

Consulte os schemas completos (para usar com `tools` explícitas) em:

```bash
curl http://localhost:3000/v1/tools \
  -H "Authorization: Bearer abc123-super-secret"
```

### Exemplo (sem stream)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer abc123-super-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      { "role": "user", "content": "Calcule 123 * 456 e responda com o resultado." }
    ],
    "enable_tools": true,
    "stream": false
  }'
```

### Exemplo (com streaming)

Mesmo body com `"stream": true`. O proxy repassa as chamadas de tool como eventos SSE (`delta.tool_calls`) e continua o stream com a resposta final — o cliente vê apenas um stream contínuo terminando em `data: [DONE]`.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `MAX_TOOL_ROUNDS` | `8` | Máximo de rodadas de ferramentas por requisição. |
| `TOOL_TIMEOUT_MS` | `15000` | Timeout (ms) das chamadas HTTP de `web_search` e `fetch_page`. |
| `SEARCH_RESULTS` | `5` | Número padrão de resultados do `web_search`. |
| `MAX_PAGE_CHARS` | `8000` | Máximo de caracteres retornados pelo `fetch_page`. |

## Estrutura do projeto

```
llm-api/
├── docker-compose.yml       # orquestra api + llama-server
├── dockerfile               # build da imagem Node (API)
├── .env                     # configuração (token, portas, limites)
├── models/                  # model.gguf + mmproj.gguf (montado no container)
├── src/
│   ├── server.ts            # entrypoint do Fastify
│   ├── app.ts               # montagem do app (CORS, auth, rotas, bodyLimit)
│   ├── config/env.ts        # leitura das variáveis de ambiente
│   ├── plugins/auth.ts      # validação do Bearer token
│   ├── routes/chat.ts       # POST /v1/chat/completions (stream/multimodal/tools)
│   ├── routes/tools.ts      # GET /v1/tools (schemas das tools embutidas)
│   ├── routes/translate.ts  # POST /v1/translate (tradução via modelo)
│   ├── services/llama.ts    # proxy p/ llama.cpp + tradução do thinking
│   ├── services/chatTools.ts# tool-calling loop (stream e não-stream)
│   ├── services/translate.ts# prompt de tradução + chunking + junção
│   ├── services/chunkText.ts# divisão do texto em chunks (sem cortar palavras)
│   ├── services/queue.ts    # fila FIFO em memória (1 job por vez)
│   └── tools/               # implementação das tools (web_search, fetch_page, ...)
├── test/                    # testes unitários e de integração (Vitest)
├── biome.json               # formatação e lint (Biome)
├── lefthook.yml             # hooks de git (formatação, typecheck, testes)
├── vitest.config.ts         # config dos testes (token/URL de teste)
├── request.json             # exemplo de body JSON
└── playground.html          # página de teste visual no navegador
```

## Testes (Vitest)

Os testes cobrem o proxy (`chatCompletion`) e a API montada (`buildApp`), incluindo autenticação, streaming (SSE) e CORS. O `pre-commit` do lefthook roda formatação + typecheck, e o `pre-push` roda os testes.

```bash
# rodar os testes uma vez
npm test

# rodar em modo watch (durante o desenvolvimento)
npx vitest
```

> As variáveis `API_TOKEN` e `LLAMA_URL` são definidas no `vitest.config.ts` (ex.: `test-token` e `http://llama:8080`) — os testes não dependem do `.env`.

## Desenvolvimento (sem Docker)

```bash
# instalar dependências
npm install

# rodar a API localmente (exige o llama-server acessível)
npm run dev          # http://localhost:3000

# testes
npm test

# lint + formatação
npm run check        # verifica
npm run check:fix    # corrige automaticamente

# typecheck
npm run typecheck

# build de produção
npm run build        # gera dist/
npm start            # node dist/server.js
```

Para desenvolvimento local, ajuste `LLAMA_URL` no `.env` para apontar ao seu `llama-server` (ex.: `http://localhost:8080`).
