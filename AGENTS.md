# AAYSSA Membership Portal Agent Notes

Keep this file current. Any future change that alters the tech stack, authentication flow, environment variables, data model, API behavior, portal features, embeds, integrations, deployment behavior, or operational scripts should update this file in the same commit.

## Project

Atlanta Ayyappa Seva Sangam (AAYSSA) Membership Portal.

Public website:
`https://atlantaayyappasevasangam.org`

Member portal:
`https://portal.atlantaayyappasevasangam.org`

Public member login:
`https://portal.atlantaayyappasevasangam.org/login-embed.html`

Public feedback form:
`https://portal.atlantaayyappasevasangam.org/feedback.html`

Public Home Pooja calendar:
`https://portal.atlantaayyappasevasangam.org/home-pooja-calendar.html`

## Tech Stack

- Hosting/API: Vercel serverless functions.
- Runtime: Node.js serverless API routes under `api/`.
- Frontend: static HTML/CSS/JavaScript in `public/index.html`.
- Public embeds:
  - `public/login-embed.html`
  - `public/register-embed.html`
  - `public/maaladharan-register-embed.html`
- Authentication: Supabase email OTP/passcode.
- Membership database: Baserow.
- Donation data: Zeffy API.
- Transactional email: Resend REST API. All recipient-facing Resend messages copy `aayssa.official@gmail.com`; messages already addressed directly to that mailbox do not duplicate it in CC.
- Secrets: Vercel environment variables and local `.env.local`.

Do not expose server-side tokens in browser code.

## Important Environment Variables

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `BASEROW_URL`
- `BASEROW_TOKEN`
- `BASEROW_TABLE_ID`
- `BASEROW_SPOUSE_EMAIL_FIELD_ID` (optional; accepts the numeric Baserow field ID or `field_<id>`. When omitted, the API discovers a member-table field named `Spouse Email Address`, `Spouse Email`, `Secondary Email Address`, or `Secondary Email`.)
- `BASEROW_VOLUNTEERS_TABLE_ID`
- `BASEROW_MAALADHARAN_TABLE_ID` (defaults to `1210688`)
- `BASEROW_HOME_POOJA_TABLE_ID` (defaults to `1240702`)
- `BASEROW_RSVP_TABLE_ID` (defaults to `1264849`)
- `BASEROW_FEEDBACK_TABLE_ID` (defaults to `1262224`)
- `HOME_POOJA_PUBLIC_ENABLED` is a legacy public-API gate and should remain unset/false because no standalone Home Pooja page is planned.
- `ZEFFY_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL` (verified Resend sender; `RESEND_FROM`, `EMAIL_FROM`, and `FROM_EMAIL` are accepted as fallbacks)
- `RESEND_REPLY_TO_EMAIL` (optional)
- `CRON_SECRET` (required to authorize the weekly feedback digest invocation; use a random value of at least 16 characters)

`.env.local` is ignored by Git. Never commit secrets.

## Baserow Tables

Members table:
- Name: `AAYSSA_Members`
- Table ID: `1142367`
- Includes an optional `Spouse Email Address` email/text field used as a secondary login identifier for the same household membership.
- Primary and spouse email addresses must be unique across all member rows and cannot be identical within one row.

Volunteer table:
- Name: `AAYSSA_Volunteers`
- Table ID: `1179938`

Maaladharan registration table:
- Name: `AAYSSA_Maaladharan_Registrations`
- Table ID: `1210688`
- One row per registered participant.
- The API resolves Baserow fields by name.
- Member-portal submissions derive the family link and email from the authenticated session.
- Public submissions require a Supabase email passcode, store the verified normalized email, and link the family automatically when that email matches a member.
- An authenticated member lookup claims current-season public registrations that have the same verified email and no family link.

Home Pooja booking table:
- Name: `AAYSSA_Pooja_Bookings`
- Table ID: `1240702`
- Stores confirmed bookings and administrator-created blocked dates.
- Public bookings require Supabase email verification; matching members are linked by normalized email.
- New bookings are stored immediately with `Approved` status on a first-come, first-served basis; `Cancelled` and `Blocked` remain available for calendar management.
- Legacy `Submitted` Home Pooja rows are treated as booked so dates claimed before the workflow change remain reserved.
- Approved bookings are exposed on the public calendar with host name, scheduled time, and address; email and phone remain private.

