DROP TABLE IF EXISTS `__catalog_fixed_price_unit_guard`;--> statement-breakpoint
CREATE TABLE `__catalog_fixed_price_unit_guard` (
	`valid` integer NOT NULL,
	CONSTRAINT "ck_catalog_fixed_price_unit_guard" CHECK(`valid` = 1)
);--> statement-breakpoint
INSERT INTO `__catalog_fixed_price_unit_guard` (`valid`)
SELECT 0
FROM `catalog_model_price`
WHERE `fixed_price_unit` IS NOT NULL
	AND trim(`fixed_price_unit`) != ''
	AND lower(trim(`fixed_price_unit`)) NOT IN ('per_call', 'call', 'request', 'image')
LIMIT 1;--> statement-breakpoint
DROP TABLE `__catalog_fixed_price_unit_guard`;--> statement-breakpoint
CREATE TABLE `catalog_model_price_tier` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`sku_key` text NOT NULL,
	`price_micro_usd` integer NOT NULL,
	`note` text,
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_catalog_model_price_tier_positive" CHECK("catalog_model_price_tier"."price_micro_usd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_price_tier_model_sku` ON `catalog_model_price_tier` (`model_id`,`sku_key`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_tier_model` ON `catalog_model_price_tier` (`model_id`);--> statement-breakpoint
INSERT INTO `catalog_model_price_tier` (`id`, `model_id`, `sku_key`, `price_micro_usd`, `note`)
SELECT 'migrated-default:' || `model_id`, `model_id`, 'default', `fixed_price_micro_usd`, '由旧 fixed_price 迁移'
FROM `catalog_model_price`
WHERE `fixed_price_micro_usd` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `allow_long_context` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `price_policy`;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `override_input_micro_usd`;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `override_output_micro_usd`;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `override_image_input_micro_usd`;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `override_image_output_micro_usd`;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `override_reason`;--> statement-breakpoint
ALTER TABLE `catalog_model_listing` DROP COLUMN `override_status`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_catalog_model_price` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`billing_scheme` text DEFAULT 'token' NOT NULL,
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
	`base_cached_input_micro_usd` integer,
	`base_cache_write_micro_usd` integer,
	`base_cache_write_5m_micro_usd` integer,
	`base_cache_write_1h_micro_usd` integer,
	`cache_price_note` text,
	`base_image_input_micro_usd` integer,
	`base_cached_image_input_micro_usd` integer,
	`base_image_output_micro_usd` integer,
	`base_web_search_micro_usd` integer,
	`long_context_threshold_tokens` integer,
	`base_input_long_micro_usd` integer,
	`base_cached_input_long_micro_usd` integer,
	`base_cache_write_long_micro_usd` integer,
	`base_output_long_micro_usd` integer,
	`billing_capabilities_json` text,
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
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_catalog_model_price_billing_scheme" CHECK("__new_catalog_model_price"."billing_scheme" IN ('token','per_call'))
);
--> statement-breakpoint
INSERT INTO `__new_catalog_model_price`("id", "model_id", "billing_scheme", "pricing_mode", "source", "source_model_id", "source_vendor_id", "source_quota_type", "source_model_ratio", "source_completion_ratio", "source_image_ratio", "source_supported_endpoint_types", "base_input_micro_usd", "base_output_micro_usd", "base_cached_input_micro_usd", "base_cache_write_micro_usd", "base_cache_write_5m_micro_usd", "base_cache_write_1h_micro_usd", "cache_price_note", "base_image_input_micro_usd", "base_cached_image_input_micro_usd", "base_image_output_micro_usd", "base_web_search_micro_usd", "long_context_threshold_tokens", "base_input_long_micro_usd", "base_cached_input_long_micro_usd", "base_cache_write_long_micro_usd", "base_output_long_micro_usd", "billing_capabilities_json", "fixed_price_micro_usd", "fixed_price_unit", "sync_status", "drift_status", "source_fingerprint", "source_synced_at", "reviewed_by", "reviewed_at", "review_note", "created_at", "updated_at")
SELECT
	"id", "model_id",
	CASE WHEN "pricing_mode" = 'fixed_price' OR "fixed_price_micro_usd" IS NOT NULL THEN 'per_call' ELSE 'token' END,
	"pricing_mode", "source", "source_model_id", "source_vendor_id", "source_quota_type",
	"source_model_ratio", "source_completion_ratio", "source_image_ratio", "source_supported_endpoint_types",
	"base_input_micro_usd", "base_output_micro_usd", "base_cached_input_micro_usd", NULL,
	"base_cache_write_5m_micro_usd", "base_cache_write_1h_micro_usd", "cache_price_note",
	"base_image_input_micro_usd", NULL, "base_image_output_micro_usd", NULL,
	NULL, NULL, NULL, NULL, NULL, NULL,
	"fixed_price_micro_usd", "fixed_price_unit", "sync_status", "drift_status",
	"source_fingerprint", "source_synced_at", "reviewed_by", "reviewed_at", "review_note",
	"created_at", "updated_at"
FROM `catalog_model_price`;--> statement-breakpoint
DROP TABLE `catalog_model_price`;--> statement-breakpoint
ALTER TABLE `__new_catalog_model_price` RENAME TO `catalog_model_price`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_price_model` ON `catalog_model_price` (`model_id`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_sync_status` ON `catalog_model_price` (`sync_status`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_drift_status` ON `catalog_model_price` (`drift_status`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_price_source_model` ON `catalog_model_price` (`source_model_id`);
