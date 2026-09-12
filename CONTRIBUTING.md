# How we work today

Three hours. Four people. The process exists to stop us blocking each other,
nothing more.

## Branches

`main` is protected. Everything arrives by PR.

| Branch | Owner | Folder |
| --- | --- | --- |
| `adapters` | Person 1 | `adapters/**` |
| `detection` | Person 2 | `core/detection/**`, `prompts/detector/**` |
| `action` | Person 3 | `core/action/**`, `prompts/policy/**`, `prompts/compose/**` |
| `harness` | Person 4 | `harness/**`, `scripts/**`, `.github/**` |

Stay in your folder. If you need something from somebody else, you need their
mock or their contract, not their file.

### Protecting main (do this once, at the start)

```bash
gh repo create <org>/cluebro --public --source=. --push

gh api -X PUT repos/{owner}/{repo}/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f "required_status_checks[strict]=false" \
  -f "required_status_checks[contexts][]=check" \
  -F "enforce_admins=false" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "restrictions=null"
```

If that fight takes more than five minutes, set the rule socially instead — "no
direct pushes to main, no exceptions" — and get back to building. A protected
branch you spent 20 minutes configuring is worse than an agreement you spent
20 seconds on.

## Pull requests

Three lines. The template asks for exactly this:

```
Contract touched:  none
Mock used:         core/detection/mock.ts fixtureDetector
How to check it:   npm run replay:demo
```

- **Contract touched** — anything other than `none` needs a heads up in the
  channel *before* merge. It changes everyone's world at once.
- **Mock used** — says what you developed against, which tells the reviewer
  what has not been tested for real yet.
- **How to check it** — an exact command that passes with no live Slack and no
  API key. If your change cannot be checked that way, say why.

One approval. Review for "does this break somebody else", not for style. We
have no ESLint on purpose: arguing about formatting today is a loss.

Small PRs. If your diff is over 400 lines, it is two PRs.

## Frozen after CP1

| Path | Why |
| --- | --- |
| `contracts/src/**` | changing a schema changes all four folders simultaneously |
| `prompts/loader.ts` | both cores depend on it at runtime |
| `harness/pipeline.ts` | the wiring everybody's work flows through |

Frozen does not mean untouchable. It means: raise it at a checkpoint, with
everyone present, and merge it as its own PR that nothing else is stacked on.

Adding an **optional** field with a default to a contract is safe and does not
need a checkpoint:

```ts
new_field: z.string().nullable().default(null),
```

## What CI checks, and why it is only this

```bash
npm run ci    # about 20 seconds locally, under 2 minutes on Actions
```

1. `typecheck` — TypeScript is the lint. No ESLint config to argue about.
2. `check:boundaries` — fails if anything in `core/` imports a Slack SDK, an
   adapter, the harness, a model vendor, or reads `process.env`. This is the
   architecture rule, enforced instead of remembered.
3. `validate:contracts` — every fixture parses, every deliberately-invalid
   fixture is rejected, every replay transcript is valid.
4. `check:units` — each owner's own `check.ts`, discovered automatically. You
   never edit a shared file to register a test.
5. `smoke` — the whole pipeline over three saved conversations, no network, no
   keys.

Speed over coverage. A check nobody waits for protects nothing.

## Adding your own checks

Create `check.ts` in your folder:

```ts
import { check, report } from "../../scripts/expect";

check("a question with an answer is left alone", outcome.act === false);
report("my thing");
```

`npm run check:units` finds it. No registration, no config, no conflict.

## Commits

Plain sentences. `slack: strip mention markup before emitting` beats
`fix stuff`. Nobody is grading the history, but somebody will be reading it at
minute 130 trying to work out what changed.
