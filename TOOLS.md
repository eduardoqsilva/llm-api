# Tools (Function Calling) — Como funcionam neste projeto

Este documento explica **como as tools funcionam neste projeto** e, principalmente, **como o modelo (LLM) as chama** — do conceito ao código, com exemplos e referências a arquivos e linhas.

Pré-requisito de leitura: você precisa saber JavaScript/TypeScript e ter noção de HTTP/JSON. **Não** precisa de nenhum conhecimento prévio de IA — a parte de "inteligência" é tratada aqui como uma caixa-preta que apenas responde em JSON.

---

## 1. O conceito em uma frase

> Tools são **funções JavaScript reais** que o modelo pode pedir para executar quando ele precisa de algo que não sabe ou não pode fazer sozinho.

O modelo (rodando no `llama-server`) é apenas um gerador de texto. Ele **não** tem acesso à internet, não sabe a hora atual, e erra contas grandes. Em vez de fingir que sabe a resposta, ele pode "levantar a mão" e dizer:

> "Preciso executar a função `web_search` com o argumento `query = "preço do Bitcoin hoje"`."

O seu código (o proxy `llm-api`) executa essa função **de verdade** e devolve o resultado ao modelo. O modelo então usa esse resultado para montar a resposta final.

Para que isso seja possível, antes de conversar, você precisa **apresentar as ferramentas ao modelo**: quais existem, para que servem e que argumentos aceitam. Essa apresentação é chamada de **schema**.

---

## 2. Analogia para fixar

Imagine que você é uma central de atendimento. Você é muito bom em *responder*, mas não tem acesso aos sistemas internos. Então existem 5 "especialistas" do lado (as tools):

- `web_search` — busca notícias na internet;
- `fetch_page` — abre uma página inteira;
- `calculator` — faz contas com precisão;
- `get_current_time` — consulta o relógio;
- `random_uuid` — gera identificadores.

Quando o cliente (usuário) pergunta algo, você (o LLM) **decide** se responde sozinho ou se precisa chamar um especialista. Se precisar, você pede ao operador (o proxy) para chamar o especialista com certos parâmetros, espera o retorno e aí sim responde o cliente.

O "protocolo" de como você pede e como o retorno chega é o que este documento detalha.

---

## 3. O fluxo completo (visão geral)

```
Cliente (curl / playground / sua app)
   │  POST /v1/chat/completions  (Bearer token)
   │  body: { messages, enable_tools: true }
   ▼
┌──────────────────────────┐
│ llm-api (Fastify/Node)   │
│                          │
│  1. prepareToolBody()    │  injeta os schemas das tools
│     └─ getBuiltinSchemas │  em body.tools
│                          │
│  2. POST → llama-server  │  o modelo "vê" as tools
│      (chatCompletion)    │
│                          │
│  3. O modelo responde    │
│     com tool_calls:      │  ──► "quero chamar web_search
│                          │      com query=..."
│  4. executeTool()        │  roda a função JavaScript REAL
│                          │  (fetch no DuckDuckGo, etc.)
│                          │
│  5. Anexa resultado      │  mensagem { role: "tool", content }
│      como nova mensagem  │
│                          │
│  6. Repete 2–5           │  até o modelo responder SEM
│      (tool-calling loop) │  tool_calls, ou até o limite
└──────────────────────────┘
   │
   ▼
Resposta final (texto) ao cliente
```

Esse ciclo de "chama → executa → devolve → o modelo responde" se chama **tool-calling loop**. É o coração deste projeto e está implementado em `src/services/chatTools.ts`.

---

## 4. Passo a passo no código

### 4.1. O cliente pede tools

Na rota `POST /v1/chat/completions` (`src/routes/chat.ts:41`), o body chega e é processado por `prepareToolBody` (`src/services/chatTools.ts:34`).

Existem **duas formas** de ativar tools no request:

