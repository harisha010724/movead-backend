# movead-backend

Backend for MoveAd — verified-kilometre vehicle advertising. A vehicle drives
inside a campaign's zone, the platform proves the distance, the advertiser is
charged for it and the driver is paid for it.

One codebase, three deployables:

| Service       | Command                 | Port | Owns                                                           |
| ------------- | ----------------------- | ---- | -------------------------------------------------------------- |
| **api**       | `npm run dev:api`       | 8080 | Every domain module: auth, drivers, campaigns, earnings, admin |
| **ingestion** | `npm run dev:ingestion` | 8081 | The GPS write path, and nothing else                           |
| **worker**    | `npm run dev:worker`    | —    | The pipeline: classify, allocate, bill, accrue, pay out        |

They are separated so a burst of location uploads cannot slow the screen an
operator is using to release payouts, and so ingestion can be scaled and
rate-limited on its own curve. They are not separate repositories, because at
this size distributed transactions would cost more than they buy. See
[architecture Part 2.1](../context/MoveAd-Production-Architecture.md).

## Requirements

- Node.js 20.11 or newer
- PostgreSQL 16 **with PostGIS 3.4** — the pricing engine is geometric, so
  PostGIS is not optional
- Redis 7

## Getting started

```powershell
npm install
Copy-Item .env.example .env
```

Then bring up the dependencies, one of two ways.

**With Docker** (simplest — the image already contains PostGIS):

```powershell
docker compose up -d
```

**With a local PostgreSQL 16**, which this machine already runs as the
`postgresql-x64-16` service. It has no PostGIS yet: install the PostGIS 3.4
bundle through _Application Stack Builder_ (Start menu → PostgreSQL 16), then
create the role and database:

```powershell
$env:Path += ";C:\Program Files\PostgreSQL\16\bin"
psql -U postgres -c "CREATE ROLE movead LOGIN PASSWORD 'movead' CREATEDB;"
psql -U postgres -c "CREATE DATABASE movead OWNER movead;"
```

Redis has no official Windows build; run it under WSL, in Docker, or point
`REDIS_URL` at a managed instance. Until Redis is up, `/health/ready` reports
`degraded` and the API still serves everything that does not need it.

Redis is not needed for the admin flow below; only `/health/ready` notices it
is missing.

Finally:

```powershell
npm run db:migrate
npm run dev:api
```

```powershell
curl http://localhost:8080/health/live     # is the process alive
curl http://localhost:8080/health/ready    # is Postgres and Redis reachable
curl http://localhost:8080/openapi.json    # the published contract
```

## Trying the API from a browser

Swagger UI is served at **<http://localhost:8080/docs>**, generated from the
same Zod schemas the handlers validate with, so it cannot describe an endpoint
the server does not actually have.

"Try it out" works against the live server, including authenticated routes: the
page is served from the API's own origin, so the `httpOnly` session cookie set
by `POST /v1/auth/login` is sent automatically. There is no token to paste — sign
in through the login endpoint on the page itself and every subsequent call is
authenticated. A useful order for a first pass:

1. `POST /v1/admin/bootstrap` — only if no user exists yet.
2. `POST /v1/auth/login` → returns `mfa_enrolment_required` for a new admin.
3. `POST /v1/auth/mfa/enrol`, then `POST /v1/auth/mfa/verify` with a code from
   `npm run totp -- <secret>`.
4. `GET /v1/auth/me` — confirms the session, and lists the permissions that
   decide which of the remaining endpoints will answer.

`DOCS_ENABLED=false` unmounts the page while leaving `/openapi.json` in place;
it defaults to off in production, since the document is a complete map of the
surface. The clients' `api:pull` reads the JSON, not the page.

## Creating the first admin

There is no self-signup, no seeded default account and no password in a
migration. The first Super Admin is created through the API, guarded twice: the
caller must present `ADMIN_BOOTSTRAP_TOKEN`, and the platform must have no users
at all — so the endpoint stops working the moment it has been used.

```powershell
npm run admin:first -- --email you@movead.in --name "Your Name" --password "a-long-passphrase"
```

