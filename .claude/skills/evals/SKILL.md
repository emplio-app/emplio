---
name: evals
description: Write, run and improve Emplio's evals - the checks on what the model does, not the code. Use when asked to add evals for a behaviour ("write evals for the card", "eval the hand-off decision"), when changing any instructions the model reads or the model behind them, when a wrong answer from Emplio is reported ("it showed a card when it shouldn't", "it picked the wrong command"), or to compare models on a behaviour.
---

# Evals

Input: a behaviour of Emplio that a model decides. Output: one PR with its cases, its markers, a before and after
score, and the instructions changed until the score holds.

Everything lives in `backend/evals/`, one folder per behaviour; `backend/evals/next-step-card/` is the worked example
to copy for a single model call, `backend/evals/hand-off/` for a choice Emplio makes while working. Results go to Braintrust (org and project from `.bt/config.json`); the cases stay in the repo so anyone can
run them and they're reviewed like code.

## 1. Pick one decision, and make it callable

Never "eval Emplio". Pick one decision that has a right answer: card or no card, hand off or do it here, which
command, silent or speak.

The eval must run **the app's own code**: its instructions, its model, its way of reading the answer. If that code
is tangled up with chats, the database or billing, first move the model call into a file with none of that, taking
plain input and a model (`src/next-step.ts`: `writeNextStep(turns, llm)`), and have the app call it. Never copy
instructions into the eval: a copy drifts and the score lies.

## 2. Name what goes wrong

Before any case, write the ways it fails as a short list of categories, each with one line on what should happen
instead (top of `cases.ts`). Three kinds:

- wrong and fixable by instructions or code: these are what the eval is for
- wasteful but not wrong (too long, an extra step): mark separately, fix second
- not the model's fault (a site down, a provider error): leave out

## 3. Cases

`cases.ts`: each case is the input at the moment of the decision, what should happen, a category and a name.

- Start from what really happened. A wrong answer seen in a real chat is the best case there is: add it the day it's
  seen, marked `source: "real"`.
- Real chats never go in as they are: cases are sent to Braintrust. Rewrite with made-up names, numbers and addresses.
- Until there are enough real ones, write cases to cover each category (`source: "written"`). Write them like a busy
  owner types: short, lower case, half the story.
- Cover both sides. Every "must not" category needs "must" cases next to it, or the easy win is to never do the thing
  (a card writer that always stays silent scores well on "no card" cases).