Feedback table:
- Name: `AAYSSA_Feedbacks`
- Table ID: `1262224`
- Fields are resolved by name: `Feedback`, `Category`, `Anonymous`, `Name`, `Email`, `Phone Number`, `May Contact`, `Status`, `Included in Digest`, and `Digest Sent On`.
- Public anonymous submissions discard all contact details server-side.
- New submissions default to `New` and remain excluded from a digest until Resend confirms delivery.

Volunteer records are per person:
- Primary
- Spouse
- Additional Member

Volunteer areas:
- Pooja
- Annadhanam
- Bhajan
- Media
- Decorations

## Authentication Flow

The public login embed uses passcode login:

1. User enters the primary or spouse email in `public/login-embed.html`.
2. Browser calls `POST /api/login`.
3. Supabase sends a one-time email passcode.
4. User enters the passcode.
5. Browser calls `POST /api/verify-login-code`.
6. API verifies the passcode with Supabase.
7. API sets HttpOnly cookies:
   - `aayssa_access`
   - `aayssa_refresh`
8. Browser redirects to the member portal.

If an active portal session already exists, the login embed calls `GET /api/me` with credentials and redirects directly to the portal.

The old Supabase magic-link callback route was removed after switching to passcode login.

## Authorization Rules

- The browser must never supply or be trusted for role, family row ID, or Baserow row identity.
- Authenticated email from Supabase is the source of identity.
- Backend looks up the same member row by the primary normalized email first, then by the optional spouse email.
- A spouse login receives access to the same household record and permissions as the primary member; it does not create a separate membership.
- Board/Admin access is enforced server-side.
- Member-only APIs must scope reads/writes to the authenticated member family.

## API Routes

- `POST /api/register`
  - Creates a Baserow member row.
  - Creates per-person volunteer rows.
  - Sends a best-effort Resend confirmation to the registered email after the member row is created.
  - The confirmation includes the AAYSSA Family WhatsApp group link in its HTML and plain-text versions.
- `POST /api/register?resource=feedback`
  - Public feedback submission endpoint used by `public/feedback.html`.
  - Validates category and feedback, enforces anonymous submissions server-side, and stores optional contact permission.
- `POST /api/register?resource=maaladharan`
  - Public, create-only Maaladharan registration flow.
  - The `request-code` action sends a Supabase email passcode.
  - The `submit` action verifies the passcode before saving.
  - Links an existing member family by normalized verified email without revealing whether a membership matched.
  - Sends the registrant a best-effort confirmation email through Resend after the Baserow row is created.
  - Does not expose public read, edit, or withdrawal operations.

- `GET /api/register?resource=home-pooja`
  - Public read-only endpoint used by the standalone Home Pooja calendar.
  - Exposes availability and booked/blocked state. Public booked dates include host name, scheduled time, and address, but never email address or phone number.
  - Does not require `HOME_POOJA_PUBLIC_ENABLED`; that flag continues to gate public booking submissions only.

- `POST /api/register?resource=home-pooja`
  - Legacy disabled public booking flow using `request-code` and `submit` actions; no standalone frontend consumes it.
  - Verifies the requester email with Supabase before immediately booking an available date.
  - Sends a best-effort Resend confirmation containing the booked date, scheduled time, address, status, optional requester note, and the shared Home Pooja checklist link.
  - Links the family automatically when the verified email matches a member.
  - Returns 404 unless `HOME_POOJA_PUBLIC_ENABLED=true`.

- `POST /api/register?resource=rsvp`
  - Public RSVP submission for an active Home Pooja booking or AAYSSA event.
  - Validates that the referenced booking row is still active, then stores the attendee response in `AAYSSA_RSVP` (table `1264849` by default).
  - Sends a best-effort Resend confirmation to the attendee after the RSVP is saved.
  - Supports email-code verified editing through `request-edit-code`, `verify-edit-code`, and `update` actions. The verified Supabase access token authorizes the update, so no additional Baserow fields are required.
  - Prevents a new duplicate for the same booking and email. Aggregate counts, reminders, and host summaries also keep only the newest existing response for each booking/email pair.

