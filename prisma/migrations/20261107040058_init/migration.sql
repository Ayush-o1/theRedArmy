-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('SIMULATED', 'OPENAI_COMPATIBLE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('USER', 'API_KEY');

-- CreateEnum
CREATE TYPE "RunCaseStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'ERROR', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_configs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "base_url" TEXT,
    "api_key_ciphertext" TEXT,
    "api_key_last4" TEXT,
    "requests_per_minute" INTEGER NOT NULL DEFAULT 60,
    "input_cost_per_mtok" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "output_cost_per_mtok" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "latest_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL,
    "prompt_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "template" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "max_tokens" INTEGER NOT NULL DEFAULT 512,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suites" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" UUID NOT NULL,
    "suite_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "assertions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "prompt_version_id" UUID NOT NULL,
    "suite_id" UUID NOT NULL,
    "provider_config_id" UUID NOT NULL,
    "baseline_run_id" UUID,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "RunTrigger" NOT NULL DEFAULT 'USER',
    "created_by_id" UUID,
    "use_cache" BOOLEAN NOT NULL DEFAULT true,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "total_cases" INTEGER NOT NULL DEFAULT 0,
    "passed_cases" INTEGER NOT NULL DEFAULT 0,
    "failed_cases" INTEGER NOT NULL DEFAULT 0,
    "errored_cases" INTEGER NOT NULL DEFAULT 0,
    "cached_cases" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_cases" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "test_case_id" UUID,
    "case_name" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "assertions" JSONB NOT NULL,
    "status" "RunCaseStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "rendered_prompt" TEXT,
    "output" TEXT,
    "assertion_results" JSONB,
    "error" TEXT,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "run_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cached_responses" (
    "key" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "output" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cached_responses_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_owner_id_name_key" ON "projects"("owner_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "provider_configs_project_id_name_key" ON "provider_configs"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_project_id_name_key" ON "prompts"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_prompt_id_version_key" ON "prompt_versions"("prompt_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "suites_project_id_name_key" ON "suites"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "test_cases_suite_id_name_key" ON "test_cases"("suite_id", "name");

-- CreateIndex
CREATE INDEX "runs_project_id_created_at_idx" ON "runs"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "runs_project_id_idempotency_key_key" ON "runs"("project_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "run_cases_run_id_status_idx" ON "run_cases"("run_id", "status");

-- CreateIndex
CREATE INDEX "run_cases_status_available_at_idx" ON "run_cases"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "run_cases_run_id_test_case_id_key" ON "run_cases"("run_id", "test_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- CreateIndex
CREATE INDEX "cached_responses_project_id_idx" ON "cached_responses"("project_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suites" ADD CONSTRAINT "suites_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "provider_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_baseline_run_id_fkey" FOREIGN KEY ("baseline_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_cases" ADD CONSTRAINT "run_cases_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_cases" ADD CONSTRAINT "run_cases_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cached_responses" ADD CONSTRAINT "cached_responses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
