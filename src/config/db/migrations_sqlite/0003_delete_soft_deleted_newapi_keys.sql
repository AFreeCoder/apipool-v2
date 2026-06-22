DELETE FROM `newapi_key_binding`
WHERE `status` = 'deleted' OR `deleted_at` IS NOT NULL;
