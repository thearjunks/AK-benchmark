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

Credentials, generated reports, runtime scan state, dependencies, and production build output are excluded from Git.

## Hosting requirement

The scheduled audit and email functions run on the Node server. Static GitHub Pages hosting is not sufficient. Deploy the repository to an always-running Node host and configure the three environment variables in that host's secure settings.

For Hostinger Web Apps use:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Node.js version: 20 or newer

Add `GOOGLE_PAGESPEED_API_KEY`, `SMTP_USER`, and `SMTP_APP_PASSWORD` in the Web App environment-variable settings. The host-provided `PORT` value is used automatically.
