INSERT OR IGNORE INTO `catalog_vendor` (`id`, `slug`, `name`, `sort_order`, `status`)
VALUES
	('seed_vendor_openai', 'openai', 'OpenAI', 10, 'active'),
	('seed_vendor_anthropic', 'anthropic', 'Anthropic', 20, 'active'),
	('seed_vendor_google', 'google', 'Google', 30, 'active');
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_category` (`id`, `slug`, `name`, `sort_order`, `status`)
VALUES
	('seed_category_llm', 'llm', 'LLM', 10, 'active'),
	('seed_category_embedding', 'embedding', 'Embedding', 20, 'active'),
	('seed_category_image', 'image', 'Image', 30, 'active'),
	('seed_category_audio', 'audio', 'Audio', 40, 'active');
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_capability` (`id`, `slug`, `name`, `sort_order`, `status`)
VALUES
	('seed_capability_text', 'text', 'Text', 10, 'active'),
	('seed_capability_vision', 'vision', 'Vision', 20, 'active'),
	('seed_capability_video', 'video', 'Video', 30, 'active'),
	('seed_capability_audio', 'audio', 'Audio', 40, 'active');
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_status` (
	`id`,
	`slug`,
	`name`,
	`is_callable`,
	`is_public_visible`,
	`sort_order`,
	`status`
)
VALUES
	('seed_status_available', 'available', 'Available', 1, 1, 10, 'active'),
	('seed_status_coming_soon', 'coming_soon', 'Coming soon', 0, 1, 20, 'active'),
	('seed_status_retired', 'retired', 'Retired', 0, 0, 30, 'active');
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_group` (
	`id`,
	`slug`,
	`name`,
	`user_description`,
	`newapi_group`,
	`allow_create_key`,
	`sort_order`,
	`status`
)
VALUES (
	'seed_group_official',
	'official',
	'Official',
	'Default verified model route for production usage.',
	'official',
	1,
	10,
	'active'
);
--> statement-breakpoint
UPDATE `catalog_group`
SET `newapi_group` = 'official'
WHERE `slug` = 'official' AND `newapi_group` = '';
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_model` (
	`id`,
	`model_id`,
	`display_name`,
	`vendor_id`,
	`category`,
	`context_window`
)
SELECT
	'seed_model_gpt_4o_mini',
	'gpt-4o-mini',
	'GPT-4o mini',
	`catalog_vendor`.`id`,
	'llm',
	128000
FROM `catalog_vendor`
WHERE `catalog_vendor`.`slug` = 'openai';
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_model_capability` (`id`, `model_id`, `capability_id`)
SELECT
	'seed_model_capability_gpt4omini_text',
	`catalog_model`.`id`,
	`catalog_capability`.`id`
FROM `catalog_model`
JOIN `catalog_capability` ON `catalog_capability`.`slug` = 'text'
WHERE `catalog_model`.`model_id` = 'gpt-4o-mini';
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_model_capability` (`id`, `model_id`, `capability_id`)
SELECT
	'seed_model_capability_gpt4omini_vision',
	`catalog_model`.`id`,
	`catalog_capability`.`id`
FROM `catalog_model`
JOIN `catalog_capability` ON `catalog_capability`.`slug` = 'vision'
WHERE `catalog_model`.`model_id` = 'gpt-4o-mini';
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_model_listing` (
	`id`,
	`model_id`,
	`group_id`,
	`status_id`,
	`input_micro_usd`,
	`output_micro_usd`,
	`smoke_tested`,
	`sort_order`
)
SELECT
	'seed_listing_gpt4omini_official',
	`catalog_model`.`id`,
	`catalog_group`.`id`,
	`catalog_status`.`id`,
	150000,
	600000,
	1,
	10
FROM `catalog_model`
JOIN `catalog_group` ON `catalog_group`.`slug` = 'official'
JOIN `catalog_status` ON `catalog_status`.`slug` = 'available'
WHERE `catalog_model`.`model_id` = 'gpt-4o-mini';
