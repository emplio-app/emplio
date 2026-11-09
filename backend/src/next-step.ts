// The card writer on its own: the instructions, the model call and reading its answer. Nothing here touches chats
// or the database, so the evals (backend/evals/next-step-card) run exactly what the app runs. chat.ts nextStep decides
// when a card is wanted at all and remembers it.
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { NextStep } from "@emplio/shared";
import { z } from "zod";

// fast and cheap, whatever the chat itself runs on
export const NEXT_STEP_MODEL = "openai/gpt-5.6-luna";

// the same word reader.ts uses; kept here so this file stays free of the database
const SILENT = "[SILENT]";

// Kept cheap: a small model, and a prompt that only grows at its end (fixed instructions, then the chat as it was)
// so the provider's prompt cache covers everything but the newest turn.
// Change these only with the evals: `bun run eval evals` in backend (.claude/skills/evals).
export const NEXT_STEP_RULES = [
  "After each reply from an AI employee, you decide whether a small card under it would let the person move the work forward with one tap, and write the card if so.",
  `Most replies get no card. Write one only when the last reply asks the person something, or offers to do something, that a single tap settles: a yes or no, or a pick between choices the reply itself named. In every other case reply with exactly ${SILENT} and nothing else. So ${SILENT} when:`,
  "- The work is finished, or it was a plain answer, a report or small talk. Nothing waits on the person; don't invent a question to keep things going.",
  "- The AI employee said it is still working, or said what it will do next by itself (\"I'll try again this evening\"). That is its plan, not an offer: don't ask permission for it.",
  '- The answer has to be typed or sent: an amount, a date or time, a name, an address, the wording of something, a link, a file, or which one of things the reply didn\'t list. Never fill the buttons with guesses ("₹50,000", "Monday morning") and never write a button that only promises an answer ("Send the repo", "Yes, I\'ll send them", "Name the repository"). Don\'t turn the ask into a yes or no either ("Will you share the link?"): a yes doesn\'t bring the link.',
  "- The reply asks or offers more than one thing and any of them needs typing: the typed answer is what it waits for.",
  'When you do write a card, reply with JSON only, no code fence: {"summary": "...", "question": "...", "buttons": ["...", "..."]}',
  "summary: one plain sentence, under 25 words, on what was just said or done and where things now stand. Use the whole chat, so it's useful even when the last reply is short. Don't copy the reply's wording. Say what isn't done yet if that matters.",
  "question: the question the last reply asks, or the offer it makes turned into a question, under 15 words, from the AI employee to the person. Never a new one.",
  'buttons: 2 or 3 answers to that question, 1 to 3 words each, in the person\'s voice. For a yes or no: first the one that moves things forward ("Yes, send it"), then one that declines or waits ("Not yet"). For a pick: the choices as the reply named them ("Daily", "Weekly").',
  "Write in the language of the chat, in plain words a business owner uses. Only offer what the chat points to: no new facts, no work nobody talked about.",
].join("\n");
const NEXT_STEP_ASK = `Write the card for the last reply: JSON only, or ${SILENT}.`;
const HISTORY_LIMIT = 2000;
const nextStepShape = z.object({
  summary: z.string().trim().min(1).max(300),
  question: z.string().trim().min(1).max(200),
  buttons: z.array(z.string().trim().min(1).max(40)).min(2).max(3),
});

// A button that only promises an answer ("Send the repo", "I'll type it") instead of being one: tapping it tells
// Emplio nothing. A real go-ahead ("Send it", "Send the email") is fine.
const GIVE = "(send|share|give|type|enter|provide|upload|attach|tell|name|add)";
// ponytail: a word list, so it only catches the common shapes; the evals' judge catches the rest
const PROMISE = new RegExp(`^(yes, )?((i'?ll|i will) ${GIVE}\\b|${GIVE} (you|my|the (repo|repository|link|file|logo|name|address|details|number|date|amount))\\b)`, "i");
export const promises = (button: string) => PROMISE.test(button.trim().replace(/’/g, "'"));

// anything but a well-formed card (including SILENT, and a card with a promise button) is no card
export function parseNextStep(text: string): NextStep | null {
  try {
    const card = nextStepShape.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    return card.buttons.some(promises) ? null : card;
  } catch {
    return null;
  }
}

export type Turn = { role: "user" | "assistant"; text: string };

// The card for a chat whose last turn is Emplio's reply. `said` is the model's own words, for the evals to look at.
export async function writeNextStep(turns: Turn[], llm: LanguageModel): Promise<{ card: NextStep | null; said: string }> {
  // older turns are dropped 40 at a time, not one per reply, so the start of the prompt stays the same
  const kept = turns.slice(turns.length <= 80 ? 0 : Math.floor((turns.length - 40) / 40) * 40);
  const history: ModelMessage[] = kept.flatMap((t) => (t.text ? [{ role: t.role, content: t.text.slice(0, HISTORY_LIMIT) }] : []));
  // a long last reply goes in whole here, at the end, so the chat before it still matches what's cached
  const reply = turns.at(-1)?.text ?? "";
  const ask = reply.length > HISTORY_LIMIT ? `${NEXT_STEP_ASK}\n\nThe last reply in full:\n${reply}` : NEXT_STEP_ASK;
  const { text } = await generateText({
    model: llm,
    providerOptions: { openrouter: { cacheControl: { type: "ephemeral" }, reasoning: { effort: "low" } } },
    system: NEXT_STEP_RULES,
    messages: [...history, { role: "user", content: ask }],
    maxOutputTokens: 400,
  });
  return { card: parseNextStep(text), said: text };
}
