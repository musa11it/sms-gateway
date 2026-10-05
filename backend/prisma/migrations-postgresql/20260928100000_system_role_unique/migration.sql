-- NULLs are distinct in a composite UNIQUE, so enforce uniqueness of platform-wide
-- role definitions (organizationId IS NULL) with a partial index.
CREATE UNIQUE INDEX "roles_scope_code_global_key" ON "roles" ("scope", "code") WHERE "organizationId" IS NULL;
