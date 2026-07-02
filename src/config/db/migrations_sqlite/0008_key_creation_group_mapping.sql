UPDATE `catalog_group`
SET `newapi_group` = `slug`
WHERE
  `allow_create_key` = 1
  AND (
    trim(`newapi_group`) = ''
    OR (
      `slug` <> 'official'
      AND trim(`newapi_group`) = 'official'
    )
  );