That script walks the same four public endpoints the admin portal will, and
prints the authenticator secret and `otpauth://` URI at step three. **Scan it
into an authenticator app before you close the terminal** — admin MFA is
mandatory (architecture Part 12.1) and the secret is shown exactly once. With
`ADMIN_MFA_REQUIRED=false` the script skips step three and says so.

Doing it by hand is four calls:

| Step | Call                                                     | Returns                                        |
| ---- | -------------------------------------------------------- | ---------------------------------------------- |
| 1    | `POST /v1/admin/bootstrap` with the token                | The new Super Admin, with all 29 permissions   |
| 2    | `POST /v1/auth/login` with email and password            | A five-minute challenge token, never a session |
| 3    | `POST /v1/auth/mfa/enrol` with the challenge             | The TOTP secret and provisioning URI           |
| 4    | `POST /v1/auth/mfa/verify` with the challenge and a code | Sets the session cookie                        |

After that, `GET /v1/auth/me` returns the signed-in user and their resolved
permissions, `POST /v1/auth/logout` revokes the session, and
`POST /v1/admin/users` creates further staff accounts. **Unset
`ADMIN_BOOTSTRAP_TOKEN` once the first admin exists.**

### Turning the second factor off while building

`ADMIN_MFA_REQUIRED=false` collapses those four steps to two: the password alone
returns `status: "authenticated"` and sets the session cookie, and steps three
and four never happen. It exists so the portal screens can be built without a
phone in hand.

It skips the code for accounts that are *already* enrolled, too, which is the
whole point — otherwise anyone who had run `admin:first` before flipping it
would still be prompted. Enrolled secrets stay on the row untouched, so turning
the flag back on restores the second factor with no re-enrolment.

Two guards, because this is a real reduction in security and not a preference:
the API logs a warning on every boot while it is off, and the config refuses to
load at all with it false and `NODE_ENV=production`.

The web login page needs no equivalent setting. It renders whatever `status` the
server returns, so `authenticated` simply lands on the dashboard. Only the
frontend *mock* has a matching `VITE_ADMIN_MFA_REQUIRED`, so canned responses
don't demand a factor the real server was told to skip.

### `npm test` has its own database

The suite truncates `users`, `user_sessions`, `user_invitations`, `audit_log`
and `advertisers` to get a clean slate, so it must never run against the
database you are signed in against. It doesn't: `test/setup.ts` redirects `DATABASE_URL` to the same URL
with `_test` appended to the name — `movead` becomes `movead_test` — and
`globalSetup` creates that database and migrates it on first run. Set
`TEST_DATABASE_URL` to override, which is usually what CI wants.

This used to be one database, and the symptom was memorable: run the tests, then
watch Swagger UI answer `401 unauthenticated` to every call. It reads as an
expired session or a mistyped password, and it is neither.

`npm run admin:reset` is now the only routine command that will sign you out.
It prints the database name before it does.

### One sign-in, two portals

`/v1/auth/*` is deliberately not under `/v1/admin`. One login page serves both
web portals, and it cannot know which one you belong to until your password has
been checked — so the audience is something the response **reports** rather than
something the caller asserts. A caller-supplied portal would just be an
invitation to claim the wrong one.

What differs by audience is decided from the account:

| Audience       | Second factor                       | Idle timeout | Session cookie              |
| -------------- | ----------------------------------- | ------------ | --------------------------- |
| **admin**      | Mandatory (ADM-001)                 | 30 minutes   | `movead_admin_session`      |
| **advertiser** | Optional — password alone is enough | 120 minutes  | `movead_advertiser_session` |

WEB-001 is untouched by the shared entry point. The session is still stamped
with an audience, the cookies are named apart so both can coexist in one
browser, and `requireAuth('admin')` still rejects an advertiser session with a
401 before any permission is read. `test/advertisers.test.ts` asserts exactly
that, including the case where the cookie is renamed by hand.

Set `COOKIE_DOMAIN=.movead.in` in any deployed environment so the session
survives the redirect from the login page to the other portal's origin. Leave it
unset locally, where the two dev servers differ only by port and cookies ignore
ports.

### Advertiser accounts

