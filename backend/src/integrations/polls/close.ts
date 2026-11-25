// Close reports everything it has by webhook (own/close/triggers.ts): leads, contacts, opportunities, tasks, every
// activity, imports, exports, bulk actions, custom fields, statuses, templates, sequences and comments. Nothing to poll.
import type { PollTrigger } from "./index";

export const close: Record<string, PollTrigger> = {};
