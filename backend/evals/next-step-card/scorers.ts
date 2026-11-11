// How a card is marked. Plain code wherever a rule can be checked by code; one model judge for the single thing
// code can't see (whether a tap really answers the question). Each rule in next-step.ts NEXT_STEP_RULES has its
// check here: change one, change the other.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { NextStep } from "@emplio/shared";
import { generateText } from "ai";
import { promises, type Turn } from "../../src/next-step";
import type { Case } from "./cases";

export type Output = { card: NextStep | null; said: string };
type Args = { input: Turn[]; output: Output; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// The main number: a card exactly when one was wanted.
export function rightCall({ output, expected }: Args): Score {
  const got = !!output.card;
  return { name: "right_call", score: got === expected.card ? 1 : 0, metadata: { wanted: expected.card ? "card" : "no card", got: got ? "card" : "no card" } };
}

// The card keeps to its size: 2-3 buttons of 1-3 words, a summary under 25 words, a question under 15.
export function limitsOf(card: NextStep) {
  const over: string[] = [];
  if (words(card.summary) > 25) over.push("summary over 25 words");
  if (words(card.question) > 15) over.push("question over 15 words");
  for (const b of card.buttons) if (words(b) > 3) over.push(`button over 3 words: ${b}`);
  return over;
}
export function withinLimits({ output }: Args): Score {
  if (!output.card) return { name: "within_limits", score: null };
  const over = limitsOf(output.card);
  return { name: "within_limits", score: over.length ? 0 : 1, metadata: { over } };
}

// When the reply named the choices, the buttons carry them. And a card for a chat in Hindi is in Hindi.
export function offersNamed({ output, expected }: Args): Score {
  if (!output.card || (!expected.offers && !expected.devanagari)) return { name: "offers_named", score: null };
  const buttons = output.card.buttons.join(" | ").toLowerCase();
  const missing = (expected.offers ?? []).filter((o) => !buttons.includes(o));
  const wrongScript = !!expected.devanagari && !/[ऀ-ॿ]/.test(output.card.question + buttons);
  return { name: "offers_named", score: missing.length || wrongScript ? 0 : 1, metadata: { missing, wrongScript } };
}

const JUDGE_MODEL = "anthropic/claude-sonnet-5.5";
const JUDGE = [
  "You check a small card shown under a chat between a business owner and their AI employee. The card has a question and 2-3 buttons the owner can tap instead of typing.",
  "Answer PASS only if all of these hold:",
  "1. Tapping any one button, with nothing typed, is a complete answer to the card's question that the AI employee could act on right away.",
  "2. The question follows from the AI employee's last message: it is the question that message asks or the offer it makes, not something new.",
  "3. The buttons offer nothing the chat didn't mention. A button that declines, waits, or takes all or none of the named choices is fine.",
  "Otherwise answer FAIL. Reply with PASS or FAIL, then one short sentence saying why.",
].join("\n");

// Only where a card was wanted and came: does a tap really answer it? A promise button (which the app now drops,
// next-step.ts) fails without asking the judge.
export async function tapAnswers({ input, output, expected }: Args): Promise<Score> {
  if (!output.card || !expected.card) return { name: "tap_answers", score: null };
  const promised = output.card.buttons.filter(promises);
  if (promised.length) return { name: "tap_answers", score: 0, metadata: { why: `promise button: ${promised.join(", ")}` } };
  const chat = input.map((t) => `${t.role === "user" ? "Owner" : "AI employee"}: ${t.text}`).join("\n\n");
  const { text } = await generateText({
    model: createOpenRouter()(JUDGE_MODEL),
    system: JUDGE,
    prompt: `The chat:\n\n${chat}\n\nThe card:\n${JSON.stringify(output.card, null, 2)}`,
    maxOutputTokens: 1000,
  });
  // an empty answer is the judge failing, not the card: better no mark than a wrong one
  if (!text.trim()) throw new Error("the judge said nothing");
  return { name: "tap_answers", score: /^\W*PASS/i.test(text) ? 1 : 0, metadata: { why: text.trim() } };
}

export const scorers = [rightCall, tapAnswers, offersNamed, withinLimits];
