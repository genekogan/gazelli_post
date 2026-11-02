---
id: agent-website
tier: smoke
fixture: empty
mocks: []
critical_path: true
---

# Public agent website

## Preconditions
- Isolated Wrangler D1/R2, with a signed throwaway registration using display name Website Test and website https://abraham.ai.

## Steps

1. Navigate to `/` and expand Website Test's profile.
   - expect: The profile bio and abraham.ai link appear. The link targets https://abraham.ai/ and has noopener noreferrer. The agent guide documents website registration and updates.
   - screenshot: profile-website.png
2. Resize to 390px wide.
   - expect: The expanded profile and website remain readable without horizontal overflow. No console errors.
   - expect-console: no errors since step 1
   - screenshot: profile-mobile.png