| Forma | Como funciona |
|---|---|
| `"enable_tools": true` | O proxy injeta automaticamente os schemas das **5 tools embutidas**. |
| `"tools": [...]` | Você envia sua **própria lista** de schemas (formato OpenAI). O proxy executa apenas as que ele implementa. |

Trecho de `prepareToolBody` (`src/services/chatTools.ts:38-57`):

```ts
const toolsEnabled = raw.enable_tools === true || Array.isArray(raw.tools)

if (!toolsEnabled) {
  return { body: raw, toolsEnabled: false, maxRounds: 1 }
}

const body = { ...raw }
if (body.enable_tools === true) {
  body.tools = getBuiltinSchemas()   // injeta as 5 tools
}
delete body.enable_tools
delete body.max_tool_rounds
delete body.stateless
```

Detalhes importantes:

- `enable_tools` é **consumido** pelo proxy (vira `body.tools`) e removido do body antes de repassar ao llama-server.
- `max_tool_rounds` e `stateless` também são removidos aqui (o `stateless` é ignorado quando há tools — veja seção 8.1).
- `getBuiltinSchemas()` (`src/tools/index.ts:115`) faz apenas `tools.map((tool) => tool.schema)` — ou seja, devolve os schemas declarados no array `tools` de `src/tools/index.ts:8-113`.

### 4.2. O modelo "recebe" as tools

O body (com `tools` agora presente) é enviado ao `llama-server` via `chatCompletion` (`src/services/llama.ts:10`):

```ts
const response = await fetch(`${env.llamaUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
```

Nesse ponto, o `llama-server` faz o *parsing* do campo `tools` e injeta as descrições na conversa em "linguagem de modelo". É por isso que a **description** de cada tool é tão importante: ela diz ao modelo *quando* usar cada ferramenta.

### 4.3. O modelo decide: responder ou chamar uma tool

Aqui está o ponto central de "como o modelo chama as tools". Em vez de responder com texto, o modelo responde com um campo especial chamado **`tool_calls`** dentro da mensagem `assistant`:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "web_search",
              "arguments": "{\"query\": \"preço do bitcoin hoje\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

O que cada campo significa:

| Campo | O que é |
|---|---|
| `tool_calls[].id` | Identificador único dessa chamada. O modelo gera. Usado para "amarrar" o resultado de volta à chamada. |
| `tool_calls[].type` | Sempre `"function"` (formato OpenAI). |
| `tool_calls[].function.name` | O nome da tool que o modelo quer chamar (ex.: `web_search`). |
| `tool_calls[].function.arguments` | **String JSON** com os argumentos. Importante: é uma *string*, não um objeto. |
| `finish_reason` | `"tool_calls"` indica que o modelo parou porque quer chamar ferramentas, não porque terminou a resposta. |

> **Por que `arguments` é uma string?** Porque o modelo gera texto em "tokens" — ele escreve `{"query": "..."}` caractere por caractere. Isso importa para o streaming (seção 7).

### 4.4. O proxy executa a tool

Em `src/services/chatTools.ts:74-108`, `appendToolResults` processa cada chamada:

```ts
for (const call of normalized) {
  const args = parseArgs(call.function.arguments)   // string JSON → objeto
  const content = await executeTool(call.function.name, args)
  next.push({ role: 'tool', tool_call_id: call.id, content })
}
```

Dois pontos aqui:

**1) `parseArgs` (`src/services/chatTools.ts:59`)** converte a string JSON em objeto:

```ts
function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}
```

- Se o JSON for válido e for um objeto → vira o objeto de argumentos.
- Se o modelo "alucinar" um JSON inválido → retorna `{}` (a tool roda sem argumentos, e normalmente retorna uma mensagem de erro informando o parâmetro obrigatório).

**2) `executeTool` (`src/tools/index.ts:119`)** procura o handler pelo nome:

```ts
export async function executeTool(name: string, args: ToolArgs): Promise<string> {
  const tool = tools.find(
    (candidate) => candidate.schema.function.name === name
  )

  if (!tool) {
    return `Erro: a tool "${name}" não está disponível neste servidor.`
  }

  try {
    const result = await tool.handler(args ?? {})
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return `Erro ao executar a tool "${name}": ${error instanceof Error ? error.message : String(error)}`
  }
}
```

Regras:

- O `name` é comparado com o `schema.function.name` de cada tool.
- Tool não encontrada → devolve uma **string de erro** (não lança exceção). O modelo recebe esse texto e pode tentar outra abordagem.
- Handler lançou erro → a exceção é capturada e vira uma **string** com a mensagem.
- O retorno é sempre uma **string** (`content` de tool é string), mesmo que o handler devolva um objeto (ele é serializado com `JSON.stringify`).

### 4.5. O resultado volta para o modelo

O proxy monta uma mensagem de retorno no formato que o modelo espera:

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "1. Bitcoin hoje: R$ 523.400\n   https://...\n   ..."
}
```

