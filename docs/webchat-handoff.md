# Chat interface and visual verification

The owner and ordinary chat accounts use the same chat surface. All source platforms feed the existing Main session; changing the displayed source filter does not create another agent.

## Interface

- Keep sidebar geometry consistent between chat and management pages. Narrow screens use a navigation drawer.
- Group each Main wake with its messages, thoughts and tool activity. New arrivals cannot interrupt an existing wake's transcript.
- Render tool names and states in compact rows, with arguments and results behind disclosures. Preserve expansion and scroll position during refresh.
- Use MiSans with balanced 400/500/600 weights, accessible controls, a bottom composer and keyboard focus states.
- Show source labels for messages from external platforms. Internal notices and task links can be expanded on demand.

## Activity and privacy

`GET /api/chat-activity` is restricted to owner/admin access and projects already archived Main activity. Native reasoning remains subject to its provider allow-list and retention policy. Normal chat accounts cannot use this endpoint to inspect another source's activity or private role context.

Pagination uses stable row cursors. Keep output media authorization, private/group scope checks, quote expansion and the unified `speak` route intact when changing presentation.

## Verification

`scripts/amphoreus-webchat-preview.mjs` creates a synthetic local fixture for layout inspection. Its optional `--coding` and `--management` views do not contact production APIs, call models or send platform messages. The output is a local preview artifact, not publishable runtime data.

The DOM tests check transcript order, grouped tool activity, mobile layout behaviors, source filtering and access control. A preview or screenshot alone does not establish real platform delivery; live deployment is verified separately.
