ALTER TABLE "processes" ADD COLUMN "private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "private" boolean DEFAULT false NOT NULL;