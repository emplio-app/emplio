ALTER TABLE "connections" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "expires_at" timestamp with time zone;