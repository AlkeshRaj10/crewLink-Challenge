# CrewLink

## Backend setup

The backend uses Express, TypeScript, and PostgreSQL. PostgreSQL 13 or later is required for `gen_random_uuid()`.

1. Create a PostgreSQL database and user (or use an existing local development database).
2. From the `backend` directory, copy `.env.example` to `.env` and set `DATABASE_URL` to the connection string for that database. `PORT` defaults to `4000`.
   Set `CORS_ORIGIN` to the frontend origin (default `http://localhost:3000`; comma-separated origins are supported).
   Set `JWT_SECRET` to a unique cryptographically random secret of at least 32 bytes; the API will not start without it. To enable AI draft suggestions, set `AI_API_KEY` for an OpenAI-compatible chat-completions API; `AI_API_URL` and `AI_MODEL` default to the values in `.env.example`. Never commit API credentials. With no AI key configured, the AI drafting endpoint returns `503` while manual draft creation remains available.
3. Install dependencies with `npm install`.
4. Apply the schema with `npm run db:migrate`.
5. Seed the assessment data with `npm run db:seed`. It is safe to rerun.
6. Start the development server with `npm run dev`. Check `http://localhost:4000/health` for database connectivity.
7. Run `npm run build` to type-check and compile; run `npm start` to start the compiled server.

Migrations are tracked in `schema_migrations` and can safely be run again. Do not commit `.env` or use development credentials outside local development.

To run focused PostgreSQL constraint tests, set `TEST_DATABASE_URL` to a disposable database where the test user can create and drop schemas, then run `npm run test:db`. The tests create and remove an isolated schema.

