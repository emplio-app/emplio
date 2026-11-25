ALTER TABLE "conversations" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "process_runs" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "client" text;--> statement-breakpoint
CREATE INDEX "process_runs_workspace_id_client_index" ON "process_runs" USING btree ("workspace_id","client");--> statement-breakpoint
CREATE INDEX "tasks_workspace_id_client_index" ON "tasks" USING btree ("workspace_id","client");--> statement-breakpoint
-- tasks, process runs and chats point at the client's file name (its slug) instead of a clients row
UPDATE "tasks" SET "client" = c."slug" FROM "clients" c WHERE c."id" = "tasks"."client_id";--> statement-breakpoint
UPDATE "process_runs" SET "client" = c."slug" FROM "clients" c WHERE c."id" = "process_runs"."client_id";--> statement-breakpoint
UPDATE "conversations" SET "client" = c."slug" FROM "clients" c WHERE c."id" = "conversations"."client_id";
