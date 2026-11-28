CREATE TABLE "meeting_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"on" date NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"team_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"contact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"others" text[] DEFAULT '{}'::text[] NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_records_workspace_id_slug_index" ON "meeting_records" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "meeting_records_client_id_index" ON "meeting_records" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "meeting_records_project_id_index" ON "meeting_records" USING btree ("project_id");