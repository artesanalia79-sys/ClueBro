# prompts

The agent behaviour lives here, not in the TypeScript.

Prompts are versioned files loaded at runtime. Every `Observation` and every
`ActionDecision` records the prompt id and version that produced it, so when
the agent says something embarrassing at minute 90 you can tell which wording
did it and roll back one file, instead of arguing about it.

## The four prompts

| id | file | job |
| --- | --- | --- |
| `detector.conversation_scan` | `detector/conversation_scan.v1.md` | read a window, name what is happening, including nothing |
| `policy.should_intervene` | `policy/should_intervene.v1.md` | the veto. Thresholds already passed, is speaking actually worth it? |
| `compose.channel_reply` | `compose/channel_reply.v1.md` | write a short public message |
| `compose.direct_message` | `compose/direct_message.v1.md` | write a private message to one person |

`registry.json` picks the active version for each id.

## How I change the agent behaviour

```bash
cp prompts/detector/conversation_scan.v1.md prompts/detector/conversation_scan.v2.md
# edit v2

npm run prompt:eval -- --version v1
npm run prompt:eval -- --version v2
npm run prompt:diff -- prompts/runs/detector.conversation_scan__v1__demo-main.json prompts/runs/detector.conversation_scan__v2__demo-main.json
```

`prompt:diff` prints every message where the two versions disagree, and ends
with the line that matters:

```
  would speak on    A: 3   B: 7
  B is LOUDER than A. Make sure that is what you want.
```

That is the whole point of this folder. The hard part of this product is the
restraint, and restraint is not something you can eyeball — you measure it.

When you are happy, point `registry.json` at the new version. Keep the old
file: rolling back should be a one line change, not a git archaeology session.

## Trying a version without editing the registry

```bash
PROMPT_VERSIONS=detector.conversation_scan=v2 npm run replay:demo
```

## Rules

- No prompt text in `.ts` files. Ever. `{{placeholders}}` are filled by the
  loader.
- Every prompt returns JSON, and every caller survives being handed garbage
  instead. Check `parseVerdict` and `parseVeto` before you change a response
  shape.
- A veto prompt that fails to parse **fails open** — it does not silence a
  decision the policy already justified. Silence must be a decision, never a
  side effect of a parse error.
- `runs/` is gitignored. Those are evidence for a decision, not product.

## Measuring against a real model

The fake provider is deterministic and never vetoes, so with
`LLM_PROVIDER=fake` you are measuring the harness, not the prompt. For real
numbers:

```bash
LLM_PROVIDER=openai npm run prompt:eval -- --version v2
```

`prompt:eval` prints a warning when it is running on the fake provider, so you
cannot mistake one for the other.
