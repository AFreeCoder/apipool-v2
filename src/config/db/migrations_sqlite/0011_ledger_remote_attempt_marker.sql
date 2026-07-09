ALTER TABLE `apipool_ledger_entry` ADD `remote_attempt_at` integer;--> statement-breakpoint
CREATE INDEX `idx_apipool_ledger_remote_attempt` ON `apipool_ledger_entry` (`remote_attempt_at`);