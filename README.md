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

**5. Multimodal (imagem)**

Imagens são enviadas como `image_url` dentro de `messages[].content` (formato OpenAI). A URL aceita:

- URL remota (`https://...`) — requer internet no container do llama-server;
- base64 puro;
- data URI (`data:image/png;base64,...`) — recomendado, funciona sem rede.

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
- Upload de imagem com preview (enviada como data URI base64);
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
│   ├── routes/chat.ts       # POST /v1/chat/completions (stream/multimodal)
│   └── services/llama.ts    # proxy p/ llama.cpp + tradução do thinking
├── request.json             # exemplo de body JSON
└── playground.html          # página de teste visual no navegador
```

## Desenvolvimento (sem Docker)

```bash
# instalar dependências
npm install

# rodar a API localmente (exige o llama-server acessível)
npm run dev          # http://localhost:3000

# build de produção
npm run build        # gera dist/
npm start            # node dist/server.js
```

Para desenvolvimento local, ajuste `LLAMA_URL` no `.env` para apontar ao seu `llama-server` (ex.: `http://localhost:8080`).
