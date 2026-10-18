-- Rename default S3 prefix from the old product name to "cloudix" (existing rows keep their stored prefix).
ALTER TABLE `s3_storage_configs` ALTER COLUMN `prefix` SET DEFAULT 'cloudix';
