CREATE TABLE `credential_retirement` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`newapi_token_id` text NOT NULL,
	`reason` text NOT NULL,
	`disabled_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `runtime_credential`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_credential_retirement_pending` ON `credential_retirement` (`disabled_at`);--> statement-breakpoint
CREATE TABLE `gateway_job_lock` (
	`id` text PRIMARY KEY NOT NULL,
	`holder_id` text,
	`heartbeat_at` integer,
	`acquired_at` integer,
	`reconcile_watermark_at` integer
);
--> statement-breakpoint
CREATE TABLE `model_price_version` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_group_id` text NOT NULL,
	`portal_model_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`input_micro_usd_per_m` integer NOT NULL,
	`cached_input_micro_usd_per_m` integer NOT NULL,
	`cache_write_5m_micro_usd_per_m` integer NOT NULL,
	`cache_write_1h_micro_usd_per_m` integer NOT NULL,
	`output_micro_usd_per_m` integer NOT NULL,
	`newapi_ref_input_micro_usd_per_m` integer,
	`newapi_ref_output_micro_usd_per_m` integer,
	`newapi_ref_cached_input_micro_usd_per_m` integer,
	`newapi_ref_cache_write_5m_micro_usd_per_m` integer,
	`newapi_ref_cache_write_1h_micro_usd_per_m` integer,
	`ref_newapi_group` text,
	`source_note` text,
	`published_by` text NOT NULL,
	`retired_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_group_id`) REFERENCES `catalog_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_price_version_active` ON `model_price_version` (`portal_group_id`,`portal_model_id`) WHERE "model_price_version"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_price_version_version` ON `model_price_version` (`portal_group_id`,`portal_model_id`,`version`);--> statement-breakpoint
CREATE TABLE `model_route` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_group_id` text NOT NULL,
	`portal_model_id` text NOT NULL,
	`newapi_group` text NOT NULL,
	`newapi_model_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`published_by` text NOT NULL,
	`retired_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_group_id`) REFERENCES `catalog_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_route_active` ON `model_route` (`portal_group_id`,`portal_model_id`) WHERE "model_route"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_route_version` ON `model_route` (`portal_group_id`,`portal_model_id`,`version`);--> statement-breakpoint
CREATE TABLE `portal_admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`operator_user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`before_json` text,
	`after_json` text,
	`reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_portal_admin_audit_action_created` ON `portal_admin_audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_portal_admin_audit_target` ON `portal_admin_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `portal_api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`group_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`name` text NOT NULL,
	`last_used_at` integer,
	`disabled_at` integer,
	`deleted_at` integer,
	`revoked_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `catalog_group`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_portal_api_key_hash` ON `portal_api_key` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_portal_api_key_user_status` ON `portal_api_key` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_portal_api_key_user_name_live` ON `portal_api_key` (`user_id`,`name`) WHERE "portal_api_key"."status" != 'deleted';--> statement-breakpoint
CREATE TABLE `reconcile_orphan_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`newapi_request_id` text NOT NULL,
	`portal_user_id` text,
	`newapi_group` text,
	`newapi_model_id` text,
	`credential_id` text,
	`token_name` text NOT NULL,
	`newapi_quota` integer,
	`newapi_prompt_tokens` integer,
	`newapi_completion_tokens` integer,
	`log_created_at` integer,
	`resolved_at` integer,
	`note` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_orphan_observation_request` ON `reconcile_orphan_observation` (`newapi_request_id`);--> statement-breakpoint
CREATE INDEX `idx_orphan_observation_user` ON `reconcile_orphan_observation` (`portal_user_id`);--> statement-breakpoint
CREATE INDEX `idx_orphan_observation_open` ON `reconcile_orphan_observation` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `request_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`newapi_request_id` text,
	`user_id` text NOT NULL,
	`portal_key_id` text NOT NULL,
	`portal_group_id` text NOT NULL,
	`portal_model_id` text NOT NULL,
	`newapi_group` text NOT NULL,
	`newapi_model_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`route_version` integer NOT NULL,
	`price_version_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`is_stream` integer DEFAULT false NOT NULL,
	`http_status` integer,
	`error_code` text,
	`stream_aborted` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	`responded_at` integer,
	`finished_at` integer,
	`settled_at` integer,
	`uncached_input_tokens` integer,
	`cached_read_tokens` integer,
	`cache_write_5m_tokens` integer,
	`cache_write_1h_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`usage_source` text,
	`charged_micro_usd` integer,
	`backfill_attempts` integer DEFAULT 0 NOT NULL,
	`next_backfill_at` integer,
	`last_backfill_error` text,
	`newapi_quota` integer,
	`newapi_prompt_tokens` integer,
	`newapi_completion_tokens` integer,
	`newapi_token_name` text,
	`reconcile_status` text DEFAULT 'pending' NOT NULL,
	`reconciled_at` integer,
	`reconcile_note` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	CONSTRAINT "ck_request_ledger_settled" CHECK("request_ledger"."status" != 'settled' OR ("request_ledger"."newapi_request_id" IS NOT NULL AND "request_ledger"."charged_micro_usd" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_request_ledger_newapi_request` ON `request_ledger` (`newapi_request_id`);--> statement-breakpoint
