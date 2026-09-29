CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"from_telegram_id" bigint,
	"from_name" text DEFAULT '' NOT NULL,
	"user_id" uuid,
	"is_team" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'TEXT' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"file_name" text,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_uq" ON "chat_messages" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_project_idx" ON "chat_messages" USING btree ("project_id","sent_at");