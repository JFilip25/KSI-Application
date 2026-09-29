# KSI Montenegro admissions application

A focused, mobile-first application for Knightsbridge Schools International Montenegro. The project is built with Next.js and is ready for Vercel. It creates or reuses parent and student records in OpenApply from a server-only API route.

## What the application does

- Supports the 2026–27 and 2027–28 admissions cycles.
- Suggests Nursery–Year 13 from date of birth using KSI's 1 September–31 August placement table.
- Clearly labels placement as provisional and subject to the admissions process.
- Lets one family apply for up to five siblings without repeating parent details.
- Uses structured choices for learning, medical, attendance and disciplinary information.
- Routes joint, sole, restricted, deceased and uncontactable-parent situations without asking families to upload evidence at the application stage.
- Captures mandatory Google Workspace for Education consent and a separate Yes/No marketing choice.
- Saves an in-progress draft only in the family's browser.
- Keeps OpenApply credentials and API traffic on the server.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Vercel setup

1. Import this GitHub repository into Vercel.
2. Add the environment variables below for Production (and Preview if previews should write to OpenApply).
3. Set `OPENAPPLY_DRY_RUN` to the single word `false` to send applications to OpenApply. Any other value — including the default, `true`, or a whole line such as `OPENAPPLY_DRY_RUN=false` pasted into the value box — keeps the site in test mode: families see "Application received" plus a "Test submission" notice, and nothing reaches OpenApply.
4. Redeploy after changing environment variables; Vercel only applies them to new deployments.
5. Submit one clearly marked test application and check the family, student, year group and relationships in OpenApply, then delete it there.

| Variable | Purpose |
| --- | --- |
| `OPENAPPLY_BASE_URL` | Tenant root: `https://ksimontenegro.openapply.com` (a trailing `/`, `/api/v3` or `/oauth/token` is tolerated) |
| `OPENAPPLY_CLIENT_ID` | OAuth client ID from OpenApply → Settings → Integrations → Public API; server-only |
| `OPENAPPLY_CLIENT_SECRET` | OAuth client secret; server-only |
| `OPENAPPLY_DRY_RUN` | `false` for live submissions; anything else is test mode |
| `OPENAPPLY_CUSTOM_FIELD_MAP` | Optional overrides for the built-in field map (see below); leave empty or `{}` |

Never expose these as `NEXT_PUBLIC_*` variables. Rotate any credential that has been shared in chat, email, tickets or source code, then update Vercel and redeploy.

## OpenApply record flow

The server validates the payload with Zod and then, in this order:

1. Finds each parent by email (`/parents/search`) or creates them. A parent 2 with the same email as parent 1 is kept in the summary instead; so is parent 2 when a court order or restriction is declared, because linking a parent gives them portal access — Admissions adds them after following up.
2. Finds each child among the family's existing students (and records left unlinked by an earlier failed attempt), matching name and date of birth; otherwise creates the student as `pending` with first/last/preferred name, date of birth, gender (OpenApply accepts only Male/Female), suggested year group, enrolment year and the family's country of residence.
3. Links every parent to every child with their role (mother, father, stepmother, stepfather, legal guardian, other guardian). OpenApply replaces a parent's whole set of links on update, so existing children are always kept.
4. Moves new students to `applied`, so OpenApply's own "applied" status event fires with the parents attached. An existing enquiry for the same child becomes an application; a child who is already further along keeps their status and data.
5. Writes KSI's existing custom fields and a readable summary of every answer (below). These writes never fail a submission: if OpenApply refuses a value, the free-text answers and the summary are still saved and the problem is logged.

Submitting again — a retry after an error, a double click, or a resubmission from another device — finds the same records instead of creating duplicates.

OpenApply allows 5 API requests per 2 seconds. The server paces its requests, waits out any `429` using OpenApply's reset time, retries temporary failures on reads and full-state updates, and never blindly repeats a create (it looks the record up first). A typical family takes 8–15 requests and 3–8 seconds; the route allows up to 60 seconds. If OpenApply stays busy the family sees "please try again in a minute" (HTTP 503) before anything is written; if OpenApply rejects the application the family is asked to contact Admissions with their reference.

