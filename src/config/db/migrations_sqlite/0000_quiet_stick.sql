CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_account_user_id` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_account_provider_account` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `ai_task` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_type` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`task_id` text,
	`task_info` text,
	`task_result` text,
	`cost_credits` integer DEFAULT 0 NOT NULL,
	`scene` text DEFAULT '' NOT NULL,
	`credit_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_task_user_media_type` ON `ai_task` (`user_id`,`media_type`);--> statement-breakpoint
CREATE INDEX `idx_ai_task_media_type_status` ON `ai_task` (`media_type`,`status`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_apikey_user_status` ON `apikey` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_apikey_key_status` ON `apikey` (`key`,`status`);--> statement-breakpoint
CREATE TABLE `apipool_ledger_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text NOT NULL,
	`operator_user_id` text NOT NULL,
	`newapi_user_id` text NOT NULL,
	`newapi_change_id` text,
	`amount_usd` integer NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`executor` text NOT NULL,
	`reason` text NOT NULL,
	`rollback_status` text DEFAULT 'not_required' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operator_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_apipool_ledger_portal_created` ON `apipool_ledger_entry` (`portal_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_apipool_ledger_status` ON `apipool_ledger_entry` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_apipool_ledger_newapi_change` ON `apipool_ledger_entry` (`newapi_change_id`);--> statement-breakpoint
