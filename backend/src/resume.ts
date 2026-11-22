// Replies a restart (a deploy) or a crash cut off are carried on once the server's back, so a person never has to
// say "continue". A reply someone started (not a check-in, task or automation: those run again on their own) logs
// a "message" when it starts and a "reply" when it ends (activity.ts); one left with no end was cut off.
// Its commands still running then were stopped, and the saved reply shows them so (chat.ts closeToolCalls).
import { generateId, type UIMessage } from "ai";
import { sql } from "drizzle-orm";
import { RESUMED_PREFIX } from "@emplio/shared";
import { personFor } from "./automations";
import { post, wroteFromPhone } from "./channels";
import { generateReply, lastWords } from "./chat";
import { db } from "./db";

// older than this, they've moved on: picking it up would only surprise them
const WITHIN = "30 minutes";

// ponytail: one server, so anything unfinished at startup is dead; with several, claim each one first (another may be running it)
export async function resumeCutOff() {
  const { rows } = await db.execute<{ conversationId: string; workspaceId: string; userId: string; kind: string; summary: string; byPerson: boolean | null }>(sql`
    select distinct on (conversation_id) conversation_id as "conversationId", workspace_id as "workspaceId", user_id as "userId", kind, summary,
      detail->>'byPerson' = 'true' as "byPerson"
    from activity
    where kind in ('message', 'reply') and conversation_id is not null and created_at > now() - ${WITHIN}::interval
      -- a job's chat carries on through its job (jobs.ts markOrphanedJobs), so it isn't told twice
      and conversation_id not in (select id from conversations where kind = 'job')
    order by conversation_id, created_at desc
  `);
  for (const c of rows) {
    // a resumed reply cut off again isn't tried a third time: something in it may be what keeps stopping the server
    if (c.kind !== "message" || !c.byPerson || c.summary.startsWith(RESUMED_PREFIX.trim())) continue;
    void resume(c).catch((error) => console.error(`chat ${c.conversationId}: resuming a cut-off reply failed`, error));
  }
}

async function resume(c: { conversationId: string; workspaceId: string; userId: string }) {
  const person = await personFor(c.workspaceId, c.userId);
  if (!person) return;
  const message: UIMessage = {
    id: generateId(),
    role: "user",
    parts: [
      {
        type: "text",
        text: `${RESUMED_PREFIX}The server restarted while you were replying, so your reply was cut off; a command running then was stopped. Carry on from where you stopped, without redoing what's done. Don't mention the restart unless something was lost.`,
      },
    ],
  };
  const log = { error: (obj: unknown, msg: string) => console.error(`chat ${c.conversationId}: ${msg}`, obj) };
  const stream = await generateReply(person, c.conversationId, message, log);
  if (!stream) return;
  let failed = false;
  for await (const chunk of stream) if (chunk.type === "error") failed = true;
  // no reply: the last one would go to their phone again
  if (failed) return;
  if (!(await wroteFromPhone(c.conversationId))) return;
  const text = await lastWords(c.conversationId);
  if (text) await post(c.workspaceId, c.userId, text, { inChat: true });
}
