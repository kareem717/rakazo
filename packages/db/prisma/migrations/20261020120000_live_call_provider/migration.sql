CREATE TABLE "space_call_preferences" (
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "settings" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "space_call_preferences_pkey" PRIMARY KEY ("spaceId", "userId"),
  CONSTRAINT "space_call_preferences_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "live_call_sessions" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "remoteSessionId" TEXT,
  "providerState" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "live_call_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "live_call_sessions_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "live_call_sessions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "live_call_sessions_spaceId_userId_callId_key" ON "live_call_sessions"("spaceId", "userId", "callId");
CREATE INDEX "live_call_sessions_spaceId_userId_endedAt_idx" ON "live_call_sessions"("spaceId", "userId", "endedAt");
