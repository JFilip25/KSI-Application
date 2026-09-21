"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { ApplicationData } from "@/lib/schema";
import { getCountries, LANGUAGES, LEARNING_SUPPORT, MEDICAL_NEEDS } from "@/lib/options";
import { getSuggestedPlacement, type AcademicYear } from "@/lib/placement";

type Child = ApplicationData["children"][number];
type Parent = ApplicationData["parent1"];
type Draft = Omit<ApplicationData, "declarations"> & {
  declarations: { accuracy: boolean; authority: boolean; privacy: boolean };
};

const STEPS = [
  ["Start", "Academic year"],
  ["Children", "Applicant details"],
  ["Parents", "Contact & authority"],
  ["Support", "Learning & wellbeing"],
  ["Review", "Check & submit"],
] as const;

const fixedUuid = "00000000-0000-4000-8000-000000000001";

function newChild(id = fixedUuid): Child {
  return {
    id,
    firstName: "",
    lastName: "",
    preferredName: "",
    dateOfBirth: "",
    gender: "prefer-not-to-say",
    nationality: "ME",
    currentSchool: "",
    currentGrade: "",
    entryTiming: "start-of-year",
    homeLanguage: "English",
    otherHomeLanguage: "",
    englishLevel: "not-yet-assessed",
    learningNeeds: ["No known learning support needs"],
    learningPlan: "none",
    medicalNeeds: ["No condition the school needs to plan for"],
    medicalAction: "none",
    attendance: "regular",
    repeatedGrade: "no",
    seriousDiscipline: "no",
    disclosureNote: "",
  };
}

function newParent(): Parent {
  return {
    firstName: "",
    lastName: "",
    relationship: "mother",
    email: "",
    mobile: "",
    country: "ME",
  };
}

function initialDraft(): Draft {
  return {
    academicYear: "2026-2027",
    children: [newChild()],
    parent1: newParent(),
    familySituation: "together",
    legalResponsibility: "joint",
    parent2: newParent(),
    parent2Consent: "signing-now",
    courtRestrictions: "none",
    declarations: { accuracy: false, authority: false, privacy: false },
    applicationReference: "00000000-0000-4000-8000-000000000002",
    startedAt: Date.now(),
    website: "",
  };
}

function Mark({ small = false }: { small?: boolean }) {
  return (
    <Image
      src="/ksi-mark.svg"
      width={small ? 205 : 246}
      height={small ? 57 : 68}
      alt="Knightsbridge Schools International Montenegro"
      priority
    />
  );
}

