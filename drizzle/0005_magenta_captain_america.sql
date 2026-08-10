CREATE TABLE "rsvp_tokens" (
	"token" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"target_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_used_at" timestamp with time zone,
	CONSTRAINT "rsvp_tokens_purpose_check" CHECK ("rsvp_tokens"."purpose" IN ('rsvp', 'interest'))
);
--> statement-breakpoint
ALTER TABLE "email_messages" DROP CONSTRAINT "email_messages_type_check";--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "allow_extra_visit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rsvp_tokens" ADD CONSTRAINT "rsvp_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_rsvp_token_target" ON "rsvp_tokens" USING btree ("person_id","purpose","target_date");--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_type_check" CHECK ("email_messages"."type" IN ('leadership_report', 'visitor_thankyou', 'approval_notice', 'weekly_export', 'rsvp_notice'));