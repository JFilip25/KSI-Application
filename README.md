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
2. Add the environment variables below for Preview and Production.
3. Keep `OPENAPPLY_DRY_RUN=true` for the first deployment.
4. Submit a complete test application and confirm the response is marked as test mode.
5. Set the real OpenApply tenant URL and rotated API credentials.
6. Change `OPENAPPLY_DRY_RUN=false` in Preview and make a controlled test submission.
7. Verify the parent, student, year group and relationships in OpenApply before enabling Production.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENAPPLY_BASE_URL` | Tenant root, such as `https://school.openapply.com` |
| `OPENAPPLY_CLIENT_ID` | OAuth client ID; server-only |
| `OPENAPPLY_CLIENT_SECRET` | OAuth client secret; server-only |
| `OPENAPPLY_DRY_RUN` | Defaults to safe test mode unless explicitly set to `false` |
| `OPENAPPLY_CUSTOM_FIELD_MAP` | Optional JSON mapping from form keys to tenant-specific custom-field IDs |

Never expose these as `NEXT_PUBLIC_*` variables. Rotate any credential that has previously been shared in chat, email, tickets or source code before using Production.

## OpenApply record flow

On submission, the server:

1. Validates the complete payload with Zod.
2. Obtains an OAuth client-credentials token.
3. Reuses a parent with the same email when one is returned by OpenApply, otherwise creates the parent.
4. Reuses a matching child record (name, date of birth and enrolment year), otherwise creates an `applied` student.
5. Links every parent record to every sibling student record.
6. Sends configured custom fields.

Core fields work without a custom-field map. Extra admissions answers are sent only when their OpenApply field IDs are configured.

Example:

```json
{
  "student": {
    "application_reference": "12345",
    "academic_year": "12346",
    "recommended_year_group": "12347",
    "current_school": "12348",
    "home_language": "12349",
    "english_level": "12350",
    "learning_needs": "12351",
    "learning_plan": "12352",
    "medical_needs": "12353",
    "medical_action": "12354",
    "attendance": "12355",
    "repeated_grade": "12356",
    "serious_discipline": "12357",
    "disclosure_note": "12358"
  },
  "parent": {
    "mobile": "22345",
    "family_situation": "22346",
    "legal_responsibility": "22347",
    "parent_2_consent": "22348",
    "court_restrictions": "22349",
    "google_education_consent": "22350",
    "marketing_consent": "22351"
  }
}
```

Store the JSON on one line in Vercel. Replace the example IDs with IDs from the KSI OpenApply tenant.

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
npm test
npm run build
```

The placement tests cover both academic years and the 1 September boundary.