function Arrow({ direction = "right" }: { direction?: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" className={direction === "left" ? "flip" : ""}>
      <path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, translation, children, hint }: { label: string; translation?: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {translation && <span className="translation">{translation}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function ChoiceGroup<T extends string>({
  label,
  translation,
  value,
  onChange,
  options,
  compact = false,
}: {
  label: string;
  translation?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; note?: string }[];
  compact?: boolean;
}) {
  return (
    <fieldset className="choice-field">
      <legend>
        <span className="field-label">{label}</span>
        {translation && <span className="translation">{translation}</span>}
      </legend>
      <div className={compact ? "choice-grid compact" : "choice-grid"}>
        {options.map((option) => (
          <label className={`choice ${value === option.value ? "selected" : ""}`} key={option.value}>
            <input type="radio" checked={value === option.value} onChange={() => onChange(option.value)} />
            <span className="radio-dot" />
            <span>
              <strong>{option.label}</strong>
              {option.note && <small>{option.note}</small>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Checklist({
  label,
  values,
  options,
  exclusive,
  onChange,
}: {
  label: string;
  values: string[];
  options: readonly string[];
  exclusive: string;
  onChange: (values: string[]) => void;
}) {
  function toggle(option: string) {
    if (option === exclusive) return onChange([exclusive]);
    const withoutExclusive = values.filter((item) => item !== exclusive);
    const next = withoutExclusive.includes(option)
      ? withoutExclusive.filter((item) => item !== option)
      : [...withoutExclusive, option];
    onChange(next.length ? next : [exclusive]);
  }

  return (
    <fieldset className="check-field">
      <legend className="field-label">{label}</legend>
      <div className="check-grid">
        {options.map((option) => (
          <label className={`check-choice ${values.includes(option) ? "selected" : ""}`} key={option}>
            <input type="checkbox" checked={values.includes(option)} onChange={() => toggle(option)} />
            <span className="check-box">✓</span>
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SectionIntro({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <header className="section-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{body}</p>
    </header>
  );
}

function Notice({ children, tone = "blue" }: { children: React.ReactNode; tone?: "blue" | "raspberry" }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

function isParentComplete(parent?: Parent) {
  return Boolean(parent?.firstName && parent.lastName && parent.email.includes("@") && parent.mobile.length >= 7 && parent.country);
}

export function ApplicationForm() {
  const countries = useMemo(() => getCountries(), []);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ reference: string; dryRun: boolean } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem("ksi-application-draft-v1");
        if (saved) setDraft(JSON.parse(saved) as Draft);
        else {
          setDraft((current) => ({
            ...current,
            applicationReference: crypto.randomUUID(),
            children: [{ ...current.children[0], id: crypto.randomUUID() }],
          }));
        }
      } catch {
        localStorage.removeItem("ksi-application-draft-v1");
      } finally {
        setLoaded(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (loaded && !submitted) localStorage.setItem("ksi-application-draft-v1", JSON.stringify(draft));
  }, [draft, loaded, submitted]);

  function patchDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function patchChild(index: number, patch: Partial<Child>) {
    setDraft((current) => ({
      ...current,
      children: current.children.map((child, childIndex) => childIndex === index ? { ...child, ...patch } : child),
    }));
  }

  function addChild() {
    if (draft.children.length >= 5) return;
    patchDraft("children", [...draft.children, newChild(crypto.randomUUID())]);
  }

  function canContinue() {
    if (step === 1) {
      return draft.children.every((child) => child.firstName && child.lastName && child.dateOfBirth && child.nationality);
    }
    if (step === 2) {
      return isParentComplete(draft.parent1) && (draft.legalResponsibility !== "joint" || isParentComplete(draft.parent2));
    }
    if (step === 3) {
      return draft.children.every((child) => child.learningNeeds.length && child.medicalNeeds.length);
    }
    if (step === 4) return Object.values(draft.declarations).every(Boolean);
    return true;
  }

  function next() {
    if (!canContinue()) {
      setError("Please complete the required choices before continuing.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setError("");
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit() {
    if (!canContinue()) return next();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json()) as { error?: string; reference?: string; dryRun?: boolean };
      if (!response.ok || !body.reference) throw new Error(body.error || "Submission failed.");
      localStorage.removeItem("ksi-application-draft-v1");
      setSubmitted({ reference: body.reference, dryRun: Boolean(body.dryRun) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not submit the application.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className="success-shell">
        <div className="success-card">
          <Mark />
          <div className="success-icon">✓</div>
          <p className="eyebrow">Application received</p>
          <h1>Thank you. We’ll take it from here.</h1>
          <p>Admissions will review the information and contact your family about the next step. Documents and operational permissions will be requested only after a conditional offer.</p>
          <div className="reference"><span>Reference</span><strong>{submitted.reference.split("-")[0].toUpperCase()}</strong></div>
          {submitted.dryRun && <Notice tone="raspberry"><strong>Test mode:</strong> this submission was validated but was not sent to OpenApply.</Notice>}
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="rail-logo"><Mark small /></div>
        <div className="rail-copy">
          <p className="rail-kicker">Admissions</p>
          <h2>A clear first step.</h2>
          <p>Tell us what we need to understand your family and plan the right admissions conversation.</p>
        </div>
        <nav aria-label="Application progress" className="step-list">
          {STEPS.map(([title, description], index) => (
            <button
              key={title}
              type="button"
              className={`${index === step ? "active" : ""} ${index < step ? "complete" : ""}`}
              onClick={() => index < step && setStep(index)}
              aria-current={index === step ? "step" : undefined}
            >
              <span className="step-number">{index < step ? "✓" : index + 1}</span>
              <span><strong>{title}</strong><small>{description}</small></span>
            </button>
          ))}
        </nav>
        <p className="rail-footer">Your draft is saved on this device.</p>
      </aside>

      <main className="content">
        <header className="mobile-header"><Mark small /><span>Step {step + 1} of {STEPS.length}</span></header>
        <div className="mobile-progress"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
        <div className="form-wrap">
          {error && <div className="error-banner" role="alert"><strong>Check this step</strong><span>{error}</span></div>}

          {step === 0 && (
            <>
              <SectionIntro
                eyebrow="Apply to KSI Montenegro"
                title="Let’s start with the school year."
                body="This focused application usually takes 10–15 minutes. You can add siblings without entering parent details again."
              />
              <ChoiceGroup
                label="Academic year"
                translation="Školska godina"
                value={draft.academicYear}
                onChange={(value) => patchDraft("academicYear", value)}
                options={[
                  { value: "2026-2027", label: "2026–27", note: "Current admissions cycle" },
                  { value: "2027-2028", label: "2027–28", note: "Future admissions cycle" },
                ] satisfies { value: AcademicYear; label: string; note: string }[]}
              />
              <div className="what-next">
                <div><span>01</span><strong>Child details</strong><small>DOB, current school and languages</small></div>
                <div><span>02</span><strong>Parent authority</strong><small>Contact and consent pathway</small></div>
                <div><span>03</span><strong>Support needs</strong><small>Structured learning and wellbeing choices</small></div>
              </div>
              <Notice><strong>No documents today.</strong> Reports, identity documents, custody evidence and operational permissions are requested only after a conditional offer.</Notice>
            </>
          )}

          {step === 1 && (
            <>
              <SectionIntro eyebrow="Children" title="Who is applying?" body="Add every sibling applying in this cycle. We use date of birth to suggest a year group." />
              {draft.children.map((child, index) => {
                const placement = getSuggestedPlacement(child.dateOfBirth, draft.academicYear);
                return (
                  <section className="form-card" key={child.id}>
                    <div className="card-heading">
                      <div><span>Applicant {index + 1}</span><h2>{child.firstName || child.lastName ? `${child.firstName} ${child.lastName}`.trim() : "Child details"}</h2></div>
                      {draft.children.length > 1 && <button type="button" className="text-button danger" onClick={() => patchDraft("children", draft.children.filter((_, i) => i !== index))}>Remove</button>}
                    </div>
                    <div className="field-grid two">
                      <Field label="First name" translation="Ime"><input value={child.firstName} onChange={(event) => patchChild(index, { firstName: event.target.value })} required /></Field>
                      <Field label="Last name" translation="Prezime"><input value={child.lastName} onChange={(event) => patchChild(index, { lastName: event.target.value })} required /></Field>
                      <Field label="Preferred name" translation="Ime koje koristi" hint="Optional"><input value={child.preferredName} onChange={(event) => patchChild(index, { preferredName: event.target.value })} /></Field>
                      <Field label="Date of birth" translation="Datum rođenja"><input type="date" value={child.dateOfBirth} onChange={(event) => patchChild(index, { dateOfBirth: event.target.value })} required /></Field>
                      <Field label="Nationality" translation="Nacionalnost"><select value={child.nationality} onChange={(event) => patchChild(index, { nationality: event.target.value })}>{countries.map((country) => <option value={country.code} key={country.code}>{country.name}</option>)}</select></Field>
                      <Field label="Gender" translation="Pol"><select value={child.gender} onChange={(event) => patchChild(index, { gender: event.target.value as Child["gender"] })}><option value="female">Female</option><option value="male">Male</option><option value="nonbinary">Non-binary</option><option value="prefer-not-to-say">Prefer not to say</option></select></Field>
                      <Field label="Current school" translation="Trenutna škola" hint="Leave blank if not yet at school"><input value={child.currentSchool} onChange={(event) => patchChild(index, { currentSchool: event.target.value })} /></Field>
                      <Field label="Current year / grade" translation="Trenutni razred"><input value={child.currentGrade} onChange={(event) => patchChild(index, { currentGrade: event.target.value })} /></Field>
                    </div>
                    <ChoiceGroup
                      label="When would you like your child to join?"
                      value={child.entryTiming}
                      onChange={(value) => patchChild(index, { entryTiming: value })}
                      compact
                      options={[
                        { value: "start-of-year", label: `Start of ${draft.academicYear.replace("-", "–")}` },
                        { value: "during-year", label: "During the school year" },
                      ]}
                    />
                    <div className={`placement ${placement ? "available" : "unavailable"}`}>
                      <span className="placement-label">Suggested placement</span>
                      <strong>{placement ? placement.group : child.dateOfBirth ? "Admissions review needed" : "Enter date of birth"}</strong>
                      {placement && <small>Age {placement.ageBand} in {draft.academicYear.replace("-", "–")}</small>}
                      <p>This is an age-based guide. Final placement depends on records, readiness and the admissions review.</p>
                    </div>
                  </section>
                );
              })}
              <button className="add-button" type="button" onClick={addChild} disabled={draft.children.length >= 5}><span>+</span>Add another child</button>
            </>
          )}

          {step === 2 && (
            <>
              <SectionIntro eyebrow="Parents & guardians" title="Who can make this application?" body="We need one main contact and the correct consent route for everyone with legal parental responsibility." />
              <section className="form-card">
                <div className="card-heading"><div><span>Main contact</span><h2>Parent or guardian 1</h2></div></div>
                <ParentFields parent={draft.parent1} countries={countries} onChange={(parent1) => patchDraft("parent1", parent1)} />
              </section>
              <ChoiceGroup
                label="Family situation"
                translation="Porodična situacija"
                value={draft.familySituation}
                onChange={(value) => patchDraft("familySituation", value)}
                options={[
                  { value: "together", label: "Parents together" },
                  { value: "separated", label: "Parents separated" },
                  { value: "divorced", label: "Parents divorced" },
                  { value: "sole-parent", label: "Sole-parent family" },
                  { value: "widowed", label: "One parent deceased" },
                  { value: "other", label: "Another legal arrangement" },
                ]}
              />
              <ChoiceGroup
                label="Who holds legal parental responsibility?"
                translation="Ko ima zakonsko roditeljsko pravo?"
                value={draft.legalResponsibility}
                onChange={(value) => {
                  patchDraft("legalResponsibility", value);
                  if (value === "joint") {
                    if (!draft.parent2) patchDraft("parent2", newParent());
                    patchDraft("parent2Consent", "signing-now");
                  } else {
                    patchDraft("parent2", undefined);
                    patchDraft("parent2Consent", "evidence-exception");
                  }
                }}
                options={[
                  { value: "joint", label: "Both parents / guardians", note: "Both will consent to the application" },
                  { value: "sole-parent-1", label: "Parent 1 only", note: "Evidence requested after a conditional offer" },
                  { value: "restricted-parent-2", label: "Parent 2 authority is restricted", note: "Court or authority evidence requested later" },
                  { value: "parent-2-deceased", label: "Parent 2 is deceased", note: "Evidence requested later" },
                  { value: "parent-2-uncontactable", label: "Parent 2 cannot reasonably be contacted", note: "Admissions will review the circumstances" },
                ]}
              />
              {draft.legalResponsibility === "joint" && draft.parent2 && (
                <section className="form-card">
                  <div className="card-heading"><div><span>Second contact</span><h2>Parent or guardian 2</h2></div></div>
                  <ParentFields parent={draft.parent2} countries={countries} onChange={(parent2) => patchDraft("parent2", parent2)} />
                </section>
              )}
              <ChoiceGroup
                label="Consent route for parent / guardian 2"
                value={draft.parent2Consent}
                onChange={(value) => patchDraft("parent2Consent", value)}
                options={draft.legalResponsibility === "joint" ? [
                  { value: "signing-now", label: "Consenting with this application", note: "Parent 1 confirms both parents agree" },
                  { value: "secure-request", label: "Separate consent needed", note: "Admissions will send Parent 2 a secure request" },
                ] : [
                  { value: "evidence-exception", label: "Second consent is not applicable", note: "Admissions will verify the legal basis after a conditional offer" },
                ]}
              />
              <ChoiceGroup
                label="Is there a court order or restriction the school must follow when contacting or releasing the child?"
                value={draft.courtRestrictions}
                onChange={(value) => patchDraft("courtRestrictions", value)}
                compact
                options={[
                  { value: "none", label: "No" },
                  { value: "yes-admissions-follow-up", label: "Yes — contact me privately", note: "Admissions will request details securely" },
                ]}
              />
              <Notice tone="raspberry"><strong>Important:</strong> the form records your declared authority; it does not decide custody. KSI may request legal evidence before enrolment and will follow applicable court or authority orders.</Notice>
            </>
          )}

          {step === 3 && (
            <>
              <SectionIntro eyebrow="Learning & wellbeing" title="Help us prepare the right conversation." body="Choose every answer that applies. Details and documents can be shared securely with Admissions after review." />
              {draft.children.map((child, index) => (
                <section className="form-card profile-card" key={child.id}>
                  <div className="card-heading"><div><span>Applicant {index + 1}</span><h2>{child.firstName || "Child"}’s profile</h2></div></div>
                  <div className="field-grid two">
                    <Field label="Language spoken most at home" translation="Jezik koji se govori kod kuće">
                      <select value={child.homeLanguage} onChange={(event) => patchChild(index, { homeLanguage: event.target.value })}>{LANGUAGES.map((language) => <option key={language}>{language}</option>)}</select>
                    </Field>
                    <Field label="English level" translation="Nivo engleskog jezika">
                      <select value={child.englishLevel} onChange={(event) => patchChild(index, { englishLevel: event.target.value as Child["englishLevel"] })}><option value="fluent">Fluent</option><option value="proficient">Proficient</option><option value="developing">Developing</option><option value="beginner">Beginner</option><option value="not-yet-assessed">Not yet assessed</option></select>
                    </Field>
                    {child.homeLanguage === "Other / not listed" && <Field label="Language"><input value={child.otherHomeLanguage} onChange={(event) => patchChild(index, { otherHomeLanguage: event.target.value })} required /></Field>}
                  </div>
                  <Checklist label="Learning support — select all that apply" values={child.learningNeeds} options={LEARNING_SUPPORT} exclusive="No known learning support needs" onChange={(learningNeeds) => patchChild(index, { learningNeeds })} />
                  <ChoiceGroup label="Does your child have, or previously have, a learning plan or formal assessment?" value={child.learningPlan} onChange={(value) => patchChild(index, { learningPlan: value })} compact options={[
                    { value: "none", label: "No" },
                    { value: "current-plan", label: "Current plan / assessment" },
                    { value: "previous-plan", label: "Previous plan / assessment" },
                    { value: "assessment-in-progress", label: "Assessment in progress" },
                  ]} />
                  <Checklist label="Health or access needs — select all that apply" values={child.medicalNeeds} options={MEDICAL_NEEDS} exclusive="No condition the school needs to plan for" onChange={(medicalNeeds) => patchChild(index, { medicalNeeds })} />
                  <ChoiceGroup label="What would the school need to plan for?" value={child.medicalAction} onChange={(value) => patchChild(index, { medicalAction: value })} compact options={[
                    { value: "none", label: "No current action" },
                    { value: "emergency-plan", label: "Emergency plan" },
                    { value: "medication", label: "Medication at school" },
                    { value: "staff-training", label: "Staff awareness / training" },
                    { value: "access-adjustment", label: "Access adjustment" },
                    { value: "other", label: "Another arrangement" },
                  ]} />
                  <div className="field-grid three">
                    <Field label="Attendance"><select value={child.attendance} onChange={(event) => patchChild(index, { attendance: event.target.value as Child["attendance"] })}><option value="regular">Regular</option><option value="some-concern">Some concern</option><option value="significant-concern">Significant concern</option></select></Field>
                    <Field label="Repeated a grade?"><select value={child.repeatedGrade} onChange={(event) => patchChild(index, { repeatedGrade: event.target.value as Child["repeatedGrade"] })}><option value="no">No</option><option value="yes">Yes</option></select></Field>
                    <Field label="Serious disciplinary action?"><select value={child.seriousDiscipline} onChange={(event) => patchChild(index, { seriousDiscipline: event.target.value as Child["seriousDiscipline"] })}><option value="no">No</option><option value="yes-current-school">Yes, current school</option><option value="yes-previous-school">Yes, previous school</option></select></Field>
                  </div>
                  {(child.learningNeeds.some((value) => value !== "No known learning support needs") || child.medicalNeeds.some((value) => value !== "No condition the school needs to plan for") || child.repeatedGrade === "yes" || child.seriousDiscipline !== "no") && (
                    <Field label="Brief context" translation="Kratko objašnjenje" hint="Only include what Admissions needs to triage the application. Detailed records come later."><textarea rows={4} maxLength={500} value={child.disclosureNote} onChange={(event) => patchChild(index, { disclosureNote: event.target.value })} /></Field>
                  )}
                </section>
              ))}
              <Notice>Providing support information does not determine admission. It helps KSI assess whether the school can provide a safe, appropriate learning environment.</Notice>
            </>
          )}

          {step === 4 && (
            <>
              <SectionIntro eyebrow="Review" title="One final check." body="Confirm the essentials below. You can return to any completed section before submitting." />
              <div className="review-grid">
                <ReviewCard title="Entry" onEdit={() => setStep(0)}><p><strong>{draft.academicYear.replace("-", "–")}</strong> academic year</p></ReviewCard>
                <ReviewCard title="Applicants" onEdit={() => setStep(1)}>{draft.children.map((child) => { const placement = getSuggestedPlacement(child.dateOfBirth, draft.academicYear); return <p key={child.id}><strong>{child.firstName} {child.lastName}</strong><span>{placement?.group ?? "Placement review"} · {child.dateOfBirth}</span></p>; })}</ReviewCard>
                <ReviewCard title="Main contact" onEdit={() => setStep(2)}><p><strong>{draft.parent1.firstName} {draft.parent1.lastName}</strong><span>{draft.parent1.email} · {draft.parent1.mobile}</span></p><p><span>{draft.legalResponsibility === "joint" ? "Joint parental responsibility" : "Admissions evidence review required"}</span></p></ReviewCard>
                <ReviewCard title="Support profile" onEdit={() => setStep(3)}><p><strong>{draft.children.length} child{draft.children.length > 1 ? "ren" : ""}</strong><span>Learning, language, health and school history completed</span></p></ReviewCard>
              </div>
              <section className="declarations">
                <div><p className="eyebrow">Declarations</p><h2>Submit with authority and care.</h2></div>
                <Declaration checked={draft.declarations.accuracy} onChange={(accuracy) => patchDraft("declarations", { ...draft.declarations, accuracy })}>I confirm that the information is accurate and complete to the best of my knowledge.</Declaration>
                <Declaration checked={draft.declarations.authority} onChange={(authority) => patchDraft("declarations", { ...draft.declarations, authority })}>I confirm that I have parental responsibility or legal authority to make this application, and that the consent route selected above is correct.</Declaration>
                <Declaration checked={draft.declarations.privacy} onChange={(privacy) => patchDraft("declarations", { ...draft.declarations, privacy })}>I understand that KSI Montenegro will process this information, including learning and health information, to assess the application and safeguard the child.</Declaration>
              </section>
              <Notice><strong>Not included at this stage:</strong> promotional photos, field trips, transport, Google services and other operational permissions. Those decisions are presented separately after a conditional offer.</Notice>
            </>
          )}

          <div className="actions">
            {step > 0 ? <button type="button" className="button secondary" onClick={() => { setError(""); setStep(step - 1); }}><Arrow direction="left" />Back</button> : <span />}
            {step < STEPS.length - 1 ? <button type="button" className="button primary" onClick={next}>Continue<Arrow /></button> : <button type="button" className="button primary submit" onClick={submit} disabled={submitting}>{submitting ? "Submitting…" : "Submit application"}<Arrow /></button>}
          </div>
          <p className="privacy-footnote">Sensitive information is sent only when you submit. Your in-progress draft stays in this browser.</p>
        </div>
      </main>
    </div>
  );
}

function ParentFields({ parent, countries, onChange }: { parent: Parent; countries: ReturnType<typeof getCountries>; onChange: (parent: Parent) => void }) {
  return (
    <div className="field-grid two">
      <Field label="First name" translation="Ime"><input value={parent.firstName} onChange={(event) => onChange({ ...parent, firstName: event.target.value })} required /></Field>
      <Field label="Last name" translation="Prezime"><input value={parent.lastName} onChange={(event) => onChange({ ...parent, lastName: event.target.value })} required /></Field>
      <Field label="Relationship to child" translation="Odnos sa djetetom"><select value={parent.relationship} onChange={(event) => onChange({ ...parent, relationship: event.target.value as Parent["relationship"] })}><option value="mother">Mother</option><option value="father">Father</option><option value="step-parent">Step-parent</option><option value="legal-guardian">Legal guardian</option><option value="other-guardian">Other guardian</option></select></Field>
      <Field label="Country of residence" translation="Država prebivališta"><select value={parent.country} onChange={(event) => onChange({ ...parent, country: event.target.value })}>{countries.map((country) => <option value={country.code} key={country.code}>{country.name}</option>)}</select></Field>
      <Field label="Email" translation="Email adresa"><input type="email" autoComplete="email" value={parent.email} onChange={(event) => onChange({ ...parent, email: event.target.value })} required /></Field>
      <Field label="Mobile number" translation="Broj telefona"><input type="tel" autoComplete="tel" value={parent.mobile} onChange={(event) => onChange({ ...parent, mobile: event.target.value })} required /></Field>
    </div>
  );
}

function ReviewCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return <section className="review-card"><header><h2>{title}</h2><button type="button" onClick={onEdit}>Edit</button></header>{children}</section>;
}

function Declaration({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) {
  return (
    <label className={`declaration ${checked ? "checked" : ""}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="check-box">✓</span>
      <span>{children}</span>
    </label>
  );
}
