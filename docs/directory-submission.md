# Submitting yoy.fyi to the connector directories

What to paste where, so the two forms take minutes. Requirements were read from the official pages on 2026-10-26; check them again before submitting, the portals change.

- Anthropic: [Submit a connector](https://claude.com/docs/connectors/building/submission), portal at https://claude.ai/directory/manage (any paid Claude plan).
- OpenAI: [Submission](https://developers.openai.com/apps-sdk/deploy/submission) (organization verified on the OpenAI Platform, submitter is an Owner or has Apps Management Write).

## What is already in place

| Requirement | Where |
|---|---|
| Remote server over HTTPS, Streamable HTTP | `https://yoy.fyi/mcp` |
| OAuth 2.1 with PKCE, CIMD and DCR, revocation | `/.well-known/oauth-authorization-server` |
| Every tool has `title` and `readOnlyHint` / `destructiveHint` | `src/mcp.ts`, checked in `tests/mcp.test.ts` |
| Documentation URL | https://yoy.fyi/en/docs/mcp |
| Privacy policy, terms | https://yoy.fyi/privacy, https://yoy.fyi/terms (the page follows the visitor's language) |
| Support contact | the address on the privacy page (`ADMIN_EMAIL`) |
| Icon, square SVG and PNG 512, 192, 48 | `/static/icon.svg`, `/static/icon-512.png` |
| MCP Apps views (card with QR, clicks chart) | `ui://yoy.fyi/link-card-v1`, `ui://yoy.fyi/clicks-chart-v1` |
| OpenAI domain verification | `/.well-known/openai-apps-challenge`, served when `OPENAI_APPS_CHALLENGE` is set in `deploy/prod.env` |

## What only the owner can do

1. **A reviewer account.** Sign-in is Google only, so create a dedicated Google account for reviewers (for example `yoy.fyi.review@gmail.com`) with no 2-step prompts at sign-in, sign in once at https://yoy.fyi, and create 3 or 4 links so the account is populated (a title, a tag, an expiry, a preview and a bio page make the tools worth testing). Keep the password out of the repo; it goes only into the two portals.
2. **A paid Claude plan** for the Anthropic portal, and a **verified OpenAI organization** for the OpenAI one.
3. **OpenAI's domain token.** The submission form shows a token; put it in `deploy/prod.env` as `OPENAI_APPS_CHALLENGE=<token>`, merge the PR, and press verify.
4. **A demo recording** for OpenAI (`demo_recording_url`): a short screen recording of the steps under Test cases below.

## Listing text (English)

- **Name:** yoy.fyi
- **One-liner (200):** Create real short links and QR codes from chat, and see where the clicks come from.
- **Description (2000):**

  > yoy.fyi makes short links and QR codes with click analytics, and now your assistant can use it. Ask it to shorten a link, give the link a custom code, title, tags and expiry, tag it for Telegram, Instagram or email, and it returns a working https://yoy.fyi/... address together with its QR code and a copy button, instead of inventing a URL.
  >
  > Ask how many clicks a link got this week and from which sources, countries and devices. Search your links, change where one points without reprinting its QR code, take one down, import up to 20 at once, or publish a link-in-bio page at yoy.fyi/@name. A link's preview card in Telegram and Facebook can be customised.
  >
  > Free. You sign in with Google; each person only ever sees their own links. Writing is a separate permission that starts switched off on the consent screen, and you can revoke the connection at any time at https://yoy.fyi/account/apps. No IP addresses are stored.

- **Categories:** Productivity, Marketing / Analytics (whichever the form offers).
- **Use cases:** shorten a link and get a QR code; track which channel brings clicks; fix a printed QR code by repointing its link.
- **Before connecting:** a Google account.
- **Reads data, writes data, or both:** both. Reads the user's links and click counts; creates, changes and disables links, and edits the user's bio page, only with the `links:write` permission.
- **Data handling:** the API is our own; no personal health data; no sponsored content.
- **Authentication:** OAuth 2.0, public clients (`token_endpoint_auth_method: none`), PKCE S256. Anthropic's client uses the Client ID Metadata Document at `https://claude.ai/oauth/mcp-oauth-client-metadata`; for OpenAI choose CIMD or Dynamic Client Registration (`/oauth/register`). There is no client secret.
- **Allowed link URIs (Anthropic, optional):** `https://yoy.fyi`.
- **Screenshots (MCP App carousel, PNG at least 1000 px wide, 3 to 5, cropped to the response, prompt supplied separately):**
  1. "Shorten https://example.com/spring-concert and call it Spring concert" showing the card with QR.
  2. "How many clicks did spring-concert get in the last 30 days?" showing the chart.
  3. "Show me my links tagged music" showing the list.

## Test cases

Positive (OpenAI wants exactly five, each with the tools it should trigger):

| # | Prompt | Tools | Expected |
|---|---|---|---|
| 1 | Shorten https://example.com/spring-concert, call it Spring concert, tag it music | `create_link` | A working `https://yoy.fyi/<code>` with the QR card; title and tag set |
| 2 | Make short links for these three pages: (three URLs) | `create_links` | Three results in order, each with its own short URL |
| 3 | How many clicks did my Spring concert link get in the last 30 days, by source? | `list_links`, `get_click_breakdown` or `get_click_timeseries` | A number or chart, honest about zero clicks |
| 4 | Give me the QR code for Spring concert | `list_links`, `get_qr` | The PNG image and the short URL |
| 5 | Send everyone who scans the old poster to https://example.com/new-page instead | `list_links`, `update_link` | The link now redirects to the new page; same short URL |

Negative (OpenAI wants exactly three):

| # | Prompt | Why it must not act | Expected |
|---|---|---|---|
| 1 | Shorten http://192.168.1.1/admin | Private addresses are refused | `target_rejected` explained, no link created |
| 2 | Delete my account and all my data | No tool deletes accounts | Says it cannot, points to the contact address |
| 3 | What's the weather in Lviv? | Unrelated to yoy.fyi | Does not call any yoy.fyi tool |

## Order

1. Merge this PR and create the reviewer account.
2. Anthropic: add `https://yoy.fyi/mcp` as a custom connector in claude.ai, call every tool once (the portal asks you to confirm), then submit through the portal.
3. OpenAI: after the Anthropic one, since its token needs a deploy.
4. Both reviews are ongoing: keep the reviewer account working, and answer reviewer feedback in the portal.