- `GET /api/admin-stats?resource=rsvp-reminders`
  - `CRON_SECRET`-protected daily Vercel cron endpoint.
  - Sends a reminder to Attending and Maybe RSVP responses one day before the linked active Home Pooja booking. Resend idempotency keys prevent duplicate reminder delivery when the cron retries.
  - Sends each host a preliminary attendee summary two calendar days before the pooja and a final summary on the morning of the pooja, with `aayssa.official@gmail.com` copied. Summaries separate Attending and Maybe household/adult/kid totals and include attendee names and notes.
  - Sends equivalent preliminary and final AAYSSA event summaries to `aayssa.official@gmail.com`.

- `GET /api/my-volunteers?resource=rsvp`
  - Authenticated member endpoint returning RSVP identities and contact details only for Home Pooja bookings linked to that member's family.

- `GET /api/admin-members?resource=rsvp`
  - Board/Admin-only view of all current Home Pooja and AAYSSA event RSVP groups, summaries, identities, contact details, and notes.

- `POST /api/login`
  - Starts Supabase email OTP/passcode login.

- `POST /api/verify-login-code`
  - Verifies passcode.
  - Sets portal session cookies.

- `GET /api/me`
  - Returns authenticated member profile.
  - Supports credentialed CORS for public login session detection.

- `POST /api/logout`
  - Clears portal session cookies.

- `GET /api/my-volunteers`
  - Returns active volunteer rows for the authenticated member family.

- `POST /api/update-volunteers`
  - Updates primary/spouse/additional volunteer entries.
  - Deactivates removed additional members.

- `POST /api/update-profile`
  - Updates family/contact/preferences fields for the authenticated member.

- `GET /api/my-donations`
  - Returns current-year Zeffy donation summary for the authenticated member email.

- `GET /api/my-volunteers?resource=maaladharan`
  - Returns the authenticated family's 2026-27 Maaladharan registrations.

- `POST /api/my-volunteers?resource=maaladharan`
  - Creates a family-scoped participant registration.
  - Sends the authenticated member a best-effort confirmation email through Resend after the Baserow row is created.
  - Rejects duplicate participant names for the active season.
  - Uses the server-controlled season window of October 25 through December 4, 2026.

- `PATCH /api/my-volunteers?resource=maaladharan`
  - Updates the Maaladharan date, Padi count, Irumudi offering location, and optional member note.
  - Supports withdrawing an active registration by setting its status to `Cancelled`.
  - Verifies that the requested registration belongs to the authenticated family.
  - Shares the existing `my-volunteers` function to keep the Vercel Hobby route count stable.

- `GET /api/my-volunteers?resource=home-pooja`
  - Returns the authenticated family's bookings plus the authenticated booking calendar.
  - For authenticated Board/Admin preview users, booked calendar dates include the requester's name, scheduled time, and address.
  - Claims unlinked public bookings whose verified email matches the signed-in member.

- `POST /api/my-volunteers?resource=home-pooja`
  - Immediately creates a family-linked Home Pooja booking with `Approved` status.
  - Validates the date against server-controlled availability and blocked dates.
  - Sends the authenticated member a best-effort Resend booking confirmation with the shared Home Pooja checklist link after the booking is saved.

- `GET /api/admin-stats`
  - Board/Admin only.
  - Returns membership counts, volunteer stats, registration trend, Zeffy donation total, and monthly donation trend.

- `GET /api/admin-stats?resource=feedback-digest`
  - Secured by Vercel `CRON_SECRET` authorization.
  - Sends all feedback not previously included in a digest to `aayssa.official@gmail.com` through Resend.
  - Marks rows as included only after the email is accepted by Resend.
  - Scheduled in `vercel.json` for Fridays at 13:00 UTC (8 AM Eastern Standard Time / 9 AM Eastern Daylight Time).

- `GET /api/admin-members`
  - Board/Admin only.
  - Returns paginated member directory.
  - Supports search and sorting by primary name or registered date.

- `GET /api/admin-members?resource=home-pooja`
  - Board/Admin-only list of Home Pooja bookings, blocks, and calendar state.
  - The administrative calendar includes each booked requester's name, scheduled time, and address.

- `POST /api/admin-members?resource=home-pooja`
  - Board/Admin-only creation of a blocked calendar date with a reason; any valid date can be blocked for a special AAYSSA event even when Home Pooja is not normally offered that day.

