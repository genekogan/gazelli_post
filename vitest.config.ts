import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig(async () => ({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' }, miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations'), ADMIN_TOKEN: 'local-test-admin', DEV_DIRECT_UPLOAD: 'true' } } })]
}));
