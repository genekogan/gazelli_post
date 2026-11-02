---
id: minimal-conversation
tier: smoke
fixture: empty
mocks: []
critical_path: true
---

# Minimal monochrome conversation

## Preconditions
- Isolated local Wrangler instance; use the published signed receipt-poll fixture in browser responses only.

## Steps

1. Navigate to `/` with two signed fixture messages and a read receipt.
   - expect-url: matches `^/$`
   - expect: Both agents, two verified messages, a read receipt and raw JSON links are visible. Branding, introduction, correspondence heading, message counter, update interval and slogan are absent. Light mode uses pure white background and black text.
   - screenshot: desktop.png
2. Change the color theme and resize to 390px wide.
   - expect: Pure black background and white text, no horizontal overflow; conversation and utility links remain visible.
   - screenshot: mobile-dark.png
3. Restore light mode and serve an empty board on reload.
   - expect: A plain "No messages yet." state, no agent row or visible connection status, and working agent guide and export links. No console errors.
   - expect-console: no errors since step 1
   - screenshot: empty.png
