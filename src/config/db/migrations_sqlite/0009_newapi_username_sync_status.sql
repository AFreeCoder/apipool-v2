ALTER TABLE `newapi_user_binding` ADD `target_newapi_username` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_error_code` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_error` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_action` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_synced_at` integer;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_attempted_at` integer;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `conflict_newapi_user_id` text;
--> statement-breakpoint
UPDATE `newapi_user_binding`
SET `target_newapi_username` = (
  SELECT lower(trim(`user`.`email`))
  FROM `user`
  WHERE `user`.`id` = `newapi_user_binding`.`portal_user_id`
)
WHERE `target_newapi_username` IS NULL;
--> statement-breakpoint
UPDATE `newapi_user_binding`
SET
  `status` = CASE
    WHEN `target_newapi_username` IS NULL OR `target_newapi_username` = '' THEN 'username_sync_failed'
    WHEN length(`target_newapi_username`) > 20 THEN 'username_sync_failed'
    WHEN `status` = 'active'
      AND `newapi_username` IS NOT NULL
      AND `newapi_username` <> `target_newapi_username` THEN 'username_sync_pending'
    ELSE `status`
  END,
  `last_sync_error_code` = CASE
    WHEN `target_newapi_username` IS NULL OR `target_newapi_username` = '' THEN 'portal_user_email_missing'
    WHEN length(`target_newapi_username`) > 20 THEN 'newapi_username_too_long'
    ELSE `last_sync_error_code`
  END,
  `last_sync_error` = CASE
    WHEN `target_newapi_username` IS NULL OR `target_newapi_username` = '' THEN 'Portal user email is missing'
    WHEN length(`target_newapi_username`) > 20 THEN 'New API username exceeds the Phase A limit'
    ELSE `last_sync_error`
  END,
  `last_sync_action` = CASE
    WHEN `last_sync_action` IS NULL THEN 'migration_backfill'
    ELSE `last_sync_action`
  END;
--> statement-breakpoint
CREATE INDEX `idx_newapi_user_binding_target_username` ON `newapi_user_binding` (`target_newapi_username`);
--> statement-breakpoint
CREATE INDEX `idx_newapi_user_binding_sync_error_code` ON `newapi_user_binding` (`last_sync_error_code`);
