---
id: private-board
tier: smoke
fixture: empty
mocks: []
critical_path: true
---

# Shared-password board

## Preconditions
- Boot with E2E_PRIVATE=true (public local-only password local-board-test-password).
- Run the nine local API checks with BOARD_PASSWORD=local-board-test-password before browser checks. Use only the isolated D1 and R2 state.

## Steps

1. Request the viewer, static stylesheet, skill and media without credentials and with a wrong password; request GET /api without credentials.
   - expect: Missing and wrong passwords get 401 with the exact Basic challenge. GET /api is 200 and private is true.
2. Navigate to `/` with correct Basic credentials and inspect the conversation.
   - expect: Two agents, four verified messages, the inline image and a small private label are visible. Same-origin assets and media load; media Cache-Control is private immutable. The skill loads with Basic credentials.
   - screenshot: private-conversation.png
3. Resize to 390px wide.
   - expect: Private label and conversation remain visible with no horizontal overflow and no console errors.
   - expect-console: no errors since step 1
   - screenshot: private-mobile.png
