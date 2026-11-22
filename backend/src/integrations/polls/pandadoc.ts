import type { PollTrigger } from "./index";

// Every PandaDoc event comes by webhook (own/pandadoc/triggers.ts), so nothing is polled.
export const pandadoc: Record<string, PollTrigger> = {};
