CREATE TABLE "process_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"process" text NOT NULL,
	"process_title" text NOT NULL,
	"subject" text NOT NULL,
	"client_id" uuid,
	"period" text,
	"steps" jsonb NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"finished" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_by" uuid,
	"repeat_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "process" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "step_index" integer;--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "process_runs_workspace_id_process_status_index" ON "process_runs" USING btree ("workspace_id","process","status");--> statement-breakpoint
CREATE INDEX "process_runs_client_id_index" ON "process_runs" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "process_runs_workspace_id_repeat_key_index" ON "process_runs" USING btree ("workspace_id","repeat_key");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_process_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."process_runs"("id") ON DELETE cascade ON UPDATE no action;