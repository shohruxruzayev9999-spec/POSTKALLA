ALTER TABLE "tasks" ADD COLUMN "recurrence" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repeated_from_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeated_from_id_tasks_id_fk" FOREIGN KEY ("repeated_from_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_repeated_from_uq" ON "tasks" USING btree ("repeated_from_id");