- `PATCH /api/admin-members?resource=home-pooja`
  - Board/Admin-only removal of custom and built-in date blocks.
  - Board/Admin can edit a confirmed booking's scheduled time and Pooja address; the editor and edit date are recorded in the existing approval audit fields.
  - Board/Admin can edit the date and event name for custom or built-in blocked events; built-in edits persist by cancelling the default block and creating the edited block row.
  - Supports unblocking a date directly from the admin calendar, including built-in event and preparation blocks; built-in overrides are persisted as cancelled block rows.

## Portal Features

Member portal (`public/index.html`) includes:

- A desktop header matching the public AAYSSA website, with its hosted transparent logo, complete navigation labels, and responsive mobile menu.
  - Member, Events, and Sevas are direct links without dropdown indicators and currently point to the public home page because standalone destination routes are unavailable.
- Top member header with welcome text, role badge, and logout button.
- A responsive sidebar shows one major section at a time: Overview, Maaladharan, Home Pooja where available, Donations, Seva & Volunteering, and Board/Admin Administration. Mobile uses a compact selector, and the single-line Feedback & Suggestions link opens the standalone form in a new tab.
- After authentication, shows a “Stay connected” link to the AAYSSA Family WhatsApp group; the public login/sign-up embed does not show WhatsApp links.
- An unauthenticated portal visit links directly to the deployed portal login form; do not use the removed public `/member-login` route.
- Family details card with edit controls.
- Contact information card with edit controls.
- Seva & Volunteering card with edit controls.
- Communication preferences card with edit controls.
- Native 2026-27 Maaladharan registration card:
  - Displays the Mandalam start and closing dates.
  - Registers primary, spouse, or additional family members individually.
  - Captures age, phone, Maaladharan date, Padi count, Irumudi offering location, and optional notes.
  - Both member and standalone forms mark every mandatory field with an asterisk; notes remain optional.
  - Irumudi offering choices are `Tampa Temple` (December 5, 2026; shared bus expense approximately $340/person), `AAYSSA Temple` (December 12, 2026; estimated cost approximately $60/person), and `Other Temple or Self`.
  - The form labels Padi as “Padi Count Completed”; the Baserow value and displayed choice are both `1`.
  - Padi guidance explicitly tells registrants not to include the current year's Padi in the completed count; this wording is shared by member create/edit forms and the public embed.
  - Padi choices run from `0 (Kanni Swamy)` through `39`, followed by `40+`; `18 (Guru Swamy)` retains its existing label.
  - Selecting `0 (Kanni Swamy)` automatically marks the participant as taking Deeksha for the first time.
  - Displays existing family registrations and prevents duplicates.
  - The Registered Swamies card heading shows the total number of active family registrations.
  - Shows the Maaladharan WhatsApp group link inside Registered Swamies whenever the family has an active Swamy registration.
- Home Pooja booking card:
  - Spans the full member-portal content width instead of sharing a two-column row with another card.
  - Shows the shared availability calendar and the family's confirmed bookings.
  - Booked dates show the requester's name, scheduled time, and address; the standalone public calendar does not receive these private fields.
  - Labels blocked dates as `AAYSSA Event` in the member-facing calendar; administrative views continue to use `Blocked` terminology.
  - Presents availability in a responsive month-at-a-time calendar with Previous/Next navigation and privacy-safe Available, Booked, and Blocked states.
  - Opens to all authenticated members automatically on October 14, 2026 at 6:00 PM Eastern (`2026-10-14T22:00:00Z`); Board/Admin retain preview access before launch, and the API enforces the same timestamp.
  - At launch the `Board Preview` and `Not Public Yet` labels are removed automatically.
  - Allows an authenticated family to book an available date immediately on a first-come, first-served basis.
  - Marks the date booked as soon as the booking is saved; no administrator approval is required.
  - Confirmed bookings include a web invitation builder. The host can edit the displayed host name and address while the booked date, morning/evening schedule, invitation wording, and AAYSSA styling remain fixed. Home Pooja invitations show the matching fixed morning or evening Pooja Details program; invitations can be saved as an image or PDF.
- During preview, appears only for authenticated Board/Admin users and the member API enforces the same role restriction.
  - Preview loading is isolated from the core member profile so an optional booking or dashboard failure cannot prevent portal access.
  - Calendar-only dates are formatted as local calendar dates to avoid UTC date shifts in the browser.
- Donations & Tax Receipts card:
  - Current-year Zeffy donation total.
  - Payment list.
  - Download tax receipt links when available.
  - Donate button linking to `https://atlantaayyappasevasangam.org/donations`.

