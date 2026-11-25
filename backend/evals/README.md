# Evals

Tests check code. Evals check the model: the same chats run through the same instructions the app uses, and each
answer is marked. Run them before changing any instructions or the model behind them.

One folder per behaviour:

```
evals/
  failures.ts               what went wrong in a run, in the terminal
  emplio.ts                 Emplio as the evals run it: the app's own instructions for a made-up business, and a
                            stand-in computer that answers commands without running them
  next-step-card/           the card under a reply (src/next-step.ts)
  hand-off/                 does it do the work itself or hand it off, and to whom (src/jobs.ts MANAGER_PROMPT)
  job-report/               a job at the end of its work: checks before calling it done, reports what's true in the
                            shape the manager reads, asks when only the person can decide (src/jobs.ts RULES,
                            src/checks.ts, whose checks are replayed once)
  manager/                  Emplio as manager: every job to an agent, carry on its job or --new, no browser of its
                            own, the person's words kept, reports checked (src/jobs.ts MANAGER_PROMPT)
  workday/                  whole conversations: several pieces of work, jobs' reports coming back (half done, a
                            question, a failed send), the person answering; a fake computer keeps the jobs
  skills/                   does it read the skill that fits, and save one when a job is repeatable (src/sandbox.ts)
  reader/                   what the reader notices in a finished chat (src/reader.ts)
  background-round/         where the background agent puts what the reader noticed (src/heartbeat.ts)
  automation-outcome/       how an automation's run ends: failed when its work didn't get done, done otherwise
                            (src/automations.ts runMessage, outcome)
```

Each folder has `cases.ts` (the chats, and what should happen), `scorers.ts` (how an answer is marked),
`scorers.test.ts` (the markers themselves, checked by `bun test`) and `<name>.eval.ts` (runs the app's own code over
the cases).

Learning happens in three steps, each with its own evals: in the chat Emplio reads and saves skills (`skills`);
afterwards the reader notes what the chat held, including a way of working nobody saved (`reader`); then the
background agent files each note where it belongs (`background-round`).

## Run

From `backend/`, with `OPENROUTER_API_KEY` set (in `.env`):

```bash
bun run evals                                  # every behaviour at once, each in its own process (~2 min), on this machine:
                                               # scores printed, each answer in .evals/<name>.jsonl, logs in .evals/<name>.log
bun run evals manager job-report               # some of them
EVAL_SEND=1 bun run evals                      # send the runs to Braintrust too (the free plan stops taking them after a while)
EVAL_CONCURRENCY=8 bun run evals               # fewer cases at a time per eval (default 24), if the provider throttles
bun run eval evals/manager                     # one, the plain way
bun run eval evals/next-step-card              # one
EVAL_EXPERIMENT=card-shorter-rules bun run eval evals/next-step-card   # name the run, to compare later
EVAL_MODEL=google/gemini-3.8-flash bun run eval evals/next-step-card   # try another model on the same cases
bun run eval evals --no-send-logs              # no Braintrust account: scores print here only
bun run eval evals/reader                      # the cheapest one, to try things out
bun evals/failures.ts <experiment name>        # what failed, and what the model wrote
EVAL_DUMP=a.jsonl bun run eval evals/manager --no-send-logs   # keep each answer on disk
bun evals/manager/report.ts .evals/manager.jsonl .evals/manager.jsonl   # by category, then what failed
bun evals/manager/report.ts a.jsonl b.jsonl    # two runs side by side, by category, then what failed in b
bun evals/workday/report.ts a.jsonl b.jsonl    # the same for workday (EVAL_TRIALS=1 for a quick try)
```

Everything runs on the Save money models (Haiku) unless `EVAL_MODEL` says otherwise: what holds on the cheapest holds on the dearer ones. The card keeps its own small model, as in the app.

Results go to [Braintrust](https://www.braintrust.dev) (free plan is enough), where two runs can be compared
case by case. Once: `bt login --oauth`, then `bt init` in the repo and pick your project. `.bt/` stays out of git.

Cases are sent to Braintrust, so never paste a real customer's chat: rewrite it with made-up names and numbers.

Adding a behaviour, or changing instructions with the evals: `.claude/skills/evals/SKILL.md`.