The authentication endpoints are `POST /auth/login` with `{ "email": "...", "password": "..." }` (returns a one-hour bearer token) and `GET /auth/me` with `Authorization: Bearer <token>` (returns the authenticated user's local roles). Local leaders can create drafts with `POST /locals/:localId/announcements` and send with `POST /locals/:localId/announcements/:announcementId/send`, using `Authorization: Bearer <token>`. Send requests require an `Idempotency-Key` header and accept an optional `{ "classificationId": "<uuid>" }` body. The leader's explicit Send action approves the draft. A successful send returns `202 Accepted`; recipient snapshots and outbox jobs are committed before that response, and delivery is handled asynchronously by the mock worker described below.

Members can list their sent callouts with `GET /locals/:localId/member/announcements`, read a recipient callout with `GET /locals/:localId/member/announcements/:announcementId`, and acknowledge an acknowledgement-required callout with `POST /locals/:localId/member/announcements/:announcementId/acknowledge`. All require `Authorization: Bearer <token>`; list/read/acknowledgement queries additionally require a recipient row linked to that member's local membership. Reading and acknowledging save their first timestamps; repeated reads and acknowledgements preserve those timestamps.

Run the mock push outbox worker in a separate terminal with `npm run worker` after migrations and seeding. Workers claim jobs using `FOR UPDATE SKIP LOCKED`, lease them, recover expired leases, and retry transient failures with bounded exponential backoff. Each outcome is recorded in `delivery_attempts`; recipient push state becomes `delivered` only after a successful provider response, and permanent or exhausted failures become `failed`. The mock provider persists successful idempotency keys in PostgreSQL so a worker restart reuses the same delivery rather than creating a second mock delivery. A real external provider still needs to honor the persisted idempotency key to protect against duplicate external deliveries.

Local leaders can request a suggested callout draft with `POST /locals/:localId/announcements/ai-draft` and a JSON body such as `{ "notes": "messy meeting notes..." }`. It returns a saved `draft` announcement with a suggested title, body, and push preview (at most 120 characters). The AI only drafts text: it does not select recipients, approve, or send. Review and edit the stored draft, then use the existing send endpoint to explicitly approve and start delivery. Missing AI credentials return `503`; provider failures or invalid model output return `502` without creating an announcement.

Run `npm run test:seed` against a disposable PostgreSQL database to verify repeated seeding does not duplicate data. Run `npm run test:announcements`, `npm run test:ai`, `npm run test:members`, and `npm run test:worker` with `TEST_DATABASE_URL` set to a disposable PostgreSQL database to test the APIs and worker behavior.

## Leadership frontend

The Next.js + TypeScript leadership dashboard uses the existing Express API. First start PostgreSQL and the backend using the setup above. Then, in a second terminal:

```powershell
cd frontend
Copy-Item .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000` and sign in with a leadership account from `TEST ACCOUNTS`. Set `NEXT_PUBLIC_API_BASE_URL` in `frontend/.env.local` if the API is not at `http://localhost:4000`; set the matching API `CORS_ORIGIN` to the frontend origin. The dashboard loads only local roles returned by `/auth/me`; the API independently verifies local leadership authorization on every request. Leaders can create or edit drafts, generate editable AI suggestions, select an optional classification audience, explicitly send, and monitor sent/delivered/read/acknowledged totals. Counts refresh every four seconds while the workspace is open.

## Member inbox and push delivery

Members sign in with their member account to see approved announcements addressed to them in the inbox. Messages appear there as soon as the leader sends them; push delivery is a separate asynchronous step. Keep `npm run worker` running in the backend directory to process the outbox. The included provider simulates push delivery for development and does not send actual device notifications, email, or SMS.

## TEST ACCOUNTS

These credentials are for local assessment only. The seed contains synthetic accounts; never reuse these passwords or seed credentials in production.

```json
{
  "locals": {
    "Local 27": {
      "leadership": {
        "email": "local27.leader@crewlink.test",
        "password": "Leader27Test!"
      },
      "member": {
        "email": "local27.member@crewlink.test",
        "password": "Member27Test!"
      }
    },
    "Local 99": {
      "leadership": {
        "email": "local99.leader@crewlink.test",
        "password": "Leader99Test!"
      },
      "member": {
        "email": "local99.member@crewlink.test",
        "password": "Member99Test!"
      }
    }
  },
  "existingAnnouncementId": "8ba7dd46-337a-8b47-a640-1c92280321bd",
  "memberIdInOtherLocal": "582f7de5-59bc-8904-a425-2044e64227d2",
  "endpoints": [
    {
      "method": "GET",
      "path": "/health",
      "auth": "none"
    },
    {
      "method": "POST",
      "path": "/auth/login",
      "auth": "none; JSON body with email and password returns a bearer token"
    },
    {
      "method": "GET",
      "path": "/auth/me",
      "auth": "Authorization: Bearer <token>"
    },
    {
      "method": "POST",
      "path": "/locals/:localId/announcements",
      "auth": "Authorization: Bearer <leader token>; JSON title/body"
    },
    {
      "method": "POST",
      "path": "/locals/:localId/announcements/classifications",
      "auth": "Bearer token; user must be a leader in localId"
    },
    {
      "method": "GET",
      "path": "/locals/:localId/announcements",
      "auth": "Bearer token; user must be a leader in localId; returns announcement recipient, delivered, read, and acknowledged counts"
    },
    {
      "method": "GET",
      "path": "/locals/:localId/announcements/:announcementId",
      "auth": "Bearer token; user must be a leader in localId"
    },
    {
      "method": "PUT",
      "path": "/locals/:localId/announcements/:announcementId",
      "auth": "Bearer token; local leader can edit only their own unsent draft"
    },
    {
      "method": "POST",
      "path": "/locals/:localId/announcements/ai-draft",
      "auth": "Bearer token; JSON notes; AI_API_KEY must be configured"
    },
    {
      "method": "POST",
      "path": "/locals/:localId/announcements/:announcementId/send",
      "auth": "Authorization: Bearer <leader token>; Idempotency-Key header; optional JSON classificationId"
    },
    {
      "method": "GET",
      "path": "/locals/:localId/member/announcements",
      "auth": "Authorization: Bearer <member token>"
    },
    {
      "method": "GET",
      "path": "/locals/:localId/member/announcements/:announcementId",
      "auth": "Authorization: Bearer <member token>; must be an announcement recipient"
    },
    {
      "method": "POST",
      "path": "/locals/:localId/member/announcements/:announcementId/acknowledge",
      "auth": "Authorization: Bearer <member token>; must be recipient and acknowledgement must be required"
    }
  ]
}
```

The seed creates 2,000 active members in Local 27 and 200 in Local 99, each spread across four classifications, with one leadership login and one member login per local. The seeded sent announcement has one recipient row per Local 27 member; its outbox jobs are ready for the mock worker.
