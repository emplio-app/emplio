ALTER TABLE "automations" ADD COLUMN "clients" text[];--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "due_days" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeat_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_workspace_id_repeat_key_index" ON "tasks" USING btree ("workspace_id","repeat_key");