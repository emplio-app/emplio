CREATE TABLE "web_push_devices" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"session_hash" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_push_devices" ADD CONSTRAINT "web_push_devices_session_hash_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_push_devices_session_hash_index" ON "web_push_devices" USING btree ("session_hash");