There is no advertiser self-registration and there is not meant to be one
(AC-32.2). An operator creates the account and its first login together with
`POST /v1/admin/advertisers`, passing a `user` object; both are written in one
transaction, so a duplicate email leaves no half-made organisation behind.
`POST /v1/admin/advertisers/{id}/users` adds further logins later. Each user is
written with `advertiser_id` set, and that column is the only thing that makes
their session an advertiser session — `users.audience` is derived from it, so
there is no way to create a user who is scoped to an advertiser but
authenticates as staff.

`PATCH /v1/admin/advertisers/{id}` corrects the organisation — its names, tax
identifiers and billing address — under `advertiser.create`, on the same
reasoning as drivers: whoever can put a company on the platform can fix what
they typed. Every field is optional and only what is sent changes, with `null`
distinguished from absent so a GSTIN can be removed rather than only replaced. A
PATCH that changes nothing is a 200 and writes no audit entry, because a form
submitted unchanged did not correct anything. **The contact is not on that
endpoint**: a person is not a column of the company, and their address is a
credential rather than a detail.

`PATCH /v1/admin/users/{id}` is where the contact is corrected, also under
`user.create`. A name is trivial. An address is not — it is half of what they
sign in with — so the endpoint does the security work rather than leaving it to
whoever calls it, and what it does depends on whether the account has ever been
used:

- **Still `INVITED`.** Nobody has signed in and the invitation went somewhere
  wrong, which is the whole reason this endpoint exists: a mistyped email is the
  one onboarding mistake the customer cannot report, because the message telling
  them the account exists went to the typo. The outstanding invitation is voided
  and a new one is sent to the corrected address, so the wrong mailbox is left
  holding a dead link.
- **Already `ACTIVE`.** The password is untouched and still works, because it
  was never MoveAd's to change. Every session is revoked, and the **previous**
  address is emailed a warning naming the member of staff who made the change.
  That direction is the point: repointing an account is how a takeover is
  finished, and the mailbox losing access is the only party who might not
  already know.
- **Suspended or disabled.** Refused with `account_not_editable`. Changing how a
  frozen account signs in has no visible effect and prepares one that does.

The response carries `emailChange`, which is null when the address was left
alone and otherwise says which of those two happened and whether the mail
actually went — so the portal can tell an admin that the invitation is on its
way to the new address, rather than leaving them to guess.

**No endpoint accepts a password for an advertiser.** The account is created in
`INVITED` with a random hash nobody holds, and the platform emails a single-use
link; the customer chooses their own password at
`POST /v1/invitations/{token}/accept`, which moves them to `ACTIVE`. Migration
009 has the full argument, but the short version is that a password sent by mail
lives in that mailbox forever and means a member of staff knows a customer's
credential — neither is acceptable for an account that will hold a funded
wallet.

| Endpoint                                       | Auth      | Does                                    |
| ---------------------------------------------- | --------- | --------------------------------------- |
| `GET /v1/invitations/{token}`                  | none      | Reads it, so the page can greet them    |
| `POST /v1/invitations/{token}/accept`          | none      | Sets the password, activates the account |
| `POST /v1/admin/users/{id}/resend-invitation`  | `user.create` | Issues a new link and voids the old |

The two public endpoints are unauthenticated by necessity — whoever is calling
them has no password yet — and are rate limited to thirty attempts per IP per
fifteen minutes. The token is 256 bits and stored only as a SHA-256 digest, the
same treatment a session cookie gets, so a dump of `user_invitations` cannot be
replayed. Resending supersedes whatever was outstanding, enforced by a partial
unique index rather than by application logic.

### Mail

`MAIL_TRANSPORT=file` (the default outside production) renders each message to
`MAIL_PREVIEW_DIR` and logs the path instead of sending it, so the templates can
be worked on without an SMTP server or a signup. Production requires `smtp` and
an `SMTP_URL`; the server refuses to start otherwise.

`npm run mail:preview` renders every template to `tmp/mail-preview/` on demand,
including a long-names variant, which is where a fixed-width email layout
usually breaks. Open the `.html` in a browser. That is enough for copy and
spacing and proves nothing about Outlook, which renders through Word — a
template change still wants one real send before it reaches a customer.