CREATE INDEX `idx_request_ledger_risk` ON `request_ledger` (`user_id`) WHERE "request_ledger"."status" IN ('open','pending_backfill');--> statement-breakpoint
CREATE INDEX `idx_request_ledger_backfill` ON `request_ledger` (`status`,`next_backfill_at`);--> statement-breakpoint
CREATE INDEX `idx_request_ledger_user_created` ON `request_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_request_ledger_reconcile` ON `request_ledger` (`reconcile_status`);--> statement-breakpoint
CREATE TABLE `runtime_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_user_id` text NOT NULL,
	`newapi_group` text NOT NULL,
	`newapi_user_id` text,
	`remote_name` text NOT NULL,
	`newapi_token_id` text,
	`token_enc` text,
	`key_masked` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_used_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`portal_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_runtime_credential_scope` ON `runtime_credential` (`portal_user_id`,`newapi_group`);--> statement-breakpoint
CREATE INDEX `idx_runtime_credential_user_status` ON `runtime_credential` (`portal_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_runtime_credential_status` ON `runtime_credential` (`status`);--> statement-breakpoint
CREATE TABLE `wallet_account` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance_micro_usd` integer DEFAULT 0 NOT NULL,
	`risk_limit_override` integer,
	`frozen_at` integer,
	`freeze_reason` text,
	`frozen_by` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wallet_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`entry_type` text NOT NULL,
	`signed_amount_micro_usd` integer NOT NULL,
	`balance_after_micro_usd` integer NOT NULL,
	`request_ledger_id` text,
	`order_no` text,
	`idempotency_key` text,
	`operator_user_id` text,
	`reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_wallet_ledger_nonzero" CHECK("wallet_ledger"."signed_amount_micro_usd" != 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wallet_ledger_request_charge` ON `wallet_ledger` (`request_ledger_id`) WHERE "wallet_ledger"."entry_type" = 'request_charge';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wallet_ledger_recharge_order` ON `wallet_ledger` (`order_no`) WHERE "wallet_ledger"."entry_type" = 'recharge';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wallet_ledger_idempotency` ON `wallet_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_wallet_ledger_user_created` ON `wallet_ledger` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `catalog_model` ADD `max_output_tokens` integer;--> statement-breakpoint
ALTER TABLE `catalog_model_price` ADD `base_cached_input_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `catalog_model_price` ADD `base_cache_write_5m_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `catalog_model_price` ADD `base_cache_write_1h_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `catalog_model_price` ADD `cache_price_note` text;--> statement-breakpoint
INSERT INTO `gateway_job_lock` (`id`) VALUES ('singleton');--> statement-breakpoint
INSERT INTO `wallet_account` (`user_id`, `balance_micro_usd`, `created_at`, `updated_at`)
SELECT `id`, 0,
  (cast((julianday('now') - 2440587.5)*86400000 as integer)),
  (cast((julianday('now') - 2440587.5)*86400000 as integer))
FROM `user`
WHERE NOT EXISTS (SELECT 1 FROM `wallet_account` wa WHERE wa.`user_id` = `user`.`id`);
