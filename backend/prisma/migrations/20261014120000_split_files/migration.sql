-- AlterTable
ALTER TABLE `upload_sessions` ADD COLUMN `split_file_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `file_parts` (
    `id` CHAR(36) NOT NULL,
    `file_id` CHAR(36) NOT NULL,
    `part_index` INTEGER NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `provider_file_id` VARCHAR(191) NULL,
    `start_byte` BIGINT NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `uploaded_bytes` BIGINT NOT NULL DEFAULT 0,
    `google_session_uri` TEXT NULL,
    `md5_checksum` VARCHAR(64) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `file_parts_connected_account_id_idx`(`connected_account_id`),
    UNIQUE INDEX `file_parts_file_id_part_index_key`(`file_id`, `part_index`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `file_parts` ADD CONSTRAINT `file_parts_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `file_parts` ADD CONSTRAINT `file_parts_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
