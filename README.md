# Hospital Management System

A full-stack hospital management system built as a software engineering project. The app includes staff and patient portals for appointments, patient records, admissions, clinical workflows, laboratory, pharmacy, billing, reports, and system administration.

## Stack

- React 18, Vite, and Tailwind CSS
- Node.js 20+ and Express 5
- PostgreSQL 16 with Knex migrations
- Zod validation, bcrypt authentication, and AES-256-GCM encryption for sensitive patient fields

## Run locally

1. Install Node.js 20 or newer and PostgreSQL.
2. Copy `server/.env.example` to `.env` in the repository root and set `DATABASE_URL` to a local development database.
3. From the repository root, run `npm ci`, `npm run migrate`, and `npm run dev:server`.
4. In another terminal, run `npm run dev:client` and open `http://localhost:5173`.

Demo fixtures are for disposable local or test databases only. The seed command refuses to run in production.

## Deploy on Render

The root `render.yaml` defines a single web service that builds and serves both the React app and API, plus a PostgreSQL database. On first startup it creates an administrator using the `BOOTSTRAP_ADMIN_*` values configured in Render. Remove those values from the service after the first successful start.

The service also requires Cloudflare R2 credentials for uploaded lab reports and backups. Set the R2 account ID, access key, secret key, bucket names, and endpoint through Render’s secret prompts. Never commit these values or any `.env` file.

The Blueprint currently uses Render’s free web and database plans for a project preview. Render documents that free web services sleep when idle and free PostgreSQL databases expire after 30 days, so choose paid plans before relying on this deployment or storing real patient data.
