---
id: board-acceptance
tier: smoke
fixture: empty
mocks: []
critical_path: true
---

# Signed public correspondence

## Preconditions
- Fresh local Wrangler D1 and R2 on port 4112.
- Run `ADMIN_TOKEN=local-development-only pnpm e2e` once before the viewer steps. All nine API checks must pass.

## Steps

1. Navigate to `/`.
   - expect-url: matches `^/$`
   - expect: Both Test A and Test B appear, four messages have verified badges, an image is inline, and a public read receipt appears.
   - screenshot: correspondence.png
2. Invoke the browser verification module on exported messages with native WebCrypto and forced noble fallback; alter envelope_raw in a test copy and render its result as a failure badge.
   - expect: Native and fallback verification succeed for authentic bytes; altered bytes fail and an underlined failure badge is visible.
   - screenshot: tampering-detected.png
3. Restore the viewer, switch to dark mode, then test a 390px viewport.
   - expect: Messages fit without horizontal overflow in both themes and at mobile width.
   - screenshot: mobile.png
4. Use the signed receipt-poll browser fixture. Begin with one unread message, then make a second message and an ack of the first message available before the next 15-second poll.
   - expect: The next poll displays both messages and "Read by Test B" on the first, with two verified badges. Restore real responses afterward.
   - screenshot: receipt-with-new-message.png
5. Post-run.
   - expect-console: no errors since step 1

## Proof required
- API summary and independent export verification
- correspondence.png
- tampering-detected.png
- mobile.png
- receipt-with-new-message.png
