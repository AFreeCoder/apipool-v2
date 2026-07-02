CREATE TABLE `catalog_model_price` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`pricing_mode` text DEFAULT 'unknown' NOT NULL,
	`source` text DEFAULT 'migration' NOT NULL,
	`source_model_id` text,
	`source_vendor_id` text,
	`source_quota_type` integer,
	`source_model_ratio` text,
	`source_completion_ratio` text,
	`source_image_ratio` text,
	`source_supported_endpoint_types` text,
	`base_input_micro_usd` integer,
	`base_output_micro_usd` integer,
	`base_image_input_micro_usd` integer,
	`base_image_output_micro_usd` integer,
	`fixed_price_micro_usd` integer,
	`fixed_price_unit` text,
	`sync_status` text DEFAULT 'never_synced' NOT NULL,
	`drift_status` text DEFAULT 'unknown' NOT NULL,
	`source_fingerprint` text,
	`source_synced_at` integer,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_price_model` ON `catalog_model_price` (`model_id`);
--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_sync_status` ON `catalog_model_price` (`sync_status`);
--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_drift_status` ON `catalog_model_price` (`drift_status`);
--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_source_model` ON `catalog_model_price` (`source_model_id`);
--> statement-breakpoint
CREATE TABLE `catalog_price_sync_run` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_user_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`finished_at` integer,
	`remote_model_count` integer DEFAULT 0 NOT NULL,
	`matched_model_count` integer DEFAULT 0 NOT NULL,
	`drift_count` integer DEFAULT 0 NOT NULL,
	`fixed_price_count` integer DEFAULT 0 NOT NULL,
	`missing_group_count` integer DEFAULT 0 NOT NULL,
	`source_fingerprint` text,
	`error_message` text,
	`report_json` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_catalog_price_sync_run_status` ON `catalog_price_sync_run` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_catalog_price_sync_run_started` ON `catalog_price_sync_run` (`started_at`);
--> statement-breakpoint
ALTER TABLE `catalog_group` ADD `newapi_group_ratio_decimal` text;
--> statement-breakpoint
ALTER TABLE `catalog_group` ADD `newapi_group_ratio_bps` integer;
--> statement-breakpoint
ALTER TABLE `catalog_group` ADD `newapi_group_ratio_raw` text;
--> statement-breakpoint
ALTER TABLE `catalog_group` ADD `pricing_sync_status` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `catalog_group` ADD `pricing_synced_at` integer;
--> statement-breakpoint
ALTER TABLE `catalog_group` ADD `pricing_review_note` text;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `price_policy` text DEFAULT 'inherit_group' NOT NULL;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `override_input_micro_usd` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `override_output_micro_usd` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `override_image_input_micro_usd` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `override_image_output_micro_usd` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `override_reason` text;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `override_status` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `effective_price_synced_at` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `effective_price_formula` text;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `price_drift_status` text DEFAULT 'unknown' NOT NULL;
