# Evals

Tests check code. Evals check the model: the same chats run through the same instructions the app uses, and each
answer is marked. Run them before changing any instructions or the model behind them.

One folder per behaviour:

```
evals/
  failures.ts               what went wrong in a run, in the terminal
  next-step-card/           the card under a reply (src/next-step.ts)
    cases.ts                the chats, and what should happen after each
    scorers.ts              how an answer is marked
    scorers.test.ts         the markers themselves, checked by `bun test`
    next-step-card.eval.ts  runs the app's own writer over the cases
```

## Run

From `backend/`, with `OPENROUTER_API_KEY` set (in `.env`):

```bash
bun run eval evals                             # every behaviour
bun run eval evals/next-step-card              # one
EVAL_EXPERIMENT=card-shorter-rules bun run eval evals/next-step-card   # name the run, to compare later
EVAL_MODEL=google/gemini-3.8-flash bun run eval evals/next-step-card   # try another model on the same cases
bun run eval evals --no-send-logs              # no Braintrust account: scores print here only
bun evals/failures.ts <experiment name>        # what failed, and what the model wrote
```

Results go to [Braintrust](https://www.braintrust.dev) (free plan is enough), where two runs can be compared
case by case. Once: `bt login --oauth`, then `bt init` in the repo and pick your project. `.bt/` stays out of git.

Cases are sent to Braintrust, so never paste a real customer's chat: rewrite it with made-up names and numbers.

Adding a behaviour, or changing instructions with the evals: `.claude/skills/evals/SKILL.md`.