- `role: "tool"` — é o papel de quem "executou" a tool.
- `tool_call_id` — o mesmo `id` da chamada original, para o modelo saber que resultado corresponde a qual chamada.
- `content` — a string retornada por `executeTool`.

### 4.6. O loop continua

Todo o histórico é mantido e reenviado ao modelo. O array `messages` agora contém, na ordem:

1. mensagens originais do usuário;
2. a mensagem `assistant` com os `tool_calls`;
3. as mensagens `tool` com os resultados.

O modelo, de posse dos resultados, agora pode **responder** (sem `tool_calls`) ou **chamar outra tool**. O ciclo se repete até um dos dois acontecer:

- o modelo responde com texto e **sem** `tool_calls` (fim normal);
- o número de rodadas atinge `max_tool_rounds` (forçado a parar — seção 6).

---

## 5. Anatomia de um schema (como o modelo "conhece" as tools)

Cada tool é um objeto com `schema` e `handler` (`src/tools/types.ts:20-23`):

```ts
export type Tool = {
  schema: ToolSchema      // descrição que o modelo lê
  handler: ToolHandler    // função JavaScript que executa
}
```

O schema segue o formato de function calling do OpenAI (`src/tools/types.ts:7-14`):

```ts
export type ToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParameters
  }
}
```

Os campos e o que o modelo faz com cada um:

| Campo | Papel para o modelo |
|---|---|
| `function.name` | O identificador que o modelo coloca em `tool_calls[].function.name`. |
| `function.description` | Texto em linguagem natural que diz **quando** usar. É a instrução mais importante — o modelo decide com base nela. |
| `function.parameters.type` | Sempre `"object"` (os argumentos são um objeto). |
| `function.parameters.properties` | Dicionário de argumentos aceitos, cada um com `type` e `description`. O modelo escolhe quais preencher. |
| `function.parameters.required` | Array com os nomes dos argumentos **obrigatórios**. O modelo sabe que precisa preencher esses. |

