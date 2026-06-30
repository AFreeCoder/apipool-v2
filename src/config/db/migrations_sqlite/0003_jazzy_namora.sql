CREATE TABLE `catalog_capability` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_capability_slug_unique` ON `catalog_capability` (`slug`);--> statement-breakpoint
CREATE TABLE `catalog_group` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`user_description` text,
	`newapi_group` text DEFAULT '' NOT NULL,
	`allow_create_key` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_group_slug_unique` ON `catalog_group` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_catalog_group_status` ON `catalog_group` (`status`);--> statement-breakpoint
CREATE TABLE `catalog_model` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`vendor_id` text NOT NULL,
	`category` text DEFAULT 'llm' NOT NULL,
	`context_window` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `catalog_vendor`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_model_model_id_unique` ON `catalog_model` (`model_id`);--> statement-breakpoint
CREATE INDEX `idx_catalog_model_vendor` ON `catalog_model` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `catalog_model_capability` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`capability_id` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`capability_id`) REFERENCES `catalog_capability`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_catalog_model_capability` ON `catalog_model_capability` (`model_id`,`capability_id`);--> statement-breakpoint
CREATE INDEX `idx_cmc_capability` ON `catalog_model_capability` (`capability_id`);--> statement-breakpoint
CREATE TABLE `catalog_model_listing` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`group_id` text NOT NULL,
	`status_id` text NOT NULL,
	`input_micro_usd` integer NOT NULL,
	`output_micro_usd` integer NOT NULL,
	`list_input_micro_usd` integer,
	`list_output_micro_usd` integer,
	`discount_note` text,
	`description` text,
	`smoke_tested` integer DEFAULT false NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `catalog_model`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `catalog_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `catalog_status`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_listing_model_group` ON `catalog_model_listing` (`model_id`,`group_id`);--> statement-breakpoint
CREATE INDEX `idx_listing_group` ON `catalog_model_listing` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_listing_status` ON `catalog_model_listing` (`status_id`);--> statement-breakpoint
CREATE TABLE `catalog_status` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`is_callable` integer DEFAULT false NOT NULL,
	`is_public_visible` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_status_slug_unique` ON `catalog_status` (`slug`);--> statement-breakpoint
CREATE TABLE `catalog_vendor` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_vendor_slug_unique` ON `catalog_vendor` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_catalog_vendor_status` ON `catalog_vendor` (`status`);--> statement-breakpoint
ALTER TABLE `newapi_key_binding` ADD `group_id` text REFERENCES catalog_group(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `newapi_key_binding` ADD `newapi_group` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_newapi_key_binding_group` ON `newapi_key_binding` (`group_id`);
