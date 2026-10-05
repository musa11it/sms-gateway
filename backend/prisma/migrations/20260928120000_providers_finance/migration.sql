-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('MNO', 'AGGREGATOR');

-- CreateEnum
CREATE TYPE "ProviderMode" AS ENUM ('SIMULATION', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProviderPurchaseStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "CapacityEntryType" AS ENUM ('PURCHASE', 'USAGE', 'RELEASE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('INFRASTRUCTURE', 'SOFTWARE', 'PERSONNEL', 'MARKETING', 'REGULATORY', 'PAYMENT_PROCESSING', 'OTHER');

-- AlterEnum
ALTER TYPE "UserTokenType" ADD VALUE 'PHONE_VERIFICATION';

-- AlterEnum: rename keeps existing rows valid (no data loss)
ALTER TYPE "VerificationStatus" RENAME VALUE 'CHANGES_REQUESTED' TO 'MORE_INFORMATION_REQUIRED';
ALTER TYPE "VerificationStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'production',
ADD COLUMN     "isEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rateLimitPerMinute" INTEGER;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "smsHourlyLimit" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sms_packages" ADD COLUMN     "estimatedProviderCost" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "sms_recipients" ADD COLUMN     "capacityReleased" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerCost" DECIMAL(14,4),
ADD COLUMN     "providerId" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "verification_reviews" (
    "id" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reviewerId" UUID,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_id_reviews" (
    "id" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reviewerId" UUID,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_id_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_id_registrations" (
    "id" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "providerReference" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_id_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_providers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProviderType" NOT NULL,
    "mode" "ProviderMode" NOT NULL DEFAULT 'SIMULATION',
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "costPerSms" DECIMAL(14,4) NOT NULL,
    "routePrefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 100,
    "capacityBalance" INTEGER NOT NULL DEFAULT 0,
    "totalPurchased" INTEGER NOT NULL DEFAULT 0,
    "totalUsed" INTEGER NOT NULL DEFAULT 0,
    "totalSpent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "allowOverdraft" BOOLEAN NOT NULL DEFAULT false,
    "overdraftLimit" INTEGER NOT NULL DEFAULT 0,
    "lowCapacityThreshold" INTEGER NOT NULL DEFAULT 10000,
    "notes" TEXT,
    "lastTransactionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_purchases" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "ProviderPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "failureReason" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_capacity_ledger" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "type" "CapacityEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "unitCost" DECIMAL(14,4),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_capacity_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_purchases" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "packageId" UUID,
    "packageName" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "estimatedProviderCost" DECIMAL(14,2) NOT NULL,
    "paymentFee" DECIMAL(14,2) NOT NULL,
    "contribution" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "creditsReversed" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "vendor" TEXT,
    "reference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "incurredAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_inquiries" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "company" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "ipAddress" TEXT,
    "handledAt" TIMESTAMP(3),
    "handledById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_reviews_verificationId_createdAt_idx" ON "verification_reviews"("verificationId", "createdAt");

-- CreateIndex
CREATE INDEX "sender_id_reviews_senderId_createdAt_idx" ON "sender_id_reviews"("senderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sender_id_registrations_senderId_providerId_key" ON "sender_id_registrations"("senderId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "sms_providers_code_key" ON "sms_providers"("code");

-- CreateIndex
CREATE INDEX "sms_providers_status_idx" ON "sms_providers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_purchases_reference_key" ON "provider_purchases"("reference");

-- CreateIndex
CREATE INDEX "provider_purchases_providerId_createdAt_idx" ON "provider_purchases"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "provider_purchases_status_createdAt_idx" ON "provider_purchases"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_capacity_ledger_reference_key" ON "provider_capacity_ledger"("reference");

-- CreateIndex
CREATE INDEX "provider_capacity_ledger_providerId_createdAt_idx" ON "provider_capacity_ledger"("providerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_purchases_paymentId_key" ON "customer_purchases"("paymentId");

-- CreateIndex
CREATE INDEX "customer_purchases_organizationId_createdAt_idx" ON "customer_purchases"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_purchases_createdAt_idx" ON "customer_purchases"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_paymentId_key" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_createdAt_idx" ON "refunds"("createdAt");

-- CreateIndex
CREATE INDEX "expenses_incurredAt_idx" ON "expenses"("incurredAt");

-- CreateIndex
CREATE INDEX "contact_inquiries_status_createdAt_idx" ON "contact_inquiries"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "verification_reviews" ADD CONSTRAINT "verification_reviews_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_id_reviews" ADD CONSTRAINT "sender_id_reviews_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "sender_ids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_id_registrations" ADD CONSTRAINT "sender_id_registrations_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "sender_ids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_id_registrations" ADD CONSTRAINT "sender_id_registrations_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "sms_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_purchases" ADD CONSTRAINT "provider_purchases_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "sms_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_capacity_ledger" ADD CONSTRAINT "provider_capacity_ledger_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "sms_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_purchases" ADD CONSTRAINT "customer_purchases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_purchases" ADD CONSTRAINT "customer_purchases_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_purchases" ADD CONSTRAINT "customer_purchases_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "sms_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_recipients" ADD CONSTRAINT "sms_recipients_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "sms_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Provider capacity ledger is append-only, like audit logs and the wallet ledger.
CREATE TRIGGER provider_capacity_ledger_append_only
  BEFORE UPDATE OR DELETE ON "provider_capacity_ledger"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Capacity can only go negative within an explicitly configured overdraft.
ALTER TABLE "sms_providers" ADD CONSTRAINT "sms_providers_capacity_floor"
  CHECK ("capacityBalance" >= CASE WHEN "allowOverdraft" THEN -"overdraftLimit" ELSE 0 END);
ALTER TABLE "provider_purchases" ADD CONSTRAINT "provider_purchases_positive" CHECK ("quantity" > 0 AND "totalCost" >= 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_non_negative" CHECK ("amount" >= 0);
