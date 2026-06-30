ALTER TABLE `apipool_ledger_entry` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_apipool_ledger_idempotency` ON `apipool_ledger_entry` (`idempotency_key`);--> statement-breakpoint
WITH duplicate_active_key_names AS (
	SELECT
		`id`,
		row_number() OVER (
			PARTITION BY `portal_user_id`, `display_name`
			ORDER BY `created_at`, `id`
		) AS `duplicate_rank`
	FROM `newapi_key_binding`
	WHERE `status` <> 'deleted'
)
UPDATE `newapi_key_binding`
SET `display_name` = `display_name` || ' (' || substr(`id`, 1, 8) || ')'
WHERE `id` IN (
	SELECT `id`
	FROM duplicate_active_key_names
	WHERE `duplicate_rank` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_newapi_key_binding_user_display_name_active` ON `newapi_key_binding` (`portal_user_id`,`display_name`) WHERE "newapi_key_binding"."status" <> 'deleted';
