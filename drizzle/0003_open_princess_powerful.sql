ALTER TABLE "settings" ALTER COLUMN "report_send_time" SET DEFAULT '17:30';--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "thankyou_send_time" SET DEFAULT '17:00';--> statement-breakpoint
UPDATE "settings" SET "report_send_time" = '17:30', "thankyou_send_time" = '17:00' WHERE "id" = 1 AND "report_send_time" = '18:00' AND "thankyou_send_time" = '17:30';