### Fields written

Option fields are written as OpenApply option IDs from the KSI tenant (`lib/openapply/tenant.ts`); nationality and language options come from `lib/openapply/data`, generated from the tenant's option lists by `npm run openapply:generate`.

| Form answer | OpenApply field |
| --- | --- |
| Nationality | Nationality (30), e.g. ME → Montenegrin |
| Language spoken most at home | Language (40); "Other" answers are matched to OpenApply's list when possible |
| English level | English (357797): Fluent, Proficient, Basic (developing/beginner) |
| Current school / year | Prior School (17), Current Grade (124830) |
| Family situation | Family Situation (357715) where an option matches |
| Repeated a grade, attendance, discipline | Yes/No fields 357781, 357786 (+ 357787), 357788 (+ 357789) |
| Learning plan / assessment, EAL | Yes/No fields 357764 (+ 357766), 357760 |
| Health or access needs | Medical conditions Yes/No 358466 (+ 358467) |
| Marketing consent | Photo/video permission (357895) |
| Google Workspace consent | Use of Google Education Services (470505) |
| Everything, in the form's own words | Additional information (124870): reference, placement guide, needs, family and consent route, both parents' contact details, siblings |
| Parent mobile | Parent Mobile Phone (75), only if the parent has none yet |

Custody and legal-authority fields are deliberately not written; the summary records the route the family declared. The parent's country of residence cannot be set through the OpenApply API, so it is recorded in the summary and used as the student's country.

The summary field may be visible to linked parents in the OpenApply portal. To keep it office-only, create an office-use text area in OpenApply and point the summary at it:

```json
{"student":{"summary":123456}}
```

`OPENAPPLY_CUSTOM_FIELD_MAP` accepts `{"student": {...}, "parent": {...}}` with the keys used in `lib/openapply/tenant.ts`. A numeric field ID retargets a text field; `null` turns a field off (for example `{"student":{"photoConsent":null}}`). Option fields can only be turned off, because their option IDs belong to the KSI tenant. Invalid JSON or unknown keys are logged and ignored.

### Logs

Each submission writes one JSON line: `openapply.push` (OpenApply IDs, request count, retries, 429s, duration, warnings) or `openapply.push_failed` (the step, HTTP status and OpenApply's message with submitted values redacted). Names, emails, phone numbers and dates of birth are never logged.

## Passwordless access

OpenApply's public API does not provide a documented endpoint for creating a family magic-link or one-time-code session. This version therefore avoids password creation and keeps the draft on the current device. A durable cross-device secure link would require a small application database plus an email provider; it should not be simulated with an unsigned URL.

## Consent and legal review

The implemented custody route is deliberately conservative: where both parents hold parental responsibility, the application records whether both are consenting or whether a separate secure request is needed. Exceptions are flagged for Admissions and supporting evidence is requested later.

Before launch, KSI should have Montenegro-qualified counsel or its data-protection adviser approve:

- the exact declaration wording;
- the legal basis and retention period for health and learning information;
- the evidence required for sole responsibility, death, restriction or inability to contact another parent;
- the privacy-notice link and contact details;
- the process used to obtain a second parent's separate consent.

The interface does not claim to determine custody or legal authority.

## Quality checks

```bash
npm run lint
npm run typecheck
npm test            # unit and route tests against a simulated OpenApply tenant; no network
npm run build
```

`npm run test:stress` sends 50 simultaneous families through three simulated server instances sharing OpenApply's rate limit, with injected failures, and checks that every family ends up in OpenApply exactly once and fully linked.

`npm run test:live` runs the same flow against a real tenant and verifies the stored records. It creates marked test records (surname `ZZTEST…`, `@example.com` emails) that must be deleted in OpenApply afterwards — the API cannot delete them — so it only runs with explicit confirmation:

```bash
OPENAPPLY_LIVE_CONFIRM_HOST=ksimontenegro.openapply.com OPENAPPLY_DRY_RUN=false \
OPENAPPLY_BASE_URL=… OPENAPPLY_CLIENT_ID=… OPENAPPLY_CLIENT_SECRET=… npm run test:live
```

The placement tests cover both academic years and the 1 September boundary.
