CREATE TABLE "client_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"options" text[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_handlers" (
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "client_handlers_client_id_user_id_pk" PRIMARY KEY("client_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "client_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"stage_id" uuid NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_clients" (
	"contact_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role" text,
	CONSTRAINT "contact_clients_contact_id_client_id_pk" PRIMARY KEY("contact_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"title" text,
	"org" text,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"client_id" uuid NOT NULL,
	"service_id" uuid,
	"lead_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"start_on" date,
	"due_on" date,
	"amount" numeric(14, 2),
	"currency" text,
	"period" text,
	"fee_note" text,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"done_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"amount" numeric(14, 2),
	"currency" text,
	"period" text,
	"price_note" text,
	"process" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "process_runs_workspace_id_client_index";--> statement-breakpoint
DROP INDEX "tasks_workspace_id_client_index";--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "process_runs" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "process_runs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_fields" ADD CONSTRAINT "client_fields_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_handlers" ADD CONSTRAINT "client_handlers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_handlers" ADD CONSTRAINT "client_handlers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_stages" ADD CONSTRAINT "client_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_stage_id_client_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."client_stages"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "contact_clients" ADD CONSTRAINT "contact_clients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_clients" ADD CONSTRAINT "contact_clients_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_fields_workspace_id_key_index" ON "client_fields" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "client_handlers_user_id_index" ON "client_handlers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_stages_workspace_id_lower_name_index" ON "client_stages" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "clients_workspace_id_slug_index" ON "clients" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "clients_name_index" ON "clients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_stage_id_index" ON "clients" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "contact_clients_client_id_index" ON "contact_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_workspace_id_slug_index" ON "contacts" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "contacts_workspace_id_lower_email_index" ON "contacts" USING btree ("workspace_id",lower("email"));--> statement-breakpoint
CREATE INDEX "contacts_name_index" ON "contacts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_id_slug_index" ON "projects" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "projects_client_id_index" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "projects_service_id_index" ON "projects" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "projects_lead_id_index" ON "projects" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_workspace_id_slug_index" ON "services" USING btree ("workspace_id","slug");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "activity_workspace_id_subject_kind_subject_id_created_at_index" ON "activity" USING btree ("workspace_id","subject_kind","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_workspace_id_client_id_created_at_index" ON "activity" USING btree ("workspace_id","client_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_client_id_index" ON "conversations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "process_runs_client_id_index" ON "process_runs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "process_runs_project_id_index" ON "process_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_client_id_index" ON "tasks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "tasks_project_id_index" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_id_slug_index" ON "workspace_members" USING btree ("workspace_id","slug");-- The links above to clients, projects, services and stages are checked at commit, not row by row: deleting a whole
-- business removes everything in one go (a row-by-row check fails partway), while deleting one client that still has
-- work is still refused. drizzle-kit can't say "deferrable", so it's written here by hand.
