-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING_EMAIL_VERIFICATION', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED') NOT NULL DEFAULT 'PENDING_EMAIL_VERIFICATION',
    `emailVerifiedAt` DATETIME(3) NULL,
    `phoneVerifiedAt` DATETIME(3) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `statusReason` TEXT NULL,
    `passwordChangedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    UNIQUE INDEX `users_phone_key`(`phone`),
    INDEX `users_status_idx`(`status`),
    INDEX `users_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `refreshTokenHash` VARCHAR(191) NOT NULL,
    `userAgent` TEXT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_refreshTokenHash_key`(`refreshTokenHash`),
    INDEX `sessions_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_tokens` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'PHONE_VERIFICATION') NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_tokens_tokenHash_key`(`tokenHash`),
    INDEX `user_tokens_userId_type_idx`(`userId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `scope` ENUM('PLATFORM', 'ORGANIZATION') NOT NULL,
    `group` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `permissions_key_scope_key`(`key`, `scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `scope` ENUM('PLATFORM', 'ORGANIZATION') NOT NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `organizationId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `roles_organizationId_idx`(`organizationId`),
    UNIQUE INDEX `roles_scope_organizationId_code_key`(`scope`, `organizationId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `roleId` CHAR(36) NOT NULL,
    `permissionId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `userId` CHAR(36) NOT NULL,
    `roleId` CHAR(36) NOT NULL,
    `assignedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organizations` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'DRAFT',
    `statusReason` TEXT NULL,
    `businessType` VARCHAR(191) NULL,
    `country` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `city` VARCHAR(191) NULL,
    `registrationNumber` VARCHAR(191) NULL,
    `taxId` VARCHAR(191) NULL,
    `website` TEXT NULL,
    `contactPersonName` VARCHAR(191) NULL,
    `contactPersonPhone` VARCHAR(191) NULL,
    `contactPersonEmail` TEXT NULL,
    `smsPurpose` TEXT NULL,
    `expectedMonthlyVolume` INTEGER NULL,
    `smsHourlyLimit` INTEGER NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Africa/Kigali',
    `approvedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    INDEX `organizations_status_idx`(`status`),
    INDEX `organizations_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organization_members` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `roleId` CHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `isOwner` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `organization_members_userId_idx`(`userId`),
    UNIQUE INDEX `organization_members_organizationId_userId_key`(`organizationId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organization_invitations` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `roleId` CHAR(36) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'PENDING',
    `invitedById` CHAR(36) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `organization_invitations_tokenHash_key`(`tokenHash`),
    INDEX `organization_invitations_organizationId_status_idx`(`organizationId`, `status`),
    INDEX `organization_invitations_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verifications` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'DRAFT',
    `submittedAt` DATETIME(3) NULL,
    `submittedById` CHAR(36) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedById` CHAR(36) NULL,
    `reviewNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `verifications_organizationId_idx`(`organizationId`),
    INDEX `verifications_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_reviews` (
    `id` CHAR(36) NOT NULL,
    `verificationId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `reviewerId` CHAR(36) NULL,
    `action` VARCHAR(191) NOT NULL,
    `fromStatus` VARCHAR(191) NULL,
    `toStatus` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `verification_reviews_verificationId_createdAt_idx`(`verificationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification_documents` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `verificationId` CHAR(36) NOT NULL,
    `documentType` VARCHAR(191) NOT NULL,
    `originalName` TEXT NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `storageKey` VARCHAR(191) NOT NULL,
    `checksum` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED') NOT NULL DEFAULT 'PENDING',
    `reviewNote` TEXT NULL,
    `uploadedById` CHAR(36) NOT NULL,
    `reviewedById` CHAR(36) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `verification_documents_storageKey_key`(`storageKey`),
    INDEX `verification_documents_organizationId_idx`(`organizationId`),
    INDEX `verification_documents_verificationId_idx`(`verificationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sender_ids` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'PENDING',
    `purpose` TEXT NOT NULL,
    `sampleMessage` TEXT NULL,
    `useCase` TEXT NULL,
    `reviewNote` TEXT NULL,
    `requestedById` CHAR(36) NOT NULL,
    `reviewedById` CHAR(36) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sender_ids_status_idx`(`status`),
    INDEX `sender_ids_name_idx`(`name`),
    UNIQUE INDEX `sender_ids_organizationId_name_key`(`organizationId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sender_id_reviews` (
    `id` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `reviewerId` CHAR(36) NULL,
    `action` VARCHAR(191) NOT NULL,
    `fromStatus` VARCHAR(191) NOT NULL,
    `toStatus` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sender_id_reviews_senderId_createdAt_idx`(`senderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sender_id_registrations` (
    `id` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `providerId` CHAR(36) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `providerReference` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sender_id_registrations_senderId_providerId_key`(`senderId`, `providerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_providers` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('MNO', 'AGGREGATOR') NOT NULL,
    `mode` ENUM('SIMULATION', 'PRODUCTION') NOT NULL DEFAULT 'SIMULATION',
    `status` ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `currency` VARCHAR(191) NOT NULL DEFAULT 'RWF',
    `costPerSms` DECIMAL(14, 4) NOT NULL,
    `routePrefixes` JSON NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `capacityBalance` INTEGER NOT NULL DEFAULT 0,
    `totalPurchased` INTEGER NOT NULL DEFAULT 0,
    `totalUsed` INTEGER NOT NULL DEFAULT 0,
    `totalSpent` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `allowOverdraft` BOOLEAN NOT NULL DEFAULT false,
    `overdraftLimit` INTEGER NOT NULL DEFAULT 0,
    `lowCapacityThreshold` INTEGER NOT NULL DEFAULT 10000,
    `notes` TEXT NULL,
    `lastTransactionAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_providers_code_key`(`code`),
    INDEX `sms_providers_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_purchases` (
    `id` CHAR(36) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `providerId` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitCost` DECIMAL(14, 4) NOT NULL,
    `totalCost` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `providerReference` VARCHAR(191) NULL,
    `failureReason` TEXT NULL,
    `notes` TEXT NULL,
    `createdById` CHAR(36) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `provider_purchases_reference_key`(`reference`),
    INDEX `provider_purchases_providerId_createdAt_idx`(`providerId`, `createdAt`),
    INDEX `provider_purchases_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_capacity_ledger` (
    `id` CHAR(36) NOT NULL,
    `providerId` CHAR(36) NOT NULL,
    `type` ENUM('PURCHASE', 'USAGE', 'RELEASE', 'ADJUSTMENT') NOT NULL,
    `amount` INTEGER NOT NULL,
    `balanceBefore` INTEGER NOT NULL,
    `balanceAfter` INTEGER NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `unitCost` DECIMAL(14, 4) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `provider_capacity_ledger_reference_key`(`reference`),
    INDEX `provider_capacity_ledger_providerId_createdAt_idx`(`providerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallets` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `balance` INTEGER NOT NULL DEFAULT 0,
    `lowBalanceThreshold` INTEGER NOT NULL DEFAULT 500,
    `lowBalanceNotifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallets_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_transactions` (
    `id` CHAR(36) NOT NULL,
    `walletId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `type` ENUM('PURCHASE', 'SMS_DEBIT', 'REFUND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ADJUSTMENT', 'EXPIRATION') NOT NULL,
    `amount` INTEGER NOT NULL,
    `balanceBefore` INTEGER NOT NULL,
    `balanceAfter` INTEGER NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `createdById` CHAR(36) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `wallet_transactions_reference_key`(`reference`),
    INDEX `wallet_transactions_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `wallet_transactions_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_packages` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `credits` INTEGER NOT NULL,
    `price` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'RWF',
    `estimatedProviderCost` DECIMAL(14, 2) NULL,
    `validityDays` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isPopular` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sms_packages_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `packageId` CHAR(36) NULL,
    `reference` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerReference` VARCHAR(191) NULL,
    `method` ENUM('MOBILE_MONEY', 'CARD', 'BANK_TRANSFER') NOT NULL,
    `payerPhone` VARCHAR(191) NULL,
    `packageName` VARCHAR(191) NOT NULL,
    `credits` INTEGER NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `feeAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `failureReason` TEXT NULL,
    `createdById` CHAR(36) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `creditedAt` DATETIME(3) NULL,
    `refundedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_reference_key`(`reference`),
    UNIQUE INDEX `payments_providerReference_key`(`providerReference`),
    INDEX `payments_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `payments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_events` (
    `id` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerEventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_events_paymentId_idx`(`paymentId`),
    UNIQUE INDEX `payment_events_provider_providerEventId_key`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` CHAR(36) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `customerName` TEXT NOT NULL,
    `customerEmail` TEXT NULL,
    `billingAddress` TEXT NULL,
    `taxId` VARCHAR(191) NULL,
    `description` TEXT NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(14, 4) NOT NULL,
    `subtotal` DECIMAL(14, 2) NOT NULL,
    `taxRate` DECIMAL(5, 2) NOT NULL,
    `taxAmount` DECIMAL(14, 2) NOT NULL,
    `total` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `status` ENUM('PAID', 'VOID', 'REFUNDED') NOT NULL DEFAULT 'PAID',
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `invoices_number_key`(`number`),
    UNIQUE INDEX `invoices_paymentId_key`(`paymentId`),
    INDEX `invoices_organizationId_issuedAt_idx`(`organizationId`, `issuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_leases` (
    `name` VARCHAR(191) NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `lockedUntil` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_purchases` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `packageId` CHAR(36) NULL,
    `packageName` VARCHAR(191) NOT NULL,
    `credits` INTEGER NOT NULL,
    `revenue` DECIMAL(14, 2) NOT NULL,
    `estimatedProviderCost` DECIMAL(14, 2) NOT NULL,
    `paymentFee` DECIMAL(14, 2) NOT NULL,
    `contribution` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `customer_purchases_paymentId_key`(`paymentId`),
    INDEX `customer_purchases_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `customer_purchases_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `creditsReversed` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refunds_paymentId_key`(`paymentId`),
    INDEX `refunds_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` CHAR(36) NOT NULL,
    `category` ENUM('INFRASTRUCTURE', 'SOFTWARE', 'PERSONNEL', 'MARKETING', 'REGULATORY', 'PAYMENT_PROCESSING', 'OTHER') NOT NULL,
    `description` TEXT NOT NULL,
    `vendor` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `incurredAt` DATETIME(3) NOT NULL,
    `createdById` CHAR(36) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `expenses_incurredAt_idx`(`incurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_inquiries` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `company` VARCHAR(191) NULL,
    `message` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'NEW',
    `ipAddress` VARCHAR(191) NULL,
    `handledAt` DATETIME(3) NULL,
    `handledById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `contact_inquiries_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `counters` (
    `key` VARCHAR(191) NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` TEXT NULL,
    `tags` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'UNSUBSCRIBED', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `contacts_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `contacts_phone_idx`(`phone`),
    UNIQUE INDEX `contacts_organizationId_phone_key`(`organizationId`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_groups` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `color` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `contact_groups_organizationId_name_key`(`organizationId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_group_members` (
    `groupId` CHAR(36) NOT NULL,
    `contactId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `contact_group_members_contactId_idx`(`contactId`),
    PRIMARY KEY (`groupId`, `contactId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaigns` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `message` TEXT NOT NULL,
    `status` ENUM('DRAFT', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `scheduledAt` DATETIME(3) NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Africa/Kigali',
    `failureReason` TEXT NULL,
    `createdById` CHAR(36) NOT NULL,
    `launchedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `campaigns_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `campaigns_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_groups` (
    `campaignId` CHAR(36) NOT NULL,
    `groupId` CHAR(36) NOT NULL,

    PRIMARY KEY (`campaignId`, `groupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_recipients` (
    `id` CHAR(36) NOT NULL,
    `campaignId` CHAR(36) NOT NULL,
    `contactId` CHAR(36) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `campaign_recipients_campaignId_idx`(`campaignId`),
    UNIQUE INDEX `campaign_recipients_campaignId_phone_key`(`campaignId`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_messages` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `senderName` VARCHAR(191) NOT NULL,
    `campaignId` CHAR(36) NULL,
    `apiKeyId` CHAR(36) NULL,
    `createdById` CHAR(36) NULL,
    `source` ENUM('DASHBOARD', 'API', 'CAMPAIGN') NOT NULL,
    `body` TEXT NOT NULL,
    `characterCount` INTEGER NOT NULL,
    `encoding` ENUM('GSM7', 'UCS2') NOT NULL,
    `segments` INTEGER NOT NULL,
    `recipientCount` INTEGER NOT NULL,
    `creditsPerRecipient` INTEGER NOT NULL,
    `totalCredits` INTEGER NOT NULL,
    `status` ENUM('SCHEDULED', 'QUEUED', 'PROCESSING', 'SENT', 'COMPLETED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `scheduledAt` DATETIME(3) NULL,
    `timezone` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `clientReference` VARCHAR(191) NULL,
    `processedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_messages_campaignId_key`(`campaignId`),
    INDEX `sms_messages_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `sms_messages_status_scheduledAt_idx`(`status`, `scheduledAt`),
    UNIQUE INDEX `sms_messages_organizationId_idempotencyKey_key`(`organizationId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_recipients` (
    `id` CHAR(36) NOT NULL,
    `messageId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `campaignId` CHAR(36) NULL,
    `contactId` CHAR(36) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `credits` INTEGER NOT NULL,
    `provider` VARCHAR(191) NULL,
    `providerId` CHAR(36) NULL,
    `providerCost` DECIMAL(14, 4) NULL,
    `capacityReleased` BOOLEAN NOT NULL DEFAULT false,
    `providerMessageId` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `refunded` BOOLEAN NOT NULL DEFAULT false,
    `submittedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_recipients_providerMessageId_key`(`providerMessageId`),
    INDEX `sms_recipients_messageId_status_idx`(`messageId`, `status`),
    INDEX `sms_recipients_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `sms_recipients_campaignId_idx`(`campaignId`),
    INDEX `sms_recipients_status_updatedAt_idx`(`status`, `updatedAt`),
    INDEX `sms_recipients_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_delivery_reports` (
    `id` CHAR(36) NOT NULL,
    `recipientId` CHAR(36) NOT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED') NOT NULL,
    `providerStatus` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `source` ENUM('SUBMISSION', 'CALLBACK', 'POLL') NOT NULL,
    `payload` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sms_delivery_reports_recipientId_idx`(`recipientId`),
    INDEX `sms_delivery_reports_providerMessageId_idx`(`providerMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_keys` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `prefix` VARCHAR(191) NOT NULL,
    `keyHash` VARCHAR(191) NOT NULL,
    `lastFour` VARCHAR(191) NOT NULL,
    `scopes` JSON NOT NULL,
    `allowedIps` JSON NOT NULL,
    `environment` VARCHAR(191) NOT NULL DEFAULT 'production',
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `rateLimitPerMinute` INTEGER NULL,
    `createdById` CHAR(36) NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `lastUsedIp` VARCHAR(191) NULL,
    `usageCount` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `api_keys_prefix_key`(`prefix`),
    INDEX `api_keys_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_request_logs` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `apiKeyId` CHAR(36) NULL,
    `method` VARCHAR(191) NOT NULL,
    `path` TEXT NOT NULL,
    `statusCode` INTEGER NOT NULL,
    `durationMs` INTEGER NOT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `errorCode` VARCHAR(191) NULL,
    `requestId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `api_request_logs_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `api_request_logs_apiKeyId_createdAt_idx`(`apiKeyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhooks` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `url` TEXT NOT NULL,
    `description` TEXT NULL,
    `events` JSON NOT NULL,
    `secretEncrypted` TEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `webhooks_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` CHAR(36) NOT NULL,
    `webhookId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'SUCCESS', 'RETRYING', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `responseStatus` INTEGER NULL,
    `responseBody` TEXT NULL,
    `lastError` TEXT NULL,
    `durationMs` INTEGER NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `webhook_deliveries_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `webhook_deliveries_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    UNIQUE INDEX `webhook_deliveries_webhookId_eventId_key`(`webhookId`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` TEXT NOT NULL,
    `body` TEXT NOT NULL,
    `link` TEXT NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `actorType` ENUM('USER', 'API_KEY', 'SYSTEM') NOT NULL,
    `actorId` CHAR(36) NULL,
    `apiKeyId` CHAR(36) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `organizationId` CHAR(36) NULL,
    `action` VARCHAR(191) NOT NULL,
    `resource` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `requestId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `audit_logs_actorId_idx`(`actorId`),
    INDEX `audit_logs_action_idx`(`action`),
    INDEX `audit_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_settings` (
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `description` TEXT NULL,
    `updatedById` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_messages` (
    `id` CHAR(36) NOT NULL,
    `to` VARCHAR(255) NOT NULL,
    `subject` TEXT NOT NULL,
    `text` MEDIUMTEXT NOT NULL,
    `html` MEDIUMTEXT NULL,
    `template` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `error` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `email_messages_to_createdAt_idx`(`to`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `simulator_records` (
    `id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `simulator_records_kind_idx`(`kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_tokens` ADD CONSTRAINT `user_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `roles` ADD CONSTRAINT `roles_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_invitations` ADD CONSTRAINT `organization_invitations_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_invitations` ADD CONSTRAINT `organization_invitations_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_invitations` ADD CONSTRAINT `organization_invitations_invitedById_fkey` FOREIGN KEY (`invitedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verifications` ADD CONSTRAINT `verifications_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_reviews` ADD CONSTRAINT `verification_reviews_verificationId_fkey` FOREIGN KEY (`verificationId`) REFERENCES `verifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_documents` ADD CONSTRAINT `verification_documents_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `verification_documents` ADD CONSTRAINT `verification_documents_verificationId_fkey` FOREIGN KEY (`verificationId`) REFERENCES `verifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sender_ids` ADD CONSTRAINT `sender_ids_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sender_id_reviews` ADD CONSTRAINT `sender_id_reviews_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `sender_ids`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sender_id_registrations` ADD CONSTRAINT `sender_id_registrations_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `sender_ids`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sender_id_registrations` ADD CONSTRAINT `sender_id_registrations_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_purchases` ADD CONSTRAINT `provider_purchases_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_capacity_ledger` ADD CONSTRAINT `provider_capacity_ledger_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets` ADD CONSTRAINT `wallets_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `sms_packages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_events` ADD CONSTRAINT `payment_events_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_purchases` ADD CONSTRAINT `customer_purchases_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_purchases` ADD CONSTRAINT `customer_purchases_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_purchases` ADD CONSTRAINT `customer_purchases_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `sms_packages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_groups` ADD CONSTRAINT `contact_groups_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_group_members` ADD CONSTRAINT `contact_group_members_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `contact_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contact_group_members` ADD CONSTRAINT `contact_group_members_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `contacts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaigns` ADD CONSTRAINT `campaigns_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `sender_ids`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_groups` ADD CONSTRAINT `campaign_groups_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_groups` ADD CONSTRAINT `campaign_groups_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `contact_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `campaign_recipients` ADD CONSTRAINT `campaign_recipients_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_messages` ADD CONSTRAINT `sms_messages_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_messages` ADD CONSTRAINT `sms_messages_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `sender_ids`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_messages` ADD CONSTRAINT `sms_messages_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `campaigns`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_messages` ADD CONSTRAINT `sms_messages_apiKeyId_fkey` FOREIGN KEY (`apiKeyId`) REFERENCES `api_keys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_recipients` ADD CONSTRAINT `sms_recipients_messageId_fkey` FOREIGN KEY (`messageId`) REFERENCES `sms_messages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_recipients` ADD CONSTRAINT `sms_recipients_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_recipients` ADD CONSTRAINT `sms_recipients_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_delivery_reports` ADD CONSTRAINT `sms_delivery_reports_recipientId_fkey` FOREIGN KEY (`recipientId`) REFERENCES `sms_recipients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_keys` ADD CONSTRAINT `api_keys_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_request_logs` ADD CONSTRAINT `api_request_logs_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_request_logs` ADD CONSTRAINT `api_request_logs_apiKeyId_fkey` FOREIGN KEY (`apiKeyId`) REFERENCES `api_keys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhooks` ADD CONSTRAINT `webhooks_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_webhookId_fkey` FOREIGN KEY (`webhookId`) REFERENCES `webhooks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Integrity rules carried over from the PostgreSQL migrations
-- (immutable_ledgers, system_role_unique, providers_finance).
-- ─────────────────────────────────────────────────────────────

-- Audit logs and ledger entries are append-only.
-- Any UPDATE or DELETE is rejected at the database level, regardless of application bugs.
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table audit_logs is append-only (UPDATE is not allowed)';
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table audit_logs is append-only (DELETE is not allowed)';
CREATE TRIGGER `wallet_transactions_no_update` BEFORE UPDATE ON `wallet_transactions` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table wallet_transactions is append-only (UPDATE is not allowed)';
CREATE TRIGGER `wallet_transactions_no_delete` BEFORE DELETE ON `wallet_transactions` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table wallet_transactions is append-only (DELETE is not allowed)';
CREATE TRIGGER `provider_capacity_ledger_no_update` BEFORE UPDATE ON `provider_capacity_ledger` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table provider_capacity_ledger is append-only (UPDATE is not allowed)';
CREATE TRIGGER `provider_capacity_ledger_no_delete` BEFORE DELETE ON `provider_capacity_ledger` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table provider_capacity_ledger is append-only (DELETE is not allowed)';

-- Wallet balance can never go negative.
ALTER TABLE `wallets` ADD CONSTRAINT `wallets_balance_non_negative` CHECK (`balance` >= 0);

-- Capacity can only go negative within an explicitly configured overdraft.
ALTER TABLE `sms_providers` ADD CONSTRAINT `sms_providers_capacity_floor`
  CHECK (`capacityBalance` >= CASE WHEN `allowOverdraft` THEN -`overdraftLimit` ELSE 0 END);
ALTER TABLE `provider_purchases` ADD CONSTRAINT `provider_purchases_positive` CHECK (`quantity` > 0 AND `totalCost` >= 0);
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_non_negative` CHECK (`amount` >= 0);

-- NULLs are distinct in a composite UNIQUE, so platform-wide role definitions (organizationId IS NULL)
-- need their own rule. MySQL has no partial indexes; a functional index maps NULL to '' instead
-- (a real organizationId is always a 36-char UUID, so the two can never collide).
CREATE UNIQUE INDEX `roles_scope_code_global_key` ON `roles` (`scope`, `code`, (IFNULL(`organizationId`, '')));
