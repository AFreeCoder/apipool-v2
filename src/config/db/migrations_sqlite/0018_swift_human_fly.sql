CREATE TABLE `catalog_model_pricing_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`name` text NOT NULL,
	`pricing_basis` text NOT NULL,
	`quantity_meter` text,
	`sku_rule_source` text,
	`sku_rule_ast_json` text,
	`compiler_version` integer,
	`rule_hash` text,
	`long_context_threshold_tokens` integer,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_catalog_model_pricing_profile_basis" CHECK("catalog_model_pricing_profile"."pricing_basis" IN ('token','unit','duration'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_pricing_profile_name` ON `catalog_model_pricing_profile` (`model_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_pricing_profile_model` ON `catalog_model_pricing_profile` (`model_id`);--> statement-breakpoint
CREATE TABLE `catalog_model_pricing_rate` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`meter_key` text NOT NULL,
	`sku_key` text DEFAULT 'default' NOT NULL,
	`unit_size` integer NOT NULL,
	`price_micro_usd` integer NOT NULL,
	`note` text,
	FOREIGN KEY (`profile_id`) REFERENCES `catalog_model_pricing_profile`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_catalog_model_pricing_rate_unit_size" CHECK("catalog_model_pricing_rate"."unit_size" > 0),
	CONSTRAINT "ck_catalog_model_pricing_rate_nonnegative" CHECK("catalog_model_pricing_rate"."price_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_pricing_rate` ON `catalog_model_pricing_rate` (`profile_id`,`meter_key`,`sku_key`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_pricing_rate_profile` ON `catalog_model_pricing_rate` (`profile_id`);--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `pricing_profile_id` text REFERENCES catalog_model_pricing_profile(id);--> statement-breakpoint
ALTER TABLE `model_price_version` ADD `pricing_spec_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `model_price_version` ADD `pricing_profile_id` text;--> statement-breakpoint
ALTER TABLE `model_price_version` ADD `pricing_profile_rule_hash` text;--> statement-breakpoint
ALTER TABLE `model_price_version` ADD `admission_long_context_threshold_tokens` integer;--> statement-breakpoint
ALTER TABLE `model_price_version` ADD `allow_long_context` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `pricing_basis` text;--> statement-breakpoint
ALTER TABLE `request_ledger` ADD `quantity_meter` text;--> statement-breakpoint

-- 一次性把旧模型全局售卖价转换为模型级默认定价档案。转换完成后，应用层不再从
-- catalog_model_price / catalog_model_price_tier 读取售卖价；两表只保留上游成本参照。
INSERT INTO `catalog_model_pricing_profile` (
	`id`,
	`model_id`,
	`name`,
	`pricing_basis`,
	`quantity_meter`,
	`sku_rule_source`,
	`sku_rule_ast_json`,
	`compiler_version`,
	`rule_hash`,
	`long_context_threshold_tokens`,
	`reviewed_by`,
	`reviewed_at`,
	`review_note`,
	`created_at`,
	`updated_at`
)
SELECT
	'migrated-profile-' || price.`model_id`,
	price.`model_id`,
	'默认售卖价',
	CASE WHEN price.`billing_scheme` = 'per_call' THEN 'unit' ELSE 'token' END,
	CASE
		WHEN price.`billing_scheme` != 'per_call' THEN NULL
		WHEN model.`category` = 'image' THEN 'output_count'
		ELSE 'request_count'
	END,
	CASE
		WHEN price.`billing_scheme` != 'per_call' THEN NULL
		WHEN model.`category` = 'image' THEN
			'when quality is missing => "default"' || char(10) ||
			'when quality == "auto" => "default"' || char(10) ||
			'when size is missing => "default"' || char(10) ||
			'when size == "auto" => "default"' || char(10) ||
			'else => "quality=${quality};size=${size}"'
		ELSE 'else => "default"'
	END,
	CASE
		WHEN price.`billing_scheme` != 'per_call' THEN NULL
		WHEN model.`category` = 'image' THEN
			'{"version":1,"rules":[' ||
			'{"conditions":[{"field":"quality","operator":"missing"}],"output":{"type":"sku","template":"default"}},' ||
			'{"conditions":[{"field":"quality","operator":"eq","value":"auto"}],"output":{"type":"sku","template":"default"}},' ||
			'{"conditions":[{"field":"size","operator":"missing"}],"output":{"type":"sku","template":"default"}},' ||
			'{"conditions":[{"field":"size","operator":"eq","value":"auto"}],"output":{"type":"sku","template":"default"}}' ||
			'],"fallback":{"type":"sku","template":"quality=${quality};size=${size}"}}'
		ELSE '{"version":1,"rules":[],"fallback":{"type":"sku","template":"default"}}'
	END,
	CASE WHEN price.`billing_scheme` = 'per_call' THEN 1 ELSE NULL END,
	CASE
		WHEN price.`billing_scheme` != 'per_call' THEN NULL
		WHEN model.`category` = 'image' THEN
			'484c5ba37b638c11e514b984a3d1754f4a1f7bcda134ecdd53988d14d4f00592'
		ELSE '3a16e33ed60135490952ff4a7ffc357e76f43f2957f7fdce40e86a8ecdcd84eb'
	END,
	price.`long_context_threshold_tokens`,
	price.`reviewed_by`,
	COALESCE(price.`reviewed_at`, price.`updated_at`, price.`created_at`),
	COALESCE(price.`review_note`, '由 0018 迁移生成'),
	price.`created_at`,
	price.`updated_at`
FROM `catalog_model_price` price
JOIN `catalog_model` model ON model.`id` = price.`model_id`;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-input-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'input',
	'default',
	1000000,
	`base_input_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_input_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-output-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'output',
	'default',
	1000000,
	`base_output_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_output_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cached-input-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cached_input',
	'default',
	1000000,
	`base_cached_input_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cached_input_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cache-write-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cache_write',
	'default',
	1000000,
	`base_cache_write_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cache_write_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cache-write-5m-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cache_write_5m',
	'default',
	1000000,
	`base_cache_write_5m_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cache_write_5m_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cache-write-1h-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cache_write_1h',
	'default',
	1000000,
	`base_cache_write_1h_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cache_write_1h_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-image-input-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'image_input',
	'default',
	1000000,
	`base_image_input_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_image_input_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cached-image-input-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cached_image_input',
	'default',
	1000000,
	`base_cached_image_input_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cached_image_input_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-image-output-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'image_output',
	'default',
	1000000,
	`base_image_output_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_image_output_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-web-search-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'web_search',
	'default',
	1,
	`base_web_search_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_web_search_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-input-long-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'input_long',
	'default',
	1000000,
	`base_input_long_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_input_long_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cached-input-long-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cached_input_long',
	'default',
	1000000,
	`base_cached_input_long_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cached_input_long_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-cache-write-long-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'cache_write_long',
	'default',
	1000000,
	`base_cache_write_long_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_cache_write_long_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-output-long-' || `model_id`,
	'migrated-profile-' || `model_id`,
	'output_long',
	'default',
	1000000,
	`base_output_long_micro_usd`,
	NULL
FROM `catalog_model_price`
WHERE `billing_scheme` = 'token' AND `base_output_long_micro_usd` IS NOT NULL;--> statement-breakpoint

INSERT INTO `catalog_model_pricing_rate`
	(`id`, `profile_id`, `meter_key`, `sku_key`, `unit_size`, `price_micro_usd`, `note`)
SELECT
	'migrated-rate-unit-' || tier.`id`,
	'migrated-profile-' || tier.`model_id`,
	CASE WHEN model.`category` = 'image' THEN 'output_count' ELSE 'request_count' END,
	tier.`sku_key`,
	1,
	tier.`price_micro_usd`,
	tier.`note`
FROM `catalog_model_price_tier` tier
JOIN `catalog_model` model ON model.`id` = tier.`model_id`
JOIN `catalog_model_price` price ON price.`model_id` = tier.`model_id`
WHERE price.`billing_scheme` = 'per_call';--> statement-breakpoint

UPDATE `catalog_model_listing`
SET `pricing_profile_id` = 'migrated-profile-' || `model_id`
WHERE EXISTS (
	SELECT 1
	FROM `catalog_model_pricing_profile` profile
	WHERE profile.`id` = 'migrated-profile-' || `catalog_model_listing`.`model_id`
);--> statement-breakpoint

UPDATE `request_ledger`
SET
	`pricing_basis` = CASE
		WHEN `billing_scheme` = 'token' THEN 'token'
		WHEN `billing_scheme` = 'per_call' THEN 'unit'
		ELSE NULL
	END,
	`quantity_meter` = CASE
		WHEN `billing_scheme` = 'per_call' THEN 'output_count'
		ELSE NULL
	END
WHERE `billing_scheme` IS NOT NULL;
