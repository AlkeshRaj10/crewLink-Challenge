# CrewLink

## Backend setup

The backend uses Express, TypeScript, and PostgreSQL. PostgreSQL 13 or later is required for `gen_random_uuid()`.

1. Create a PostgreSQL database and user (or use an existing local development database).
2. From the `backend` directory, copy `.env.example` to `.env` and set `DATABASE_URL` to the connection string for that database. `PORT` defaults to `4000`.
   Set `JWT_SECRET` to a unique cryptographically random secret of at least 32 bytes; the API will not start without it. Do not reuse the example value or commit the secret.
3. Install dependencies with `npm install`.
4. Apply the initial schema with `npm run db:migrate`.
5. Seed the assessment data with `npm run db:seed`. It is safe to rerun.
6. Start the development server with `npm run dev`. Check `http://localhost:4000/health` for database connectivity.
7. Run `npm run build` to type-check and compile; run `npm start` to start the compiled server.

The migration is tracked in `schema_migrations` and can safely be run again. Do not commit `.env` or use development credentials outside local development.

To run focused PostgreSQL constraint tests, set `TEST_DATABASE_URL` to a disposable database where the test user can create and drop schemas, then run `npm run test:db`. The tests create and remove an isolated schema.

The authentication endpoints are `POST /auth/login` with `{ "email": "...", "password": "..." }` (returns a one-hour bearer token) and `GET /auth/me` with `Authorization: Bearer <token>` (returns the authenticated user's local roles). Local leaders can create drafts with `POST /locals/:localId/announcements` and send with `POST /locals/:localId/announcements/:announcementId/send`, using `Authorization: Bearer <token>`. Send requests require an `Idempotency-Key` header and accept an optional `{ "classificationId": "<uuid>" }` body. The leader's explicit Send action approves the draft. A successful send returns `202 Accepted`; recipient snapshots and outbox jobs are committed before that response, while provider delivery is not implemented yet.

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
      "path": "/locals/:localId/announcements/:announcementId/send",
      "auth": "Authorization: Bearer <leader token>; Idempotency-Key header; optional JSON classificationId"
    }
  ]
}
```

The seed creates 2,000 active members in Local 27 and 200 in Local 99, each spread across four classifications, with one leadership login and one member login per local. The seeded sent announcement has one recipient row per Local 27 member; push status remains queued because the push worker is not implemented.

Run `npm run test:seed` against a disposable PostgreSQL database to verify repeated seeding does not duplicate data. Run `npm run test:announcements` with `TEST_DATABASE_URL` and `DATABASE_URL` set to a disposable PostgreSQL database to test local-scoped draft and send behavior, recipient snapshots, idempotency, and concurrent sends. Delivery workers, push-provider integration, AI, and the frontend are not yet implemented.
