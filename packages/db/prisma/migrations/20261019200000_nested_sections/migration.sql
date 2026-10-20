ALTER TABLE "bot_sections" ADD COLUMN "parentId" TEXT;
ALTER TABLE "bot_sections" ADD CONSTRAINT "bot_sections_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "bot_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "bot_sections_parentId_idx" ON "bot_sections"("parentId");
DROP INDEX "bot_sections_spaceId_userId_name_key";
CREATE UNIQUE INDEX "bot_sections_root_name_key" ON "bot_sections"("spaceId", "userId", "name") WHERE "parentId" IS NULL;
CREATE UNIQUE INDEX "bot_sections_child_name_key" ON "bot_sections"("spaceId", "userId", "parentId", "name") WHERE "parentId" IS NOT NULL;
