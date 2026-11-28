// The card writer on its own: the instructions, the model call and reading its answer. Nothing here touches chats
// or the database, so the evals (backend/evals/next-step-card) run exactly what the app runs. chat.ts decides when a
// card is wanted at all and keeps it.
// Written the Claude Code way, like notes (compact.ts forkNotes): the reply's own request (instructions, tools, the
// chat and the reply just written) with the ask added as one more message, sent to the reply's own model and options.
// So it's read from the reply's cache, and the writer knows all the reply did: its commands, the agents it started,
// what's done and what isn't, not only the chat's words.
import { generateText, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import type { NextStep } from "@emplio/shared";
import { z } from "zod";
import type { Fork } from "./compact";

// the same word reader.ts uses; kept here so this file stays free of the database
const SILENT = "[SILENT]";

// Change these only with the evals: `bun run eval evals/next-step-card` in backend (.claude/skills/evals).
export const NEXT_STEP_RULES = [
  "STOP WORKING. Answer with TEXT ONLY, no tool calls. Your reply above is finished and the person is reading it; they never see this message or your answer to it.",
  "Now decide whether a small card under your reply would let them move the work forward with one tap, and write it if so. The card is your guess at their next move: what they would most likely say to you now, so it feels like you read their mind. Use everything you know: what they asked for, what you did, what is still running and what is left.",
  `Write a card only when one tap settles their next move. In every other case answer with exactly ${SILENT} and nothing else; a wrong or pointless card is worse than none. Write one when:`,
  "- Your reply asks a yes or no, or offers to do something: the card asks it.",
  "- Your reply names choices: the buttons are those choices.",
  "- The work they asked for is done and its next step is plain from what they asked: an invoice or quote they wanted made is ready, so sending it to that customer; a draft they asked to check first, so sending it; notes they wanted for the team, so sharing them. Offer that next step as a yes or no. Only a step that follows from their own request, never new work.",
  "- An agent is on one part of what they asked, and another part they asked for in the same chat hasn't been started and doesn't need that agent's result: offer to start it now, so nothing sits waiting (\"While the quotes come in, shall I proofread the brochure text?\"). Read their messages for every part they asked for and check which your reply or commands started.",
  `Answer ${SILENT} when:`,
  "- Nothing obvious comes next: a plain answer, a report with nothing to act on, small talk or thanks, or work that is simply done (a reminder set, a setting changed) with no follow-up they asked for. Don't invent a next step to keep things going.",
  "- You or your agents are still working, or you said what you will do next by yourself (\"I'll send you the table once it's done\", \"I'll try again this evening\"). That is your plan, not an offer: don't ask permission for it, or about its progress. Only a part they asked for that nothing has started yet gets a card (above); work that needs the running work's result waits for it. But \"I can …\" or \"if you'd like\" is an offer, and a question that ends your reply is a question, even after \"I'll\": those get their card.",
  "- Your own work failed or you couldn't do it (an error, a site down) and your reply offers nothing: let them say what's next. A problem in their business (an unpaid invoice, a bad review) is not a failure: an offer about it gets its card.",
  '- The answer has to be typed or sent: an amount, a date or time, a name, an address, the wording of something, a link, a file, or which one of things you didn\'t list. Never fill the buttons with guesses ("₹50,000", "Monday morning") and never write a button that only promises an answer ("Send the repo", "Yes, I\'ll send them", "Name the repository"). Don\'t turn the ask into a yes or no either ("Will you share the link?"): a yes doesn\'t bring the link.',
  "- Your reply asks or offers more than one thing and any of them needs typing: the typed answer is what it waits for.",
  'When you do write a card, answer with JSON only, no code fence: {"summary": "...", "question": "...", "buttons": ["...", "..."]}',
  "summary: one plain sentence, under 25 words, on where things now stand. Don't copy your reply's wording. Say what isn't done yet if that matters.",
  "question: the question your reply asks, or the offer or next step as a question, under 15 words, from you to them.",
  'buttons: 2 or 3 answers to that question, 1 to 3 words each, in their voice. For a yes or no: first the one that moves things forward ("Yes, send it"), then one that declines or waits ("Not yet"). For a pick: the choices as your reply named them ("Daily", "Weekly").',
  "Write in the language of the chat, in plain words a business owner uses. No facts or work the chat doesn't point to.",
].join("\n");
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

// The card for the reply that ends `messages`: the reply's request as it was sent, the reply included. Tools go
// along as definitions only (the cache needs them; nothing runs). Null for a tool call, a cut-off or a failure.
// `said` is the model's own words, for the evals to look at.
// The cache the Claude Code way (its skipCacheWrite): every option as the reply had it, but the one cache mark moves
// from the end of the request (the chat's automatic caching) to the reply's last message, the last point it shares
// with the chat. So the card reads the chat from the cache and saves only up to the reply, which the person's next
// message reads anyway; this ask is never saved, as nothing will start with it again.
export async function writeNextStep(fork: Fork, instructions: string | SystemModelMessage[], messages: ModelMessage[]): Promise<{ card: NextStep | null; said: string }> {
  const { cacheControl, ...openrouter } = ((fork.providerOptions as { openrouter?: Record<string, unknown> }).openrouter ?? {}) as Record<string, unknown>;
  const last = messages.at(-1);
  const marked = cacheControl && last ? [...messages.slice(0, -1), { ...last, providerOptions: { ...last.providerOptions, openrouter: { cacheControl } } } as unknown as ModelMessage] : messages;
  const { text, toolCalls, finishReason } = await generateText({
    model: fork.model,
    instructions,
    messages: [...marked, { role: "user", content: NEXT_STEP_RULES }],
    tools: Object.fromEntries(Object.entries(fork.tools).map(([k, t]) => [k, { ...t, execute: undefined }])) as ToolSet,
    providerOptions: { ...fork.providerOptions, openrouter } as never,
  });
  if (toolCalls.length || finishReason === "length") return { card: null, said: text };
  return { card: parseNextStep(text), said: text };
}
