import type { PollTrigger } from "./index";

// Every Clockify event comes by webhook (own/clockify/triggers.ts), so nothing is polled.
export const clockify: Record<string, PollTrigger> = {};
