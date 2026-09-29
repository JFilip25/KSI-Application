/**
 * What happens after a family applies. One source for the thank-you page and the confirmation
 * email; the wording follows KSI's "Applied" email in OpenApply (Settings → Admissions →
 * Status & Notification), which OpenApply does not send for applications made through this app.
 */
const OPENAPPLY = "https://ksimontenegro.openapply.com";

export const NEXT_STEPS = {
  schoolName: "Knightsbridge Schools International Montenegro",
  sender: { name: "KSI Montenegro", email: "f.jankovic@ksi-montenegro.com" },
  admissionsEmail: "f.jankovic@ksi-montenegro.com",
  admissionsSignatory: "Filip Janković",
  financeEmail: "j.jokic@ksi-montenegro.com",
  registrationFeeEur: 800,
  cardFeePercent: 2,
  openApply: {
    signIn: `${OPENAPPLY}/parents/sign_in`,
    setPassword: `${OPENAPPLY}/parents/password/new`,
    applicantPage: (studentId: number) => `${OPENAPPLY}/dashboard/${studentId}`,
  },
  bankTransferDetails: [
    "Full name of the person making the payment",
    "Passport copy of the payer",
    "If paying through a company: full company details",
  ],
} as const;

/** The subject Finance asks families to use, pre-filled where the application already says it. */
export function paymentSubject(academicYear: string, childName: string, yearGroup: string | null) {
  return `Your Full Name – Registration Payment for Academic Year ${academicYear.replace("-", "–")} – Student: ${childName} – ${yearGroup ?? "Year ____"}`;
}
