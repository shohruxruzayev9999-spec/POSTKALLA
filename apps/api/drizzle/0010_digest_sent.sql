ALTER TABLE "digests" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
-- Digests created before this column existed were already sent (or deliberately not): never send them again.
UPDATE "digests" SET "sent_at" = "created_at" WHERE "sent_at" IS NULL;