Exemplo real do schema da `web_search` (`src/tools/index.ts:10-30`):

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Busca na web usando o DuckDuckGo e retorna os principais resultados (título, URL e resumo). Use para informações recentes ou fatos que você não conhece.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Termo de busca." },
        "max_results": {
          "type": "integer",
          "description": "Número máximo de resultados (1-10). Opcional."
        }
      },
      "required": ["query"]
    }
  }
}
```

> Você pode ver todos os schemas prontos rodando `GET /v1/tools` (`src/routes/tools.ts:5`):
> ```bash
> curl http://localhost:3000/v1/tools -H "Authorization: Bearer <API_TOKEN>"
> ```
> Resposta: `{ "object": "list", "data": [ ...5 schemas... ] }`

---

## 6. Limite de rodadas (`max_tool_rounds`)

Como o modelo poderia ficar chamando tools para sempre, existe um limite. Em `src/services/chatTools.ts:26-32`:

```ts
export function clampRounds(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.round(parsed), 1), 20)
}
```

- Valor padrão: `MAX_TOOL_ROUNDS` do `.env` (padrão `8`).
- Valor do request: `max_tool_rounds` no body, limitado entre **1 e 20**.

**O que acontece quando estoura:** em vez de chamar a tool de novo, o proxy **remove as tools** e força uma resposta final. Em `buildFinalBody` (`src/services/chatTools.ts:110-127`):

```ts
const final = { ...body, messages: [...messages, {
  role: 'user',
  content: 'Você atingiu o limite de chamadas de ferramentas. Responda com a melhor resposta possível usando as informações já obtidas.'
}] }
delete final.tools
```

Ou seja: o modelo não pode mais chamar tools e recebe um pedido explícito para responder com o que já coletou.

---

## 7. Sem streaming vs. com streaming (SSE)

O mesmo loop existe em duas versões, dependendo de `"stream"` no body.

### 7.1. Sem streaming — `chatCompletionWithTools` (`src/services/chatTools.ts:129`)

O fluxo é sequencial e o retorno é JSON:

```ts
for (let round = 0; round < rounds; round++) {
  const response = await chatCompletion(current, thinking, effectiveStateless)
  if (!response.ok) return response                    // erro do llama → repassa

  const data = await response.clone().json()
  const message = data?.choices?.[0]?.message
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

  if (toolCalls.length === 0) return response          // resposta final

  const messages = await appendToolResults(current.messages, message ?? {}, toolCalls)
  current = { ...current, messages }
}
```

- Cada iteração é um `POST` novo ao llama-server.
- Se o modelo não chamou tool → devolve essa resposta direto.
- Se chamou → executa (seção 4.4), monta `messages` e tenta de novo.
- Esgotou as rodadas → `buildFinalBody` + último POST.

### 7.2. Com streaming — `continueToolStream` (`src/services/chatTools.ts:173`)

Aqui o fluxo é mais sofisticado, porque **o primeiro POST já vem em SSE (Server-Sent Events)**, e o proxy não pode apenas "ler tudo" — ele precisa **repassar os eventos ao cliente em tempo real** enquanto observa se o modelo está emitindo `tool_calls`.

O llama-server envia eventos assim:

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calcula","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tor"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"expression\":\"1+1\"}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

Detalhes do streaming:

- **O `name` e `arguments` chegam em pedaços** (chunks), conforme o modelo gera token a token.
- O campo `index` indica qual `tool_calls` daquele turno está sendo preenchido (pode haver várias chamadas em paralelo).
- O proxy **repassa cada evento** ao cliente enquanto acumula os pedaços internamente para montar a chamada completa.

Essa montagem acontece em `handleEvent` (`src/services/chatTools.ts:240-301`):

```ts
if (toolCall.function?.name) {
  fn.name += toolCall.function.name            // concatena pedaços
}
if (toolCall.function?.arguments) {
  fn.arguments += toolCall.function.arguments  // concatena pedaços
}
```

O parsing do stream fica em `consumeSse` (`src/services/chatTools.ts:303-352`):

- Lê o body com `ReadableStream.getReader()`.
- Bufferiza os bytes e separa eventos por `\n\n` (delimitador do SSE).
- Cada linha `data:` é parseada por `parseSseData` (`chatTools.ts:223`).
- `[DONE]` marca o fim do stream.

Quando o stream termina:

- Se **não havia** `tool_calls` → pronto, o que já foi enviado ao cliente é a resposta final.
- Se **havia** → executa as tools (mesmo `appendToolResults`), faz um novo `POST` ao llama-server e **continua** escrevendo no mesmo stream até o `[DONE]` final.

O controle de rodadas no streaming (`chatTools.ts:188-220`):

```ts
round++
if (round > rounds) return                     // acabou, só o que já foi escrito
if (round === rounds) {
  const final = buildFinalBody(current, current.messages)
  response = await chatCompletion(final, thinking)
  continue                                      // última rodada sem tools
}
const messages = await appendToolResults(...)
current = { ...current, messages }
response = await chatCompletion(current, thinking, effectiveStateless)
```

> **Para o cliente, tudo parece um stream único e contínuo** terminando em `data: [DONE]` — ele nem percebe as rodadas internas de tools. Os `delta.tool_calls` aparecem como eventos, e a resposta final vem depois.

---

## 8. Detalhes e pegadinhas importantes

### 8.1. `stateless` é ignorado quando há tools

O `stateless` (`src/services/llama.ts:28-30`) joga fora o histórico e envia só a última mensagem. Isso **quebraria** o tool-loop, que precisa do histórico para anexar `assistant` + `tool_calls` + `tool` de volta.

Por isso (`src/routes/chat.ts:54`):

```ts
const effectiveStateless = toolsEnabled ? undefined : stateless
```

E, internamente, também em `chatCompletionWithTools` (`chatTools.ts:137`):

```ts
const effectiveStateless = Array.isArray(body.tools) ? undefined : stateless
```

Regra: **tools ativas → `stateless` desligado à força.**

### 8.2. O que acontece se o modelo não tem suporte a tools

O `llama-server` só emite `tool_calls` se o modelo tiver um chat template com suporte a function calling. Se não tiver, ele simplesmente responde normalmente e o loop termina na primeira rodada (`toolCalls.length === 0` → retorna). Nada quebra.

### 8.3. Erros nunca derrubam a requisição

- Tool inexistente → texto de erro como `content` (o modelo tenta outra coisa).
- Handler com exceção (ex.: timeout de rede) → texto de erro.
- `arguments` inválido → `parseArgs` devolve `{}`.
- Erro HTTP do llama-server → o proxy repassa o status e o corpo do erro.

### 8.4. Múltiplas tools no mesmo turno

Se o modelo emitir **várias** `tool_calls` em um único turno (por exemplo, buscar duas coisas diferentes), o loop as executa **todas em sequência** (`for` em `appendToolResults`) e devolve **todas** as mensagens `tool` ao modelo de uma vez. No streaming, os `index` diferentes são acumulados em um `Map` (`ToolCallMap`), cada um com seu `id`, `name` e `arguments` próprios.

### 8.5. `thinking` continua valendo durante o tool-loop

O parâmetro `thinking` é traduzido em `chatCompletion` (`src/services/llama.ts:15-26`) a cada POST, inclusive nas rodadas intermediárias do loop.

---

## 9. As 5 tools em detalhe

Registro central: `src/tools/index.ts:8-113`. Tipos compartilhados: `src/tools/types.ts`.

Resumo:

| Tool | Handler | Para que serve |
|---|---|---|
| `web_search` | `src/tools/webSearch.ts:88` | Busca no DuckDuckGo (sem chave) e devolve títulos, URLs e resumos. |
| `fetch_page` | `src/tools/fetchPage.ts:87` | Abre uma URL e devolve o texto legível (limpo de HTML/scripts/ruído). |
| `calculator` | `src/tools/calculator.ts:274` | Avalia expressões matemáticas (operadores, funções e constantes). |
| `get_current_time` | `src/tools/getCurrentTime.ts:31` | Data/hora atual, com fuso horário configurável. |
| `random_uuid` | `src/tools/randomUuid.ts:4` | Gera um UUID v4. |

### 9.1. `web_search`

- **Quando o modelo usa:** precisa de informação recente ou que não conhece.
- **Parâmetros:**
  - `query` (string, **obrigatório**) — termo de busca.
  - `max_results` (integer, opcional) — quantidade de resultados, limitado a 1–10. Padrão: `SEARCH_RESULTS` (env, padrão 5).
- **Arguments que o modelo emite:**
  ```json
  { "query": "preço do bitcoin hoje", "max_results": 5 }
  ```
- **Retorno para o modelo (exemplo):**
  ```
  1. Bitcoin hoje | Cotação BTC em tempo real
     https://exemplo.com/bitcoin
     Preço atual: R$ 523.400 com alta de 2% nas últimas 24h.
  2. ...
  ```
- **Implementação:** `searchWeb` (`webSearch.ts:66`) faz `fetch` em `https://html.duckduckgo.com/html/?q=...`, com `User-Agent` de navegador e `AbortSignal.timeout(env.toolTimeoutMs)`. O HTML é parseado com regex (`TITLE_RE`, `SNIPPET_RE`) e as entidades HTML são decodificadas (`html.ts`).