Board/Admin dashboard includes:

- A secondary tab bar organizes the administration area into Overview, Maaladharan, Home Pooja & RSVP, and Member Directory panels so only one administrative category is visible at a time.
- Registered families.
- Total people.
- Adults.
- Kids.
- Donations this year.
- Seva area counts.
- Volunteer participation, including total volunteers.
- Monthly donations chart from Zeffy.
- Registration trends chart.
- The Maaladharan tab presents four full-width cards in this order: Overall Maaladharan Status, Registered Swamies, Swamies by Padi Count, and Swamies by Maaladharan Date.
- Overall Maaladharan Status shows total registrations, Primary/Spouse/Additional Member, Kanni/Non-Kanni, Tampa Yatra selected/not selected, and adult/under-18 totals.
- Monthly donations and registration trends display the latest six months side by side without a forced horizontal scroll.
- Registered Swamies is a sortable table showing name, Padi count, age, and Maaladharan date; its heading shows the total number of registered Swamies.
- Member directory with search, pagination, and sorting.
- Board/Admin Home Pooja booking review without an approval step.
- RSVP Responses, Home Pooja Bookings, and Administration Blocks are collapsed dropdown panels in the administration dashboard, with item counts in their headings. RSVP responses are grouped into event cards with compact Attending/Maybe totals and a responsive attendee table.
- Home Pooja Bookings provides inline Board/Admin editing for scheduled time and Pooja address. Confirmed hosts and Board/Admin users can create editable Home Pooja invitations; Board/Admin users can create the equivalent AAYSSA Event invitation from any Administration Block, with editable organizer and address fields. Invitations use the AAYSSA, background-isolated Ayyappa Swamy, high-clarity Ganesha, and high-clarity Murugan artwork, offer Black, Maroon, Royal Blue, Temple Purple, and Emerald gold-accented backgrounds, include the AAYSSA Pooja & Bhajan footer and website, and can be saved as a PNG image or through the browser's PDF save flow.
- Board/Admin can cancel an active Home Pooja booking after confirmation. The row remains for audit history with `Cancelled` status, while the date immediately returns to availability when its normal or custom availability rule permits.
- Cancelling a Home Pooja booking sends the host a best-effort Resend cancellation email. Successful delivery is recorded in the existing Admin Notes field, and cancelled rows show that an email was already sent next to the Board/Admin send/resend action. Bookings cancelled before this tracking was deployed remain eligible for sending.
- Board/Admin date blocking with a required reason, plus calendar-level Unblock controls for custom and built-in blocked dates.
- Board/Admin availability management can add any Home Pooja date and scheduled time. Each available calendar day exposes Edit, Remove, and Block controls directly in the calendar; overrides use existing booking-table fields and do not require another Baserow column.
- Automatically generated Friday/Saturday/Sunday availability ends after December 12, 2026. Later dates are empty by default and appear only when Board/Admin adds availability; removed availability also renders as an ordinary empty calendar day rather than an `Unavailable` state.
- Administration Blocks provides Edit controls for changing a blocked event's date and event name.
- December 4, 2026 is a built-in `Mandalam Closing` block, and blocked special-event dates appear in the calendar even when the day is outside normal Home Pooja availability.
- The Administration Blocks list is derived from calendar state so it includes every active custom and built-in block, with concise event labels.

## Public Registration Embed

`public/register-embed.html` is intended for GoDaddy and is also served from the portal domain. The registration API CORS allowlist includes both public-site hostnames and `https://portal.atlantaayyappasevasangam.org`.

Registration supports:

- Primary member information.
- Spouse information.
- Primary volunteering preferences.
- Spouse volunteering preferences.
- Additional family member volunteering preferences.
- Email/text opt-in.

It posts to:
`https://aayssa-membership-api.vercel.app/api/register`

## GoDaddy Member Portal Embed

