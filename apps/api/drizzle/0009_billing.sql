CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"months" integer NOT NULL,
	"amount" bigint NOT NULL,
	"discount_pct" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"method" text,
	"contact" text,
	"note" text,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"paid_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "plan" text DEFAULT 'TRIAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "plan_until" date;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_requests_company_idx" ON "payment_requests" USING btree ("company_id","created_at");
--> statement-breakpoint
-- Companies that existed before billing (the founding agencies) keep every feature with no end date.
UPDATE "companies" SET "plan" = 'PREMIUM', "plan_until" = NULL;
