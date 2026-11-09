CREATE TABLE "paid_sites" (
	"workspace_id" uuid NOT NULL,
	"site" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_sites_workspace_id_site_pk" PRIMARY KEY("workspace_id","site")
);
--> statement-breakpoint
ALTER TABLE "paid_sites" ADD CONSTRAINT "paid_sites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;