### 9.2. `fetch_page`

- **Quando o modelo usa:** precisa do conteúdo **completo** de uma página (por exemplo, um resultado da `web_search`).
- **Parâmetros:**
  - `url` (string, **obrigatório**) — URL completa `http/https`.
  - `max_chars` (integer, opcional) — máximo de caracteres, limitado a 500–20000. Padrão: `MAX_PAGE_CHARS` (env, padrão 8000).
- **Arguments que o modelo emite:**
  ```json
  { "url": "https://exemplo.com/artigo-bitcoin", "max_chars": 8000 }
  ```
- **Retorno para o modelo:** texto limpo da página (truncado com `…` no fim se passar do limite).
- **Implementação:** `fetchPageText` (`fetchPage.ts:48`) baixa a página (limite de 5 MB), detecta o charset (`detectCharset`), e se for HTML usa `extractReadableText` (`src/tools/reader.ts:114`) com o **cheerio** para remover `script`, `style`, `nav`, `footer`, anúncios, modais etc. e reestruturar como texto legível (cabeçalhos viram `#`, listas viram `-`, links ganham a URL entre parênteses).

### 9.3. `calculator`

- **Quando o modelo usa:** precisa de precisão em contas (o modelo erra aritmética).
- **Parâmetros:**
  - `expression` (string, **obrigatório**) — expressão matemática.
