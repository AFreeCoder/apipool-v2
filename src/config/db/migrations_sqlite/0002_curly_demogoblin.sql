ALTER TABLE `apipool_ledger_entry` ADD `order_no` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_apipool_ledger_order_no` ON `apipool_ledger_entry` (`order_no`);