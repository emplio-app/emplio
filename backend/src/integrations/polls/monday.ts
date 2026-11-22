import type { PollTrigger } from "./index";

// none: every monday.com event Emplio has a trigger for comes by webhook (own/monday/triggers.ts)
export const monday: Record<string, PollTrigger> = {};
