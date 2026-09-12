# Submission checklist

> **Block the last 30 minutes for this and nothing else.**
>
> At T+150 stop building. Not "nearly done" — stop. Teams do not lose these
> things because their agent was bad, they lose them because at T+178 nobody
> had exported the video.
>
> `npm run clock` tells you when T+150 is.

## Status

| # | Item | Owner | Status |
| --- | --- | --- | --- |
| 1 | Project title | Person 4 | **drafted below, needs a yes** |
| 2 | Written description | Person 4 | **drafted below, needs a yes** |
| 3 | Public repository | Person 1 | **DONE** — public, CI green, no secrets tracked |
| 4 | 2 minute video | Person 4 | **TODO — the only blocker** |
| 5 | Social post tagging the sponsors | Person 2 | drafted below, not posted |
| 6 | Submission form filled in | Person 3 | TODO, blocked on 4 |

Update this table as things land. A visible TODO at T+170 is worth more than
somebody assuming it was handled.

Verified at the last integration drill:

- repo is public, `npm run ci` green on `main`, `npm run check:secrets` clean
  across 112 tracked files, and `.env` is untracked and gitignored
- all four branches merged, no open PRs
- `LLM_PROVIDER=fake npm run replay:demo` gives the same 3 interventions and 8
  explained silences every run, which is what [docs/DEMO.md](docs/DEMO.md) is
  written against

**Item 4 is the only thing standing between this and a submission.**

---

## 1. Title

One line, no jargon. It should say what it does, not what it is built with.

Draft: **ClueBro — the agent that knows when to stay quiet**

## 2. Written description

Three paragraphs, no more.

1. **What it is.** An agent that lives inside a Slack workspace as one more
   member of the team. Nobody invites it into a conversation, nobody mentions
   it. It reads the channels, works out on its own when it has something
   genuinely useful to add, and most of the time decides to say nothing.

2. **Why the silence is the hard part.** An agent that replies to everything is
   noise, and noise is why people mute bots on day two. Every decision passes
   two gates: confidence thresholds, a per-channel cooldown and a refusal to
   act on an uncited claim; then a model call that can veto something the
   thresholds already allowed. Every decision, including every silence, is
   logged with a typed reason you can read.

3. **Why it is not a Slack bot.** The core does not know Slack exists. It
   receives channel-agnostic context events through an adapter port and returns
   routing instructions that say *this person, privately* or *this surface,
   publicly*. Slack is the first adapter. A browser extension that supports an
   interviewer during a live call is the second, and it needed no change to the
   core. The build enforces this: CI fails if anything in `core/` imports a
   Slack SDK.

Include the one thing a judge will remember:

```
14:03:40 #product Luis: we should clean up the old feature flags at some point
  saw      plan_without_owner (0.66)
  decided  STAY QUIET [cooldown_active]
  because  Already spoke here 70s ago. Holding for 120s so the agent does not
           dominate the channel.
```

## 3. Public repository

- [ ] repo is **public** (check in an incognito window, do not assume)
- [ ] `README.md` starts with what it does, and `npm run replay:demo` works
      from a clean clone
- [ ] CI badge is green on `main`
- [ ] **no secrets committed**

```bash
npm run check:secrets        # also runs in CI on every push
```

It matches the shape of a real token rather than the prefix: our own docs say
"paste your `xoxb-` token here", and a looser grep reports those as leaks and
costs you ten minutes of panic at the worst moment. It scans tracked files, so
an untracked `.env` is fine — that is where a token is supposed to live.

It also runs in CI, so a leak is blocked before it lands rather than found
after the repo is already public. To check the history as well:

```bash
git log --all -p | grep -nE 'xox[baprs]-[0-9]{6,}-|xapp-[0-9]-[A-Z0-9]{6,}-|sk-[A-Za-z0-9_-]{20,}' | head
```

If either prints anything, rotate that token immediately. Do not try to
rewrite history at T+160 — a rotated token is harmless even if it stays in the
log.

## 4. Two minute video

Record `LLM_PROVIDER=fake npm run replay:demo`, not live Slack. The replay is
deterministic and cannot be taken away by wifi -- but only with the provider
pinned. The `.env` now selects `openai`, and that run varies between 0 and 3
interventions. [docs/DEMO.md](docs/DEMO.md) explains which to record with and
why; read that section before the first take.

| Time | Beat |
| --- | --- |
| 0:00–0:15 | The problem. Agents live in a window you have to visit. This one lives in the channel you are already in, and nobody invokes it. |
| 0:15–0:45 | Real Slack. Show the channel, the unanswered question, the reply appearing on its own. Screen recording, no narration over the top of it. |
| 0:45–1:20 | **The part that wins it.** The decision log. Scroll through the silences. Read one out loud: "it saw a plan with no owner, and it stayed quiet because it had already spoken 70 seconds ago." |
| 1:20–1:45 | The architecture in one sentence, with `npm run replay:meet` on screen: the same core, a live interview instead of Slack, nothing in `core/` changed. |
| 1:45–2:00 | What is next, and thanks. |

- [ ] recorded
- [ ] **under** 2:00
- [ ] audio is audible
- [ ] text on screen is legible at 720p — increase the terminal font before
      recording, not after
- [ ] uploaded and the link is **public**, not "anyone at my company"

## 5. Social post

- [ ] tags **@aitinkerers** and **@openai**
- [ ] uses the event hashtag for "Agents, Everywhere"
- [ ] video or the decision-log screenshot attached — the silence block is the
      image that makes people stop scrolling
- [ ] repo link
- [ ] posted from an account that is actually public

Draft:

> We built an agent that lives in Slack and mostly says nothing.
>
> No mentions, no slash commands. It reads the channel, decides on its own when
> it can actually help, and logs every time it chose silence — and why.
>
> Same core now runs in a browser during live calls. It never knew Slack existed.
>
> Built in 3 hours at #AgentsEverywhere with @aitinkerers and @openai

## 6. Submission form

- [ ] title
- [ ] description
- [ ] repo URL
- [ ] video URL
- [ ] social post URL
- [ ] team members listed
- [ ] **submitted**, and somebody other than the submitter has seen the
      confirmation

---

## The 15 minute panic plan

If at T+165 something is missing, in this order:

1. **No video?** Record `npm run replay:demo` in one take with no narration and
   add subtitles later. 40 seconds of a working decision log beats nothing.
2. **Slack broken?** The video is a replay anyway. Say so out loud in the
   description — a reproducible demo is a feature, not an excuse.
3. **Repo private?** One click. Check it in incognito.
4. **Description unwritten?** Paste the three paragraphs above.
