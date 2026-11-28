ALTER TABLE "automations" ADD COLUMN "who" text;--> statement-breakpoint
ALTER TABLE "processes" DROP COLUMN "starts";--> statement-breakpoint
ALTER TABLE "processes" DROP COLUMN "every";--> statement-breakpoint
ALTER TABLE "processes" DROP COLUMN "clients";