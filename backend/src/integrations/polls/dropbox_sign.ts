import type { PollTrigger } from "./index";

// none: every Dropbox Sign event comes by webhook (own/dropbox_sign/triggers.ts)
export const dropbox_sign: Record<string, PollTrigger> = {};
