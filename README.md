# AAYSSA Membership Portal

The membership and community-services portal for the [Atlanta Ayyappa Seva Sangam (AAYSSA)](https://atlantaayyappasevasangam.org).

The application gives AAYSSA families one place to manage membership details, register for programs, volunteer, make donations, reserve Home Pooja dates, and RSVP for community events. Administrators use the same portal to support members and coordinate event operations.

## Live services

- [Member portal](https://portal.atlantaayyappasevasangam.org)
- [Member login](https://portal.atlantaayyappasevasangam.org/login-embed.html)
- [Home Pooja calendar](https://portal.atlantaayyappasevasangam.org/home-pooja-calendar.html)
- [Feedback and suggestions](https://portal.atlantaayyappasevasangam.org/feedback.html)
- [Public website](https://atlantaayyappasevasangam.org)

## Highlights

- Passwordless email-passcode authentication for members and spouses
- Household membership and contact management
- Maaladharan registration
- Home Pooja reservations, invitations, and public calendar
- Event RSVP tracking with adult and kid attendance counts
- Volunteer interests and family volunteer records
- Donation history
- Public feedback collection and administrative reporting
- Responsive member and administrator experiences

## Architecture

This is a lightweight Vercel application:

- **Frontend:** static HTML, CSS, and browser JavaScript in `public/`
- **API:** Node.js serverless functions in `api/`
- **Authentication:** Supabase email OTP
- **Operational data:** Baserow
- **Donations:** Zeffy
- **Transactional email:** Resend
- **Hosting and scheduled jobs:** Vercel

Browser code never receives service credentials. Integrations and authorization checks are handled by server-side API routes.

## Repository layout

```text
api/        Vercel serverless API routes and shared backend modules
public/     Member portal, public forms, calendar, and image assets
scripts/    Operational and data-migration scripts
vercel.json Deployment and scheduled-job configuration
```

## Local development

1. Install the [Vercel CLI](https://vercel.com/docs/cli).
2. Authenticate with `vercel login`.
3. Link this checkout to the existing Vercel project with `vercel link`.
4. Pull the development environment with `vercel env pull .env.local`.
5. Start the local application with `vercel dev`.

Do not commit `.env.local` or place integration tokens in frontend files.

## Deployment

The production project is connected to `aayssa-it/aayssa-membership-api` in Vercel. A push to the configured production branch triggers a Vercel deployment, subject to the project's Git and deployment settings.

Deployment status and logs are available in the Vercel project dashboard.

## Contributing

Keep changes focused and test the affected member or administrator workflow before merging. When a change affects architecture, integrations, environment variables, data behavior, authentication, or deployment, update the repository documentation in the same commit.

## Community

AAYSSA is a volunteer-led nonprofit community organization. Please handle member information carefully and avoid including personal data, credentials, or production records in commits and issue reports.
