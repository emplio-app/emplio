-- the client_id columns take their foreign keys and indexes with them; clients/<slug>.md holds what the table did
ALTER TABLE "conversations" DROP COLUMN "client_id";--> statement-breakpoint
ALTER TABLE "process_runs" DROP COLUMN "client_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "client_id";--> statement-breakpoint
DROP TABLE "clients";
