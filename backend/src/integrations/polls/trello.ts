import type { PollTrigger } from "./index";

// every Trello event comes by webhook (own/trello/triggers.ts), so nothing is polled
export const trello: Record<string, PollTrigger> = {};
