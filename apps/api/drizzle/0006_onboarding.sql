CREATE TABLE "onboarding_acks" (
	"doc_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"acked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_acks_doc_id_user_id_pk" PRIMARY KEY("doc_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "onboarding_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"emoji" text DEFAULT '📘' NOT NULL,
	"color" text DEFAULT '#34D399' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"department_ids" uuid[] DEFAULT '{}' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_acks" ADD CONSTRAINT "onboarding_acks_doc_id_onboarding_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."onboarding_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_acks" ADD CONSTRAINT "onboarding_acks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_docs" ADD CONSTRAINT "onboarding_docs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_docs" ADD CONSTRAINT "onboarding_docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_docs_company_idx" ON "onboarding_docs" USING btree ("company_id");