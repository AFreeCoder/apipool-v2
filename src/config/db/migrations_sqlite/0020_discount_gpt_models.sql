UPDATE `catalog_group`
SET `sort_order` = CASE `slug`
  WHEN 'official' THEN 10
  WHEN 'discount' THEN 20
END,
`updated_at` = cast((julianday('now') - 2440587.5) * 86400000 as integer)
WHERE `slug` IN ('official', 'discount');--> statement-breakpoint

UPDATE `catalog_model_listing`
SET `discount_rate_bps` = 700,
`updated_at` = cast((julianday('now') - 2440587.5) * 86400000 as integer)
WHERE `group_id` = (
  SELECT `id`
  FROM `catalog_group`
  WHERE `slug` = 'discount'
)
AND `model_id` IN (
  SELECT `id`
  FROM `catalog_model`
  WHERE `model_id` IN (
    'gpt-5.3-codex-spark',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-sol'
  )
);
