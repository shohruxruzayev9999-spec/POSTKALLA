CREATE TABLE "project_months" (
	"project_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"month" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb DEFAULT '{"tasks":[],"columns":[]}'::jsonb NOT NULL,
	CONSTRAINT "project_months_project_id_month_pk" PRIMARY KEY("project_id","month")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "planned_month" text;--> statement-breakpoint
ALTER TABLE "project_months" ADD CONSTRAINT "project_months_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_months" ADD CONSTRAINT "project_months_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_months_company_idx" ON "project_months" USING btree ("company_id");