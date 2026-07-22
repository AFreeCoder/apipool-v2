ALTER TABLE `newapi_user_binding` ADD `runtime_pool_status` text DEFAULT 'uninitialized' NOT NULL;--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `runtime_pool_provisioned_at` integer;--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `runtime_pool_last_quota` integer;--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `runtime_pool_checked_at` integer;--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `runtime_pool_last_error` text;--> statement-breakpoint
CREATE INDEX `idx_newapi_user_binding_runtime_pool_status` ON `newapi_user_binding` (`runtime_pool_status`);