- **Suporta:** `+ - * / % ^`, parênteses, unário `-`, funções `sin cos tan asin acos atan ln log sqrt cbrt abs round floor ceil min max` e constantes `pi`, `e`.
- **Arguments que o modelo emite:**
  ```json
  { "expression": "2 ^ 10" }
  ```
- **Retorno para o modelo:** o número formatado, ex.: `1024`.
- **Implementação:** um mini-parser próprio (não usa `eval`) em `calculator.ts`: `tokenize` → `parseExpression`/`parseTerm`/`parseUnary`/`parsePower`/`parseAtom` (precedência correta) → `evaluateExpression` (`calculator.ts:247`). Erros de sintaxe viram texto `Erro: ...`.

### 9.4. `get_current_time`

- **Quando o modelo usa:** precisa saber data/hora ("que horas são?", "que dia é hoje?").
- **Parâmetros:**
  - `timezone` (string, **opcional**) — fuso IANA. Padrão: `America/Sao_Paulo`.
- **Arguments que o modelo emite:**
  ```json
  { "timezone": "America/New_York" }
  ```
- **Retorno para o modelo (JSON serializado):**
  ```json
  {
    "iso": "2026-08-14T18:30:00.000Z",
    "local": "2026-08-14 14:30:00 GMT-4",
    "timezone": "America/New_York",
    "timestamp": 1784140200000
  }
  ```
- **Implementação:** `Intl.DateTimeFormat` com `formatToParts` (`getCurrentTime.ts:5-29`).

### 9.5. `random_uuid`

- **Quando o modelo usa:** precisa de um identificador único.
- **Parâmetros:** nenhum.
- **Retorno para o modelo:** uma string UUID v4, ex.: `7f1b1d5e-9a6c-4b3d-8e2f-1c2d3e4f5a6b`.

---

## 10. Variáveis de ambiente das tools

| Variável | Padrão | Onde é usada |
|---|---|---|
| `MAX_TOOL_ROUNDS` | `8` | `prepareToolBody` via `env.maxToolRounds` (`src/routes/chat.ts:51`). |
| `TOOL_TIMEOUT_MS` | `15000` | `AbortSignal.timeout` no `web_search` (`webSearch.ts:77`) e `fetch_page` (`fetchPage.ts:58`). |
| `SEARCH_RESULTS` | `5` | Padrão de `max_results` da `web_search` (`webSearch.ts:100`). |
| `MAX_PAGE_CHARS` | `8000` | Padrão de `max_chars` da `fetch_page` (`fetchPage.ts:99`). |