`npm run mail:test -- you@example.com` is that real send: one invitation to an
address you choose, carrying a deliberately dead token. It exercises the
credentials, the connection and the recipient's spam filter, which is the part
that actually goes wrong, without onboarding anyone to find out.

**`.env` is read once at startup.** Changing `MAIL_TRANSPORT` needs `dev:api`
restarted — `tsx watch` reloads source, not environment — and until it is, the
API carries on writing files while the config says otherwise.

Gmail works for testing via an app password and `smtps://user%40gmail.com:app-
password@smtp.gmail.com:465`; note the `%40`, or the URL parser reads the wrong
host. Gmail rewrites the sender to the authenticated account whatever `MAIL_FROM`
says, so set it to match. For real customers this should be a transactional
provider on a domain with SPF and DKIM — invitations from a personal Gmail
account land in spam often enough to matter.

Sending is always best-effort and never rolls back the account it announces. If
mail fails, onboarding still returns 201 with `invitationEmailed: false`, the
link is still valid, and the admin gets a Resend button rather than losing
everything they typed.

Sign-in decisions the acceptance criteria left open, made here and worth
knowing: passwords are argon2id with a twelve-character minimum and no
composition rules; an account locks for fifteen minutes after five failed
attempts, counting wrong TOTP codes as well as wrong passwords; sign-in is rate
limited to ten attempts per IP per fifteen minutes on top of that; admin
sessions idle out after thirty minutes and end absolutely after twelve hours.
All are environment variables — see `.env.example`.

## Onboarding a driver

The admin opens the account; the driver fills in their own details from the app
afterwards. Everything below is under `/v1/admin` and needs a session cookie.

| Step | Call                                       | Effect                                      |
| ---- | ------------------------------------------ | ------------------------------------------- |
| 1    | `POST /drivers`                            | Creates the account, `PENDING`              |
| 2    | `POST /drivers/{id}/vehicles`              | Adds a vehicle, `PENDING`                   |
| 3    | `POST /documents`                          | Records an uploaded licence, RC, insurance… |
| 4    | `POST /documents/{id}/verify` \| `/reject` | Reviews each one                            |
| 5    | `POST /vehicles/{id}/verify-documents`     | Gate: refused while any is unverified       |
| 6    | `POST /vehicles/{id}/approve`              | Only from `DOCUMENTS_VERIFIED`              |
| 7    | `POST /drivers/{id}/approve`               | Refused while the licence is unverified     |

`GET /drivers/{id}` is the whole review screen in one call: the driver, their
vehicles, and a document checklist for each showing what is verified, what is
expiring, and what was never uploaded. `GET /drivers?status=PENDING` is the
queue, and `?search=` matches a name or a mobile number.

Four rules are enforced rather than documented:

- **A rejection carries a reason.** Every reject and suspend endpoint requires
  one, of at least ten characters, and it is shown to the driver so they can
  fix it (AC-05.5). The database refuses the row without it.
- **Rejection is not terminal.** A rejected driver returns to `PENDING` with the
  reason attached, because there has to be something to resubmit into.
- **A plate belongs to one vehicle, platform-wide** (AC-05.7). Registrations are
  uppercased and stripped of spaces first, so `ka 01 ab 1234` and `KA01AB1234`
  collide as they should.
- **A resubmitted document supersedes, never overwrites.** The rejected copy
  survives for the appeal, and both are in the audit trail.

Vehicle state changes are recorded in `vehicle_status_events` with the admin and
the timestamp, readable at `GET /vehicles/{id}/history` (AC-05.3) — so a dispute
about when a vehicle became billable is settled by reading rows.

## Signing a driver in from the app

Same credentials as the web portal — the ones step 1 above emailed them — but a
different answer, because a phone cannot hold an httpOnly cookie.

| Call                        | Body                    | Returns                                    |
| --------------------------- | ----------------------- | ------------------------------------------ |
| `POST /v1/driver/auth/login`   | `{ email, password }`   | `{ tokens, user }` — no cookie is set      |
| `POST /v1/driver/auth/refresh` | `{ refreshToken }`      | A new pair; the one you sent is now dead   |
| `POST /v1/driver/auth/logout`  | —                       | 204, and both halves stop working          |

