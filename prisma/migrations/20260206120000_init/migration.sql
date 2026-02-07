-- CreateTable
CREATE TABLE "LeaderboardSite" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "refreshInterval" INTEGER,
    "useGlobalInterval" BOOLEAN NOT NULL DEFAULT true,
    "lastScrapedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardCycle" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "timerDuration" INTEGER,
    "prizePool" DECIMAL(18,2),

    CONSTRAINT "LeaderboardCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardSnapshot" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "confidence" INTEGER,
    "extractionMethod" TEXT,
    "totalWager" DECIMAL(18,2),
    "prizePool" DECIMAL(18,2),
    "apiValidated" BOOLEAN NOT NULL DEFAULT false,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardEntry" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "wager" DECIMAL(18,2) NOT NULL,
    "prize" DECIMAL(18,2) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScraperConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardSite_domain_key" ON "LeaderboardSite"("domain");

-- CreateIndex
CREATE INDEX "LeaderboardCycle_siteId_siteName_idx" ON "LeaderboardCycle"("siteId", "siteName");

-- CreateIndex
CREATE INDEX "LeaderboardSnapshot_cycleId_idx" ON "LeaderboardSnapshot"("cycleId");

-- CreateIndex
CREATE INDEX "LeaderboardSnapshot_scrapedAt_idx" ON "LeaderboardSnapshot"("scrapedAt");

-- CreateIndex
CREATE INDEX "LeaderboardEntry_snapshotId_idx" ON "LeaderboardEntry"("snapshotId");

-- CreateIndex
CREATE INDEX "LeaderboardEntry_username_scrapedAt_idx" ON "LeaderboardEntry"("username", "scrapedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScraperConfig_key_key" ON "ScraperConfig"("key");

-- AddForeignKey
ALTER TABLE "LeaderboardCycle" ADD CONSTRAINT "LeaderboardCycle_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "LeaderboardSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardSnapshot" ADD CONSTRAINT "LeaderboardSnapshot_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "LeaderboardCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardEntry" ADD CONSTRAINT "LeaderboardEntry_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "LeaderboardSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