CREATE TABLE `chat` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`content` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_user_status` ON `chat` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_message_chat_id` ON `chat_message` (`chat_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_chat_message_user_id` ON `chat_message` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `config` (
	`name` text NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_name_unique` ON `config` (`name`);--> statement-breakpoint
CREATE TABLE `credit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`order_no` text,
	`subscription_no` text,
	`transaction_no` text NOT NULL,
	`transaction_type` text NOT NULL,
	`transaction_scene` text,
	`credits` integer NOT NULL,
	`remaining_credits` integer DEFAULT 0 NOT NULL,
	`description` text,
	`expires_at` integer,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`consumed_detail` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_transaction_no_unique` ON `credit` (`transaction_no`);--> statement-breakpoint
CREATE INDEX `idx_credit_consume_fifo` ON `credit` (`user_id`,`status`,`transaction_type`,`remaining_credits`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_credit_order_no` ON `credit` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_credit_subscription_no` ON `credit` (`subscription_no`);--> statement-breakpoint
CREATE TABLE `newapi_bridge_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text,
	`operator_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`status` text NOT NULL,
	`idempotency_key` text,
	`request_body` text,
	`response_body` text,
	`error_message` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_newapi_bridge_audit_portal_created` ON `newapi_bridge_audit_log` (`portal_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_newapi_bridge_audit_action_status` ON `newapi_bridge_audit_log` (`action`,`status`);--> statement-breakpoint
CREATE TABLE `newapi_key_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text NOT NULL,
	`newapi_user_id` text NOT NULL,
	`newapi_key_id` text NOT NULL,
	`key_masked` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`allowed_models` text DEFAULT '[]' NOT NULL,
	`quota_limit` integer,
	`ip_allowlist` text DEFAULT '[]' NOT NULL,
	`idempotency_key` text NOT NULL,
	`last_remote_error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`last_used_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`portal_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_newapi_key_binding_portal_status` ON `newapi_key_binding` (`portal_user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_newapi_key_binding_remote_key` ON `newapi_key_binding` (`newapi_key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_newapi_key_binding_idempotency` ON `newapi_key_binding` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `newapi_user_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text NOT NULL,
	`newapi_user_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_newapi_user_binding_portal_user` ON `newapi_user_binding` (`portal_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_newapi_user_binding_newapi_user` ON `newapi_user_binding` (`newapi_user_id`);--> statement-breakpoint
CREATE INDEX `idx_newapi_user_binding_status` ON `newapi_user_binding` (`status`);--> statement-breakpoint
CREATE TABLE `order` (
	`id` text PRIMARY KEY NOT NULL,
	`order_no` text NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`product_id` text,
	`payment_type` text,
	`payment_interval` text,
	`payment_provider` text NOT NULL,
	`payment_session_id` text,
	`checkout_info` text NOT NULL,
	`checkout_result` text,
	`payment_result` text,
	`discount_code` text,
	`discount_amount` integer,
	`discount_currency` text,
	`payment_email` text,
	`payment_amount` integer,
	`payment_currency` text,
	`paid_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`description` text,
	`product_name` text,
	`subscription_id` text,
	`subscription_result` text,
	`checkout_url` text,
	`callback_url` text,
	`credits_amount` integer,
	`credits_valid_days` integer,
	`plan_name` text,
	`payment_product_id` text,
	`invoice_id` text,
	`invoice_url` text,
	`subscription_no` text,
	`transaction_id` text,
	`payment_user_name` text,
	`payment_user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_order_no_unique` ON `order` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_order_user_status_payment_type` ON `order` (`user_id`,`status`,`payment_type`);--> statement-breakpoint
CREATE INDEX `idx_order_transaction_provider` ON `order` (`transaction_id`,`payment_provider`);--> statement-breakpoint
CREATE INDEX `idx_order_created_at` ON `order` (`created_at`);--> statement-breakpoint
CREATE TABLE `permission` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_code_unique` ON `permission` (`code`);--> statement-breakpoint
CREATE INDEX `idx_permission_resource_action` ON `permission` (`resource`,`action`);--> statement-breakpoint
CREATE TABLE `post` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`description` text,
	`image` text,
	`content` text,
	`categories` text,
	`tags` text,
	`author_name` text,
	`author_image` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_slug_unique` ON `post` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_post_type_status` ON `post` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `role` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_name_unique` ON `role` (`name`);--> statement-breakpoint
CREATE INDEX `idx_role_status` ON `role` (`status`);--> statement-breakpoint
CREATE TABLE `role_permission` (
	`id` text PRIMARY KEY NOT NULL,
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_role_permission_role_permission` ON `role_permission` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `idx_session_user_expires` ON `session` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_no` text NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`status` text NOT NULL,
	`payment_provider` text NOT NULL,
	`subscription_id` text NOT NULL,
	`subscription_result` text,
	`product_id` text,
	`description` text,
	`amount` integer,
	`currency` text,
	`interval` text,
	`interval_count` integer,
	`trial_period_days` integer,
	`current_period_start` integer,
	`current_period_end` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`plan_name` text,
	`billing_url` text,
	`product_name` text,
	`credits_amount` integer,
	`credits_valid_days` integer,
	`payment_product_id` text,
	`payment_user_id` text,
	`canceled_at` integer,
	`canceled_end_at` integer,
	`canceled_reason` text,
	`canceled_reason_type` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_subscription_no_unique` ON `subscription` (`subscription_no`);--> statement-breakpoint
CREATE INDEX `idx_subscription_user_status_interval` ON `subscription` (`user_id`,`status`,`interval`);--> statement-breakpoint
CREATE INDEX `idx_subscription_provider_id` ON `subscription` (`subscription_id`,`payment_provider`);--> statement-breakpoint
CREATE INDEX `idx_subscription_created_at` ON `subscription` (`created_at`);--> statement-breakpoint
CREATE TABLE `taxonomy` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`image` text,
	`icon` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_slug_unique` ON `taxonomy` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_taxonomy_type_status` ON `taxonomy` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `usage_log_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text NOT NULL,
	`newapi_request_id` text,
	`key_masked` text NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`spend_usd` integer,
	`created_at` integer NOT NULL,
	`synced_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_usage_log_snapshot_user_created` ON `usage_log_snapshot` (`portal_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_log_snapshot_model` ON `usage_log_snapshot` (`model_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_usage_log_snapshot_remote_request` ON `usage_log_snapshot` (`newapi_request_id`);--> statement-breakpoint
CREATE TABLE `usage_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text NOT NULL,
	`newapi_user_id` text NOT NULL,
	`range` text NOT NULL,
	`balance_usd` integer,
	`quota_remaining` integer,
	`request_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`spend_usd` integer,
	`by_model` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`synced_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_usage_snapshot_user_range` ON `usage_snapshot` (`portal_user_id`,`range`);--> statement-breakpoint
CREATE INDEX `idx_usage_snapshot_status` ON `usage_snapshot` (`status`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`utm_source` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`locale` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `idx_user_name` ON `user` (`name`);--> statement-breakpoint
CREATE INDEX `idx_user_created_at` ON `user` (`created_at`);--> statement-breakpoint
CREATE TABLE `user_role` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_role_user_expires` ON `user_role` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_verification_identifier` ON `verification` (`identifier`);
