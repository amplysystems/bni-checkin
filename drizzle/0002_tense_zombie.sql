ALTER TABLE "email_messages" DROP CONSTRAINT "email_messages_type_check";--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "sending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_type_check" CHECK ("email_messages"."type" IN ('leadership_report', 'visitor_thankyou', 'approval_notice'));