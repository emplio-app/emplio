DROP INDEX "client_fields_workspace_id_key_index";--> statement-breakpoint
ALTER TABLE "client_fields" ADD COLUMN "kind" text DEFAULT 'client' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "client_fields_workspace_id_kind_key_index" ON "client_fields" USING btree ("workspace_id","kind","key");