- Include the near misses: the case that looks like one category and is the other ("which of your two repos, emplio
  or docs?" names its choices; "which repo?" doesn't).
- 30 to 40 cases is enough to start. `scorers.test.ts` checks the cases are well formed.

## 4. Markers

`scorers.ts`. Plain code first: it's free, instant and never changes its mind.

- One main mark, 0 or 1, for the decision itself (`right_call`). This is the number to quote.
- More marks for the rules around it (size limits, named choices present). Return `score: null` where a mark doesn't
  apply, so it isn't counted.
- Put the reason in `metadata`; it shows in Braintrust and in `failures.ts`.
- A model as judge only for what code can't see, one question, PASS or FAIL then one sentence. Use a stronger model
  than the one being checked. Give it room to answer (`maxOutputTokens` 1000: 100 came back empty, and an empty
  answer was being counted as a fail), and throw on an empty answer instead of marking 0.
- Read the judge's reasons on the first run. Ours failed "Not yet" and "Both" as things the chat never mentioned;
  the judge's instructions were wrong, not the cards.
- Unit-test the code markers (`scorers.test.ts`).

## 5. The eval file

`<behaviour>.eval.ts`, copied from the card's: `Eval("Emplio", { data, task, scores, trialCount: 3 })`.

- `trialCount: 3`: the model doesn't answer the same way twice. A case passes when it passes every time.
- `metadata` carries the model and the instructions, so every run in Braintrust shows what it was run with.
- `EVAL_MODEL` and `EVAL_EXPERIMENT` come from the environment.

## 6. Run, read, change, run

```bash
cd backend
EVAL_EXPERIMENT=<behaviour>-0-before bun run eval evals/<behaviour>     # first, before touching anything
bun evals/failures.ts <behaviour>-0-before                         # read every failure
```

Then change the instructions and run again under a new name (`-1-what-changed`, `-2-...`). The run prints the
difference from the last one. In order of preference:

1. **Fix a category, not a case.** If a change only moves one case, it's overfitting. Write the rule for the kind of
   chat, and say why in the rule ("a yes doesn't bring the link"): the model generalises from the reason.
2. **Put the decision before the format.** The card writer got it right once its instructions opened with "most
   replies get no card, write one only when…" and listed when to stay silent, before saying what a card looks like.
3. **Show the bad answers.** Quote two or three real wrong outputs in the rule ("₹50,000", "Send the repo").
4. **Make it strict in code** where a rule must never break: the card with a promise button is dropped by
   `parseNextStep`, whatever the model wrote. A code check beats the tenth sentence of instructions.
5. **Fix the case or the marker** when they're what's wrong. A case that can be read both ways teaches nothing:
   rewrite it so it's clearly one thing.

After the score stops moving, add five to ten cases you haven't run yet, across the categories. If they pass, the
rules generalise; if they don't, the rules were fitted to the old cases. Done is the main mark at 90 to 95% or more. Don't keep rewriting instructions for the last one or two slips unless
the fix is tiny and sure: say what's left instead.

Each rule in the instructions has its check in the markers. Change one, change the other, in the same PR.

## 7. Hand over

One PR: the callable code, the eval folder, the changed instructions. In its description: the main mark before and
after, how many cases and tries, the experiment names, and what is still weak (which cases are written, not real).
Add the behaviour to the tree in `backend/evals/README.md`.

## Behaviours where Emplio runs commands

The card is one model call. Most of what Emplio decides shows in the commands it runs: handing off, reading a skill,
saving one, filing a fact. `backend/evals/emplio.ts` is the harness for those; `hand-off/`, `skills/` and
`background-round/` are the examples to copy.

- **The app's own instructions, for a made-up business.** `reply()` builds the prompt with the app's functions
  (`emplioPrompt`, `agentRules`, `sandboxPrompt`, the note on each message) and offers the same bash tool. When the
  wording you need is built inline in the app, move it into an exported function there and call it from both: a pure
  move, no words changed.
- **Nothing is run.** Each command gets a stand-in result and the markers read the commands: `emplio hand <pick>`,
  `emplio skills use <name>`, a write to `skills/<name>/SKILL.md`. Mark by code; no judge was needed.
- **The stand-in computer is the weak point, not Emplio.** Emplio looks around before it decides, and when its
  commands come back with nonsense it notices and stops ("my tools returned placeholder text"). The first runs of
  three evals scored 60 to 80% for this reason alone. Before believing a failure, read what it wrote: if it's
  confused by a result, fix the result. `pretend()` answers the everyday commands like a shell would; a case whose
  job has to finish gives its own results in `world`.
- **Replay the server too.** A choice the server steers (the reminder at 4 commands, the stop at 8) is replayed with
  the app's own `remindAt`, `longRunNote` and `TOO_MANY`, so the eval sees what Emplio would really be told.
- **Cases must be clear.** "Build a small page" is one file: quick, not long. A preference about every customer
  message is a business rule. When Emplio's answer is defensible, the case is wrong.
- **Load the app when a case runs, not at the top of the eval file.** The app's files wait on things as they load,
  and the runner then fails with "Cannot access ... before initialization". `import type` at the top, `await
  import()` inside `data` and `task`, and one shared promise when the task uses the import straight away
  (`reader/reader.eval.ts`).
- Change instructions only when the same kind of case fails for a reason that is Emplio's. The four evals after the
  card needed no change to any instructions.

## What the card taught us

- Before: 53% right calls. The first idea, one more rule at the end of the instructions, got 90%. Rewriting them
  silent-first got 97%, two more reasons-in-rules got 99%, and the code check on promise buttons closed it.
- The small model's commonest fault was being helpful: inventing a question, guessing answers for the buttons,
  asking permission for what Emplio had already said it would do. Expect the same in other behaviours.
- A run is about 120 cheap calls and 60 judge calls: a few cents and two minutes. There's no reason to change
  instructions without one.
