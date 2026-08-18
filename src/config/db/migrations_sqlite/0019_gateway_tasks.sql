CREATE TABLE `gateway_task` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text DEFAULT 'image_generation' NOT NULL,
	`request_ledger_id` text NOT NULL,
	`user_id` text NOT NULL,
	`portal_key_id` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`newapi_task_id` text,
	`provider_task_id` text,
	`next_poll_at` integer,
	`poll_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`terminal_evidence_json` text,
	`result_cache_json` text,
	`result_url_expires_at` integer,
	`submitted_at` integer,
	`processing_at` integer,
	`meter_pending_at` integer,
	`completed_at` integer,
	`failed_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`request_ledger_id`) REFERENCES `request_ledger`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portal_key_id`) REFERENCES `portal_api_key`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_gateway_task_type" CHECK("gateway_task"."task_type" = 'image_generation'),
	CONSTRAINT "ck_gateway_task_status" CHECK("gateway_task"."status" IN ('submission_unknown','submitted','processing','meter_pending','completed','failed_unbilled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_gateway_task_request` ON `gateway_task` (`request_ledger_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_gateway_task_newapi_task` ON `gateway_task` (`newapi_task_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_task_due` ON `gateway_task` (`status`,`next_poll_at`);--> statement-breakpoint
CREATE INDEX `idx_gateway_task_owner` ON `gateway_task` (`user_id`,`portal_key_id`,`created_at`);