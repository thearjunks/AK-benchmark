# AK Website Benchmark

STC-branded React dashboard for comparing Mobile and Web Google PageSpeed scores across a standard competitor list.

## Features

- Six pre-saved standard websites displayed three per comparison section
- Mobile and Web Performance, Accessibility, Best Practices, and SEO scores
- One complete multi-site score check with strict completeness validation
- Daily scheduled run at 3:00 PM Asia/Kuwait
- Saved email recipients and clean three-site-section HTML reports
- Email delivery only after every required score is available
- Excel-compatible CSV and printable PDF exports
- Secure login, STC access requests, Admin approval, and role-based permissions

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and add the required credentials.
4. Run `npm run dev -- --port 56436 --strictPort`.
5. Open `http://localhost:56436/`.

## Environment variables

- `GOOGLE_PAGESPEED_API_KEY` — Google PageSpeed Insights API key
- `SMTP_USER` — Gmail sender address
- `SMTP_APP_PASSWORD` — Gmail App Password
- `EMAIL_RECIPIENTS` — optional comma-separated production recipient list (kept out of Git)
- `REPORT_TIME` — optional daily/monthly report time in Kuwait, for example `15:00`
- `AUTO_SEND_AFTER_CHECK` — send the completed benchmark report after a successful manual scan (`true` by default)
- `ADMIN_EMAIL` — Admin account and access-request notification address; falls back to `SMTP_USER`
- `ADMIN_USERNAME` — initial Admin username (`admin` when omitted)
- `ADMIN_PASSWORD` — required strong password used to create the first Admin account
- `PUBLIC_APP_URL` — public application origin used in password-setup invitation links
- `GITHUB_ACTIONS_TOKEN` — fine-grained GitHub token with Actions write access, used only to start the Lighthouse worker
- `LIGHTHOUSE_CALLBACK_TOKEN` — long random secret shared with the GitHub `LIGHTHOUSE_CALLBACK_TOKEN` repository secret
- `LIGHTHOUSE_WORKER_REPOSITORY` — worker repository, defaults to `thearjunks/AK-benchmark`
- `LIGHTHOUSE_WORKER_REF` — workflow branch, defaults to `main`
- `ACCESS_EMAIL_NOTIFICATIONS` — access request and invitation email delivery (`true` by default)
- `STATIC_SNAPSHOT_EXPORT` — keep `false` for a protected production application
- `BENCHMARK_DATA_DIR` — optional persistent directory for runtime state; production defaults to `$HOME/.webpulse-benchmark`

Credentials, generated reports, runtime scan state, dependencies, and production build output are excluded from Git.

## Hosting requirement

The scheduled audit and email functions run on the Node server. Static GitHub Pages hosting is not sufficient. Deploy the repository to an always-running Node host and configure the three environment variables in that host's secure settings.

For Hostinger Web Apps select the **Other** framework preset and use:

- Build command: `npm run build`
- Output directory: `dist`
- Entry file: `server.mjs`
- Node.js version: 20 or newer

Add the PageSpeed, SMTP, and Admin variables above in the Web App environment-variable settings. The host-provided `PORT` value is used automatically. Keep `benchmark-auth.json` in the persistent runtime directory so users and access requests survive deployments.

For the Zain fallback, add `LIGHTHOUSE_CALLBACK_TOKEN` as a GitHub Actions repository secret, then add the same value plus `GITHUB_ACTIONS_TOKEN` to Hostinger. The workflow runs Chrome outside Hostinger and returns a signed result. Mobile and Desktop are retried independently, and the server combines successful PageSpeed and Lighthouse device results. Same-domain redirects are validated; Zain's exact `/en/shop?error=login_required` audit redirect is accepted because automated Chrome reports `/en/shop` as the displayed page and returns all four categories.

## Access management workflow

1. The first Admin signs in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. A new user selects **Request Access** and submits their username, mobile number, department, and STC email ID.
3. The Admin receives an email notification and sees the request under **Access management**.
4. Approval creates an invited account and emails a one-time password setup link valid for 48 hours.
5. The Admin can assign User/Admin role, enable individual dashboard sections, allow email delivery, allow downloads, disable accounts, or resend an invitation.

Authentication and permission checks are enforced by the Node backend. Hiding a menu or button in the React interface is not treated as the security boundary.