Todas lidas em `src/config/env.ts:4-19`.

---

## 11. Testando na prática

### Ver os schemas

```bash
curl http://localhost:3000/v1/tools -H "Authorization: Bearer <API_TOKEN>"
```

### Sem streaming (o modelo deve chamar a `calculator`)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [
      { "role": "user", "content": "Quanto é 123 * 456? Responda só com o número." }
    ],
    "enable_tools": true,
    "stream": false
  }'
```

### Com streaming

Mesmo body com `"stream": true`. O `curl -N` mostrará os eventos SSE, incluindo os `delta.tool_calls`, até o `data: [DONE]`.

### Com limite baixo (para ver a resposta forçada)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model.gguf",
    "messages": [{ "role": "user", "content": "Busque o clima de São Paulo" }],
    "enable_tools": true,
    "max_tool_rounds": 1,
    "stream": false
  }'
```

Com `max_tool_rounds: 1`, o modelo só pode chamar tools uma vez; na sequência o proxy remove as tools e força uma resposta com o que foi coletado.

---

## 12. Mapa do código (referência rápida)

| Arquivo | Linha | Papel |
|---|---|---|
| `src/tools/types.ts` | 1–23 | Tipos `ToolSchema`, `ToolArgs`, `ToolHandler`, `Tool`. |
| `src/tools/index.ts` | 8–113 | Registro das 5 tools (schema + handler). |
| `src/tools/index.ts` | 115–117 | `getBuiltinSchemas()` — injeta os schemas. |
| `src/tools/index.ts` | 119–139 | `executeTool()` — encontra e executa pelo nome. |
| `src/services/chatTools.ts` | 26–32 | `clampRounds()` — limita rodadas a 1–20. |
| `src/services/chatTools.ts` | 34–57 | `prepareToolBody()` — ativa tools e injeta schemas. |
| `src/services/chatTools.ts` | 59–72 | `parseArgs()` — string JSON de `arguments` → objeto. |
| `src/services/chatTools.ts` | 74–108 | `appendToolResults()` — executa tools e anexa mensagens `tool`. |
| `src/services/chatTools.ts` | 110–127 | `buildFinalBody()` — fim do loop (sem tools, pede resposta). |
| `src/services/chatTools.ts` | 129–171 | `chatCompletionWithTools()` — loop sem streaming. |
| `src/services/chatTools.ts` | 173–221 | `continueToolStream()` — loop com streaming. |
| `src/services/chatTools.ts` | 223–352 | Parsing de SSE e montagem de `tool_calls` a partir dos deltas. |
| `src/services/llama.ts` | 10–41 | `chatCompletion()` — POST ao llama-server (tradução do `thinking`). |
| `src/routes/chat.ts` | 41–122 | Rota `POST /v1/chat/completions`. |
| `src/routes/tools.ts` | 5–8 | Rota `GET /v1/tools`. |
| `src/config/env.ts` | 4–19 | Variáveis de ambiente das tools. |

---

## 13. Resumo mental (fluxo do modelo)

1. O cliente envia `enable_tools: true` (ou `tools: [...]`).
2. O proxy injeta os **schemas** — o modelo "aprende" que existem 5 ferramentas, o que cada uma faz e que argumentos pedir.
3. O modelo lê a pergunta e decide: **responde sozinho** ou **emite `tool_calls`**.
4. Se emitir `tool_calls`, o proxy **executa a função JavaScript real** (`executeTool`) e devolve o resultado como mensagem `role: "tool"`.
5. Repete até resposta final (sem `tool_calls`) ou até `max_tool_rounds`.
6. A resposta final é um texto normal — e o cliente nunca precisa saber que tools foram usadas (no streaming, os `delta.tool_calls` aparecem no meio do SSE).
