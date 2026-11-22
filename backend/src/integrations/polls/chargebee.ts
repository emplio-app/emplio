// Chargebee reports every event by webhook (own/chargebee/triggers.ts), so nothing here is polled.
import type { PollTrigger } from "./index";

export const chargebee: Record<string, PollTrigger> = {};