`tokens` is an access token and a refresh token. The access token is a JWT the
app holds **in memory** and sends as `Authorization: Bearer` — fifteen minutes,
audience `movead-driver`. The refresh token is opaque, belongs in the Keystore
or Keychain, and **rotates on every exchange**, so a copy lifted off a device at
rest is good for one use and only until the real device next refreshes.

Three properties are worth knowing because they are not obvious:

- **The access token names a session, it does not carry the account.** Every
  request still resolves the session row, so `logout` and suspending an account
  take effect immediately rather than fifteen minutes later. It is the same
  lookup the cookie already did.
- **Only the driver audience has tokens.** An advertiser or admin with correct
  credentials gets 403 from this endpoint, and a bearer header is ignored
  everywhere else — the portals' session stays out of JavaScript's reach, which
  is the point of `httpOnly`.
- **Mobile sessions are not subject to the portal's timeouts.** Twelve hours
  absolute and two idle exist for a browser left on an unattended desk. A phone
  tracking through a shift and reopened next morning is not that, so a mobile
  session is bounded by the refresh token's own expiry (`JWT_REFRESH_TTL_SECONDS`,
  sixty days) and by revocation. `user_sessions.client` is what distinguishes
  them, and a check constraint refuses a non-driver session claiming `mobile`.

## Scripts

| Script                                                         | Does                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `npm run dev:api` \| `dev:ingestion` \| `dev:worker`           | Watch mode via tsx                                        |
| `npm run build` → `npm run start:api`                          | Compile to `dist/`, then run it                           |
| `npm run typecheck`                                            | `tsc --noEmit`                                            |
| `npm run lint` / `lint:fix`                                    | ESLint, type-aware rules, zero warnings allowed           |
| `npm test` / `test:watch`                                      | Vitest                                                    |
| `npm run db:migrate` / `db:migrate:undo` / `db:migrate:status` | Sequelize CLI                                             |
| `npm run migration:new -- add-drivers`                         | Scaffold a migration                                      |
| `npm run admin:first -- --email ... --name ... --password ...` | Bootstrap and sign in the first Super Admin               |
| `npm run admin:reset`                                          | Wipe accounts locally so bootstrap is available again     |
| `npm run admin:sessions`                                       | Read-only: which accounts exist, and which sessions are live or idled out |
| `npm run mail:preview`                                         | Render the email templates to `tmp/mail-preview/` for review |
| `npm run mail:test -- you@example.com`                         | Send one real invitation, to prove the mail configuration |
| `npm run openapi:generate` / `openapi:check`                   | Write or verify `openapi/openapi.json`                    |
| `npm run verify`                                               | Typecheck, lint, contract freshness, tests — what CI runs |

## Layout

```
src/
├── entrypoints/       api.ts · ingestion.ts · worker.ts
├── modules/           one folder per domain; health/ is the worked example
│   ├── health/        routes → controller → service
│   ├── identity/      admin sign-in, sessions, permissions
│   ├── drivers/       onboarding: drivers, vehicles, documents, review
│   ├── tracking/      sessions, GPS ingest, and the pipeline that prices it
│   └── audit/         the append-only trail every admin action writes to
├── contracts/         Zod schemas — the API contract, source of truth
├── db/
│   ├── sequelize.ts   the connection; NUMERIC and BIGINT stay strings
│   ├── models/        Sequelize models for domain tables
│   ├── migrations/    plain CommonJS, run by the CLI
│   └── sql/           pipeline queries, parameterised, as .sql files
├── pricing/           Decimal helpers — the only place money is calculated
├── queue/             BullMQ queue names and worker registration
└── shared/            config · logger · errors · context · http · lifecycle
```

A module is four files in a fixed order — `*.routes.ts` (thin), `*.controller.ts`
(HTTP only), `*.service.ts` (business rules and **the transaction boundary**),
`*.repository.ts` (data access). The acceptance criteria live in the service.

## Conventions that are load-bearing

