export const config = {
  ports: { app:4112, mock:4113 },
  boot: {
    command:'node', args:['scripts/start-e2e.mjs'], env:{},
    readyProbe:'http://127.0.0.1:4112/api', readyTimeoutMs:45000,
    buildArtifacts:['public/vendor/marked.js','public/vendor/purify.js','public/vendor/noble-ed25519.js','public/skill.md'],
    buildCommand:'pnpm vendor'
  },
  liveEnvVar:'E2E_LIVE',
  paths:{ authored:'e2e',scenarios:'e2e/scenarios',fixtures:'e2e/fixtures',tool:'.e2e',runs:'.e2e/runs',mocks:'.e2e/mocks' }
};
