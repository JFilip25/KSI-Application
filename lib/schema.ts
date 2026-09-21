import { z } from "zod";
import { ACADEMIC_YEARS } from "./placement";

const requiredText = z.string().trim().min(1, "Required").max(120);
const optionalText = z.string().trim().max(180).default("");

export const ChildSchema = z.object({
  id: z.string().uuid(),
  firstName: requiredText,
  lastName: requiredText,
  preferredName: optionalText,
  dateOfBirth: z.string().date(),
  gender: z.enum(["female", "male", "nonbinary", "prefer-not-to-say"]),
  nationality: z.string().length(2),
  currentSchool: optionalText,
  currentGrade: optionalText,
  entryTiming: z.enum(["start-of-year", "during-year"]),
  homeLanguage: requiredText,
  otherHomeLanguage: optionalText,
  englishLevel: z.enum(["fluent", "proficient", "developing", "beginner", "not-yet-assessed"]),
  learningNeeds: z.array(z.string()).min(1),
  learningPlan: z.enum(["none", "current-plan", "previous-plan", "assessment-in-progress"]),
  medicalNeeds: z.array(z.string()).min(1),
  medicalAction: z.enum(["none", "emergency-plan", "medication", "staff-training", "access-adjustment", "other"]),
  attendance: z.enum(["regular", "some-concern", "significant-concern"]),
  repeatedGrade: z.enum(["no", "yes"]),
  seriousDiscipline: z.enum(["no", "yes-current-school", "yes-previous-school"]),
  disclosureNote: z.string().trim().max(500).default(""),
});

export const ParentSchema = z.object({
  firstName: requiredText,
  lastName: requiredText,
  relationship: z.enum(["mother", "father", "step-parent", "legal-guardian", "other-guardian"]),
  email: z.string().trim().email(),
  mobile: z.string().trim().min(7).max(30),
  country: z.string().length(2),
});

export const ApplicationSchema = z.object({
  academicYear: z.enum(ACADEMIC_YEARS),
  children: z.array(ChildSchema).min(1).max(5),
  parent1: ParentSchema,
  familySituation: z.enum(["together", "separated", "divorced", "sole-parent", "widowed", "other"]),
  legalResponsibility: z.enum(["joint", "sole-parent-1", "restricted-parent-2", "parent-2-deceased", "parent-2-uncontactable"]),
  parent2: ParentSchema.optional(),
  parent2Consent: z.enum(["signing-now", "secure-request", "evidence-exception"]),
  courtRestrictions: z.enum(["none", "yes-admissions-follow-up"]),
  declarations: z.object({
    accuracy: z.literal(true),
    authority: z.literal(true),
    privacy: z.literal(true),
    googleEducation: z.literal(true),
    marketingConsent: z.enum(["yes", "no"]),
  }),
  applicationReference: z.string().uuid(),
  startedAt: z.number().int().positive(),
  website: z.string().max(0),
}).superRefine((value, ctx) => {
  if (value.legalResponsibility === "joint" && !value.parent2) {
    ctx.addIssue({ code: "custom", path: ["parent2"], message: "Second parent details are required for joint responsibility." });
  }
  if (value.parent2Consent === "evidence-exception" && value.legalResponsibility === "joint") {
    ctx.addIssue({ code: "custom", path: ["parent2Consent"], message: "Joint responsibility requires consent from both parents." });
  }
  value.children.forEach((child, index) => {
    if (child.homeLanguage === "Other / not listed" && !child.otherHomeLanguage) {
      ctx.addIssue({ code: "custom", path: ["children", index, "otherHomeLanguage"], message: "Enter the language." });
    }
  });
});

export type ApplicationData = z.infer<typeof ApplicationSchema>;