**Money is never a number.** `NUMERIC` in the database, a string on the wire, a
`Decimal` in between. `src/pricing/money.ts` is the only place arithmetic
happens, and `pg` is configured so NUMERIC and BIGINT never become JavaScript
floats. Clients format rupees; they never compute them. `src/pricing/rates.ts`
holds both sides of every kilometre — the advertiser rate and the driver rate,
per zone, in one table — because when they lived in two service files the
platform's margin could be changed by editing either one.

**No total is stored.** Driver earnings, campaign spend and verified kilometres
are `SUM`s over `trip_segments`, computed on every read. A stored counter is a
second source of truth for a number that has to survive a dispute, and the
first thing it does is disagree with the rows behind it. If a figure looks
wrong, the segment is wrong, and the segment names the two GPS fixes it was
measured between.

**Errors are one flat shape.** `{ code, message, requestId }`, because
`movead-mobile` already parses exactly that. `code` is snake_case and stable
enough to branch on; `message` is shown to a user and may be reworded. Throw an
`AppError` subclass from anywhere — Express 5 forwards rejections from async
handlers to the error middleware, so no controller needs a try/catch to produce
a correct response.

**The contract is generated, never hand-written.** Add a Zod schema, register
the path, run `npm run openapi:generate`. CI fails if the committed document is
stale, which is what stops the mobile client from being generated against a
contract the server no longer honours.

**Every log line carries a correlation id.** `x-request-id` is read from the
request or minted, echoed in the response, and attached through
`AsyncLocalStorage`, so nothing has to thread it through a function signature.

**Sequelize owns the domain; raw SQL owns the aggregates.** Drivers, vehicles,
campaigns and the tracking tables are models. The sums that answer "how much"
are hand-written SQL, because they are `GROUP BY`s over a few hundred thousand
rows and an ORM's version of that is slower and harder to read than the query
it generates.

**The rules that refuse to bill live in the schema.** A `PENDING_REVIEW` or
`NON_BILLABLE` segment cannot hold money — `ck_segment_money` refuses the row.
A kilometre cannot be billed twice — the unique key over
`(from_point_id, to_point_id, part_index)` refuses the second one. These are
the constraints that decide what a driver is paid, and putting them in
application logic means they hold until someone adds a code path that forgets.

## What exists today

The platform skeleton — configuration, logging, the error vocabulary, request
context, graceful shutdown, database and Redis connections, the queue helper,
money primitives, OpenAPI generation and the Swagger UI at `/docs` — plus three
modules:

- **health**, the worked example of the routes → controller → service layering.
- **identity (admin half)**: bootstrap, password and TOTP sign-in, server-side
  sessions, `requireAuth`, `requirePermission`, staff account creation, and the
  append-only audit trail every admin action writes to.
- **drivers**: driver, vehicle and document onboarding with the full admin
  review — the vehicle state machine, the document checklist, and approve or
  reject with a reason at every stage. `GET /v1/admin/documents/{id}/file`
  serves the bytes an operator has to look at before deciding, behind
  `document.read` rather than `document.verify`: looking is a lower bar than
  deciding, and who looked is answerable through the audit trail. Login is the
  username and password emailed when operations onboards the driver, on the web
  and in the app alike.
- **identity (driver app half)**: `/v1/driver/auth` issues bearer tokens rather
  than a cookie, because a phone cannot hold one. See below.
- **driver portal**: `/v1/driver/campaign` is the one campaign a driver is
  concerned with, shaped so the Android app and the web portal read the same
  object. It resolves a confirmed assignment first and falls back to a campaign
  whose advertiser merely *selected* the vehicle, returned as `requested` with a
  null `assignmentId` — visibility without entitlement, per AC-35.
  `/v1/driver/documents` is the driver's own paperwork **and their vehicle's**
  as one list, because the driver holds both and which table a row hangs off is
  not theirs to reason about. The upload is multipart into the same object store
  the creatives use, then writes through `registerDocument`, so supersession,
  the audit entry and the status transition are identical whether the file came
  from the driver or from operations.
- **installations**: assignment, the driver's acceptance, the four-angle photo
  set and the AC-07 eligibility gate that keeps all of it from becoming a
  billable kilometre on its own.
