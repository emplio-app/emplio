CREATE TABLE "processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sha" text NOT NULL,
	"title" text NOT NULL,
	"for" text DEFAULT 'client' NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts" text DEFAULT 'manual' NOT NULL,
	"every" text,
	"clients" text[],
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "process_runs" ADD COLUMN "inputs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processes_workspace_id_name_index" ON "processes" USING btree ("workspace_id","name");