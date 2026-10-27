# CrewLink

## Backend setup

The backend uses Express, TypeScript, and PostgreSQL. PostgreSQL 13 or later is required for `gen_random_uuid()`.

1. Create a PostgreSQL database and user (or use an existing local development database).
2. From the `backend` directory, copy `.env.example` to `.env` and set `DATABASE_URL` to the connection string for that database. `PORT` defaults to `4000`.
   Set `JWT_SECRET` to a unique cryptographically random secret of at least 32 bytes; the API will not start without it. Do not reuse the example value or commit the secret.
3. Install dependencies with `npm install`.
4. Apply the initial schema with `npm run db:migrate`.
5. Start the development server with `npm run dev`. Check `http://localhost:4000/health` for database connectivity.
6. Run `npm run build` to type-check and compile; run `npm start` to start the compiled server.

The migration is tracked in `schema_migrations` and can safely be run again. Do not commit `.env` or use development credentials outside local development.

To run focused PostgreSQL constraint tests, set `TEST_DATABASE_URL` to a disposable database where the test user can create and drop schemas, then run `npm run test:db`. The tests create and remove an isolated schema.

The authentication endpoints are `POST /auth/login` with `{ "email": "...", "password": "..." }` (returns a one-hour bearer token) and `GET /auth/me` with `Authorization: Bearer <token>` (returns the authenticated user's local roles). Run `npm run test:auth` for password-hash and token validation tests.

The backend currently includes authentication and local-role authorization middleware, but announcement routes, workers, account seeding, and the frontend are not yet implemented.