- **tracking**: the billing spine. A driver opens a session, streams batches of
  fixes at `/v1/driver/tracking/points`, and the server turns consecutive
  eligible pairs into priced `trip_segments` — each pair clipped at every zone
  boundary it crosses, each part charged at that zone's rate with the driver
  taking 60%. `tracking.pipeline.ts` is a **pure function** with no I/O in it,
  which is what makes AC-12.6 testable: delete every derived row, re-derive from
  the same fixes, and the money is identical. The rules that refuse to bill —
  the eligibility gates re-checked per batch, poor accuracy, mock locations,
  impossible speeds, gaps too long to bridge — converge on `NON_BILLABLE` for
  what is not owed and `PENDING_REVIEW` for what a human must decide, and a
  check constraint refuses money on both. **The review queue does not exist
  yet**, so held distance accrues with no way to release it.
- **advertisers**: account and first login created together, then an invitation
  email; the customer chooses their own password and no credential is ever sent.
- **mail**: SMTP in production, rendered to disk in development, with the
  invitation template and its plain-text alternative.

Twenty migrations are applied. The full list, and what each one creates, is in
[PROGRESS.md](../context/PROGRESS.md) §3 — it is kept there rather than here
because it goes stale in exactly one place that way.

Still to build, each step usable before the next begins:

1. **the review queue** — held kilometres have nowhere to go. Poor-accuracy and
   fraud-flagged distance accumulates as `PENDING_REVIEW` and nothing can
   approve or reject it, so AC-11.4's promise of a human decision is a promise
   of a human who does not exist. Blocked on a commercial answer first: who
   reviews, within what SLA, and whether unreviewed distance eventually pays or
   eventually lapses.
2. **zones and rate cards** — effective-dated versions hanging off the campaign
   row. The rate is already stamped onto each segment at the time of travel, so
   history is safe; what is missing is the ability to *change* a rate without
   editing a constant.
3. **billing and payouts** — the wallet the charge draws down, the budget cap of
   AC-17, and the weekly payout run the earnings feed.
4. **the GPS audit map** — AC-25, which also closes AC-21.8: the zone splits are
   in the database and correct, and no one can look at them.
5. **a real location provider on a real handset** — AC-09.6. Everything above
   was proved against a simulator that never loses signal and is never killed by
   a battery manager. Expect this to find things.

## Notes

- **Tests need a database, and get their own.** `npm test` runs the unit suites
  anywhere; the integration tests skip with a warning when Postgres is
  unreachable, rather than failing a fresh clone. They exercise a real
  PostgreSQL because the permission graph, the unique constraint on a
  registration plate and the partial index behind document supersession are
  database behaviour — mocking them would only prove the mock works. They run
  against `<name>_test`, created and migrated on first use, so a test run cannot
  end the session you are working in. Within that database there is still one
  schema, so integration files run one at a time (`fileParallelism: false`):
  each truncates to get a clean slate, and two doing that at once delete rows
  the other is asserting on.
- **`user_sessions` is an addition to the published schema**, documented in
  `MoveAd-Database-Design.md` §4.5. The design covers driver refresh tokens but
  not web portal sessions, which Part 12.1 requires.
- **PostGIS is not in the first migration.** It is not a trusted extension, it
  needs a separate install on Windows, and nothing before the zones migration
  has a geography column. It becomes a hard requirement there.
- **Express 5**, where the architecture document says Express 4. Version 5 is
  the current stable release, and it forwards rejected promises from handlers
  to the error middleware, which removes an `asyncHandler` wrapper from every
  route in the codebase. Nothing else in the document is affected.
- `npm audit` reports a moderate advisory against `uuid` reached through
  Sequelize. It concerns the buffer-writing form of `uuid` v3/v5/v6, which
  Sequelize does not use; the only clean fix would be downgrading Sequelize
  several majors. Revisit when Sequelize bumps the dependency.

Admin
---------------------
harish90142@gmail.com
Harisha90142!@#

Advertiser
---------------
biyima5094@prodbits.com
Advertiser123!@#


Drivers
--------------
1. Username
sujay@mailinator.com
Password
MQuW-msGT-uAC4

2. 