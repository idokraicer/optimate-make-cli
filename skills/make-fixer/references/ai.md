# AI in Make Scenarios

Load when a scenario uses AI: provider modules (OpenAI, Anthropic, Gemini, Make AI Tools) or the Make AI Agent
module and its tools.

## Pick the lightest option

| The step needs | Use |
|---|---|
| Same output for the same input (sync, transform, notify) | ordinary modules, filters, if-else — no AI |
| AI content with fixed parameters (summarize, translate, classify into known labels) | a provider module, or HTTP to the provider |
| Judgment over which tools to call, how often, with what arguments | `ai-local-agent:RunLocalAIAgent` (confirm with `make-fixer modules`) |

An agent is non-deterministic, slower and costlier. Live or account data reaches it **only through a tool**.

## Cost and reliability patterns

- **Constrain the output.** "Respond ONLY with one of: Qualified / Not Qualified" makes the result a reliable
  filter value.
- **Get several labels in one call** ("Category: …\nUrgency: …") and parse them with `substring`/regex. This
  avoids one call per label.
- Calling a provider through the HTTP module can cost fewer credits than Make's premium AI modules. Compare
  before choosing.
- **Guard an empty AI result** before the output module (`references/error-handling.md`, ThrowError guard).
- **Log AI outputs** to a data store or sheet for prompt debugging and audit.
- **Human review gate** for high-stakes actions: send the draft for approval and act only once approval
  arrives.

## Make AI Tools (`ai-tools:*`)

`model` is required and has no default:
- With a **Make AI Provider** connection, use the tier slugs `small` / `medium` / `large`. A provider model
  ID such as `gpt-4o-mini` is rejected.
- With the provider's own app (OpenAI, Anthropic, Gemini), use provider model IDs.

## Make AI Agent module

`ai-local-agent:RunLocalAIAgent`:
- **Connection:** the AI provider. The provider is locked once the agent exists.
- **Key mapper fields:**
  - `message` — the per-run input;
  - `systemPrompt` — the most important field;
  - `defaultModel` — dynamic, so pick it from the UI or an existing blueprint;
  - `threadId` — a stable ID (chat or ticket ID) gives the agent memory across runs; leave it empty for
    stateless runs.
- **Optional fields:** `outputType` (text or a structured schema), `modelConfig` (`recursionLimit`,
  `tokenLimit`), `timeout`.
- The agent emits **one bundle per run**, however many tools it called. Knowledge files and MCP tools are
  configured in the Make UI.
- **Tools** are nested flows hanging off the agent:
  - Each tool's name and description tell the agent when to call it, so write them like any tool-calling
    spec.
  - A field the agent should fill at run time maps to the **agent's own ID** (`{{2.city}}`). Give it an
    `aiHelp` format hint and, where the choice isn't obvious, an `aiInstruction`.
  - A multi-step tool should be a `CallSubscenario` to an on-demand scenario. Its declared interface becomes
    the tool's arguments and result (`references/architecture.md`).
- A webhook-triggered agent whose caller expects the answer must end with `gateway:WebhookRespond`.

The agent's blueprint JSON shape isn't verified here. Before editing one, fetch an existing agent scenario
and copy its structure.
