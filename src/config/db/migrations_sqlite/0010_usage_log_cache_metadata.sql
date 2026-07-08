ALTER TABLE `usage_log_snapshot` ADD `cache_tokens` integer;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_ratio` real;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_creation_tokens` integer;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_creation_ratio` real;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_creation_tokens_5m` integer;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_creation_ratio_5m` real;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_creation_tokens_1h` integer;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `cache_creation_ratio_1h` real;
--> statement-breakpoint
ALTER TABLE `usage_log_snapshot` ADD `usage_semantic` text;
