CREATE TABLE "task_checklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"board" text DEFAULT 'main' NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"color" text DEFAULT '#34D399' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "section" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "column_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "format" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "links" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_checklist" ADD CONSTRAINT "task_checklist_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_columns" ADD CONSTRAINT "task_columns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_checklist_task_idx" ON "task_checklist" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_columns_company_board_idx" ON "task_columns" USING btree ("company_id","board");--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_task_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."task_columns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "departments" SET "section" = 'DESIGN' WHERE "name" ~* '(dizayn|design)';
--> statement-breakpoint
UPDATE "departments" SET "section" = 'MEDIA' WHERE "name" ~* '(video|montaj|media|mobilograf|edit)';