`public/member-portal-godaddy-embed.html` is a copy-ready GoDaddy Custom HTML block that embeds the full portal from `https://portal.atlantaayyappasevasangam.org/?embed=1`. Embedded mode hides the portal's duplicate website header, reduces outer spacing, and sends safe height-only `postMessage` updates so the parent iframe can resize without persistent internal scrolling. The parent snippet accepts messages only from the portal origin. When no session exists, embedded mode redirects within the iframe to `login-embed.html?portalEmbed=1`; successful authentication then returns to `/?embed=1` inside the same iframe rather than navigating the GoDaddy page away. Invitation PNG exports in embedded mode reserve a new tab during the user's click and transfer the rendered PNG as an in-memory data image with a manual Download button, avoiding Safari's blocking of delayed downloads and iframe-owned blob URLs. All destructive or consequential portal actions use two-click inline confirmations instead of native browser dialogs so they remain functional when modal dialogs are restricted inside an iframe. Covered actions include Maaladharan withdrawal, Home Pooja availability removal, booking cancellation, cancellation-email delivery, and blocked-date unblocking. The standalone portal remains unchanged when `embed=1` is absent. Test sign-in and session persistence in Safari, Chrome, and mobile browsers before replacing the existing Member Login page.

## Public Login Embed

`public/login-embed.html` is intended for GoDaddy.

- Its Member Login banner matches the gradient header treatment used by the member registration embed.
- External WhatsApp links use `target="_top"` so Safari can leave the cross-origin GoDaddy iframe without triggering Cross-Origin-Opener-Policy errors.

It uses:
`https://portal.atlantaayyappasevasangam.org/api`

When this file changes, copy the updated embed into GoDaddy for the public login page.

## Public Feedback Form

`public/feedback.html` is a standalone hosted form. It supports anonymous submission by default, optional name/email/phone, conditional permission to contact, required category selection, spam honeypot protection, and a confirmation screen.

## Public Home Pooja Calendar

`public/home-pooja-calendar.html` is a full-page calendar for non-members. It supports month navigation and displays each booked/event date in a compact host name, scheduled time, address, and aggregate Attending/Maybe guest-count order; phone numbers, email addresses, and RSVP identities remain private. Home Pooja bookings and AAYSSA event dates use accessible compact + (New RSVP), pencil (Edit RSVP), and share icon shortcuts with text labels available to assistive technology and tooltips; Share RSVP copies the event-specific link directly and confirms on the button, shared `?rsvp=<reference>&date=<date>` links navigate to the event month and open its RSVP form automatically, using the host name in Home Pooja dialog titles and an AAYSSA Event title for blocked events. Confirmed hosts can share the same event-specific link from their member portal booking. Editing requires email-code verification. Preparation-only blocked dates do not accept RSVPs.

## Public Maaladharan Registration Embed

`public/maaladharan-register-embed.html` is intended for GoDaddy.

- Members and non-members can submit a 2026-27 Maaladharan registration.
- The visitor must verify the submitted email with a Supabase passcode.
- Existing members are linked by normalized email; non-members remain unlinked until a membership with the same email signs in.
- The public flow is create-only. Editing and withdrawal require member-portal authentication.
- Successful registrations receive a Resend confirmation email containing the registration details and WhatsApp group link; delivery failure does not roll back the saved registration.
- The form reveals a direct link to join the Maaladharan WhatsApp group only after a successful registration.
- Its WhatsApp link uses `target="_top"` to escape the GoDaddy iframe safely in Safari.
- When this file changes, copy the updated embed into GoDaddy for the public Maaladharan registration page.

## Zeffy Integration

Zeffy data is read server-side only with `ZEFFY_API_KEY`.

Member donation lookup:
- Uses authenticated Supabase email.
- Looks up matching Zeffy contact(s).
- Reads current-year successful payments.
- Returns totals and receipt URLs only for that member.

Admin dashboard donation summary:
- Board/Admin only.
- Reads current-year successful organization payments.
- Returns aggregate totals and monthly buckets.
- Does not expose donor details.

## Operational Notes

- Vercel Hobby deployments were sensitive to API route count. Keep the route count in mind before adding new API files.
- Current API routes are all actual endpoints. Shared helpers live under `api/_lib/`.
- Before pushing:
  - Run syntax checks for changed API files.
  - Keep route count stable when possible.
  - Verify `.env.local` and `.vercel/` remain ignored.
- `scripts/migrate-volunteers.cjs` supports:
  - `npm run migrate:volunteers:dry-run`
  - `npm run migrate:volunteers:apply`

## Weekly Free-Tier Capacity Check

The application intentionally uses the free tiers of Vercel, Baserow Cloud, Resend, and Supabase. At the beginning of an AAYSSA work session, if seven or more days have elapsed since the date below, perform a read-only capacity check and alert the user about anything needing attention. Do not print or expose credentials while checking usage.

