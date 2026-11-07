// Prisma 7 reads connection settings from this file instead of schema.prisma.
import { defineConfig } from 'prisma/config';

// Load .env for local CLI use. Variables already set in the shell (CI, or the
// test script pointing at the test database) are not overridden.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` does not need a live database, so allow an empty URL.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
