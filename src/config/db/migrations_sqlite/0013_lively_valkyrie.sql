PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_price_version` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_group_id` text NOT NULL,
	`portal_model_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`billing_scheme` text DEFAULT 'token' NOT NULL,
	`rates_json` text DEFAULT '{}' NOT NULL,
	`tiers_json` text DEFAULT '{}' NOT NULL,
	`long_context_threshold_tokens` integer,
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
	FOREIGN KEY (`portal_group_id`) REFERENCES `catalog_group`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_model_price_version_billing_scheme" CHECK("__new_model_price_version"."billing_scheme" IN ('token','per_call'))
);
--> statement-breakpoint
INSERT INTO `__new_model_price_version`("id", "portal_group_id", "portal_model_id", "version", "status", "billing_scheme", "rates_json", "tiers_json", "long_context_threshold_tokens", "newapi_ref_input_micro_usd_per_m", "newapi_ref_output_micro_usd_per_m", "newapi_ref_cached_input_micro_usd_per_m", "newapi_ref_cache_write_5m_micro_usd_per_m", "newapi_ref_cache_write_1h_micro_usd_per_m", "ref_newapi_group", "source_note", "published_by", "retired_at", "created_at", "updated_at")
SELECT
	"id", "portal_group_id", "portal_model_id", "version", "status", 'token',
	json_object(
		'input', "input_micro_usd_per_m",
		'cached_input', "cached_input_micro_usd_per_m",
		'cache_write_5m', "cache_write_5m_micro_usd_per_m",
		'cache_write_1h', "cache_write_1h_micro_usd_per_m",
		'output', "output_micro_usd_per_m"
	),
	'{}', NULL,
	"newapi_ref_input_micro_usd_per_m", "newapi_ref_output_micro_usd_per_m",
	"newapi_ref_cached_input_micro_usd_per_m", "newapi_ref_cache_write_5m_micro_usd_per_m",
	"newapi_ref_cache_write_1h_micro_usd_per_m", "ref_newapi_group", "source_note",
	"published_by", "retired_at", "created_at", "updated_at"
FROM `model_price_version`;--> statement-breakpoint
DROP TABLE `model_price_version`;--> statement-breakpoint
ALTER TABLE `__new_model_price_version` RENAME TO `model_price_version`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_price_version_active` ON `model_price_version` (`portal_group_id`,`portal_model_id`) WHERE "model_price_version"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_model_price_version_version` ON `model_price_version` (`portal_group_id`,`portal_model_id`,`version`);--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `billing_scheme` text;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `image_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `cached_image_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `image_output_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `sku_key` text;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `unit_count` integer;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `long_context_applied` integer;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `billing_flags_json` text;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `raw_usage_json` text;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `web_search_count` integer;
