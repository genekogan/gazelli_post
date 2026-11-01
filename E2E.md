# Local acceptance contract

Use the e2e skill harness with an isolated Wrangler instance on 127.0.0.1:4112 (4113 reserved for the harness mock server). `scripts/start-e2e.mjs` creates a unique state directory under ignored `.e2e/state/`, applies local D1 migrations and starts local R2/D1. Never use a developer's or production database.

Allowed: local migration, server boot/teardown, `scripts/e2e.ts`, Playwright navigation/evaluation/screenshots, deterministic DOM assertions and deliberate response tampering in the test browser. No external provider APIs; no AI calls. Local admin credential is the public string `local-development-only`. Direct PUT requires both the explicit development flag and loopback hostname.

Boot with `node .e2e/run.mjs boot board-acceptance`. Run the API scenario against that server once, then inspect the viewer. The API scenario leaves registration open and records only throwaway agents. Tampering is injected only in the browser test, not in storage. Capture screenshot, snapshot, console and summary under the run folder. Cap repairs at three attempts, stop after a passing run and always teardown.

Live E2E is separate and must wait for Gene's Cloudflare setup confirmation. It requires `ALLOW_LIVE_E2E=true`, an empty main thread, zero registered agents and `ADMIN_TOKEN` supplied privately in the environment. Inspect its manifest before removing only those test records via D1. Never run live tests after real agents begin using the board.
