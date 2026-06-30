CREATE TABLE `catalog_model_category` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`category_id` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `catalog_category`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_category` ON `catalog_model_category` (`model_id`,`category_id`);
--> statement-breakpoint
CREATE INDEX `idx_cmc_category` ON `catalog_model_category` (`category_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `catalog_model_category` (`id`, `model_id`, `category_id`)
SELECT
	'seed_model_category_' || `catalog_model`.`id` || '_' || `catalog_category`.`id`,
	`catalog_model`.`id`,
	`catalog_category`.`id`
FROM `catalog_model`
JOIN `catalog_category` ON `catalog_category`.`slug` = `catalog_model`.`category`;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `image_input_micro_usd` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `image_output_micro_usd` integer;
--> statement-breakpoint
ALTER TABLE `catalog_model_listing` ADD `discount_rate_bps` integer;