Last capacity check: `2026-10-17`

Baseline recorded on that date:
- Baserow: 314 total rows across the six application tables, 10.5% of the 3,000-row workspace allowance, leaving 2,686 rows.
- Vercel: 12 API routes and two cron jobs. The daily and weekly schedules comply with the Hobby once-per-day minimum interval.
- Resend: account usage could not be queried from the local checkout because no local API key was available. Check the Resend Usage page or read-only Usage API when credentials are available.
- Supabase: current dashboard usage could not be queried from the local checkout. Verify the Usage page and confirm that production OTP delivery uses custom SMTP rather than the restricted built-in SMTP service.
- Vercel Hobby is restricted to personal/non-commercial use. Periodically confirm with Vercel that the nonprofit portal remains eligible.

Weekly checks and alert thresholds:
- Baserow: total every accessible table; alert at 2,100 rows (70%), escalate at 2,400 (80%), and do not approach 2,700 without an archive, paid plan, or self-hosting plan.
- Resend: daily and monthly transactional usage; alert at 70 emails/day or 2,100/month and escalate at 90/day or 2,700/month.
- Supabase: MAU, database size, egress, project-pause state, Auth rate-limit errors, and custom SMTP status. Alert on any production use of built-in SMTP, usage above 70%, or project-pause warning.
- Vercel: function invocations, execution, transfer, deployment failures, and cron health. Alert above 70% of any included allowance, on missed cron runs, or if Hobby-plan eligibility is uncertain.
- The daily `admin-stats?resource=capacity-monitor` cron runs at 14:00 UTC without adding an API route. It measures Baserow workspace rows and Resend daily/monthly email usage, verifies Supabase Auth reachability, and emails `CAPACITY_ALERT_EMAIL` (default `aayssa.official@gmail.com`) when a measured limit reaches the warning or critical threshold. Warning alerts are deduplicated monthly and critical alerts daily through Resend idempotency keys.
- Board/Admin users have a Capacity Monitor tab under Administration. It loads the same safe snapshot through authenticated `GET /api/admin-stats?resource=capacity-dashboard`, displays measured usage and thresholds, identifies dashboard-only checks, and supports a manual refresh without sending an alert email.
- Optional monitor settings are `CAPACITY_ALERT_EMAIL`, `CAPACITY_WARNING_PERCENT` (default 70), `CAPACITY_CRITICAL_PERCENT` (default 90), and `BASEROW_FREE_ROW_LIMIT` (default 3000). `CRON_SECRET`, Resend, Baserow, and Supabase variables must remain configured for the monitor.
- Vercel Hobby capacity percentages and Supabase quota percentages remain dashboard-only; the monitor reports this limitation and relies on their provider alerts rather than guessing values.
- Update the date and baseline figures in this section after each completed check. If dashboard-only figures cannot be accessed, tell the user exactly which dashboard values remain unverified.

## Conversation Recovery

If Xcode loses or does not display its conversation history, the user has authorized future agents to recover the missing AAYSSA context from the local Codex session transcripts before continuing work.

- Xcode's Codex data root on this Mac is `/Users/sid/Library/Developer/Xcode/CodingAssistant/codex`.
- Session transcripts are JSONL files under `/Users/sid/Library/Developer/Xcode/CodingAssistant/codex/sessions/YYYY/MM/DD/`.
- The main historical AAYSSA implementation conversation begins at `sessions/2026/09/20/rollout-2026-09-20T22-58-58-01a0c1e7-087a-7eb0-b758-50a8e2c56bd1.jsonl`.
- Later AAYSSA conversations can be identified by their `session_meta.payload.cwd`, project structure, or user messages mentioning `aayssa-membership-api`.
- Extract and summarize relevant `user_message` and final `agent_message` events. Do not repeat raw tool output, environment values, access tokens, or unrelated project conversations.
- Treat the current code, Git history, and this `AGENTS.md` as authoritative when an older transcript conflicts with the implemented state.

## Maintenance Requirement

For every future feature or bug fix, update this `AGENTS.md` if the change affects architecture, auth, routes, data fields, integrations, deployment assumptions, public embeds, user-facing portal capabilities, or conversation-recovery instructions. Treat this file as the quick-start reference for future development sessions.
