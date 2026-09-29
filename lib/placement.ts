export const ACADEMIC_YEARS = ["2026-2027", "2027-2028"] as const;
export type AcademicYear = (typeof ACADEMIC_YEARS)[number];

const GROUPS = [
  "Nursery",
  "Reception",
  "Year 1",
  "Year 2",
  "Year 3",
  "Year 4",
  "Year 5",
  "Year 6",
  "Year 7",
  "Year 8",
  "Year 9",
  "Year 10",
  "Year 11",
  "Year 12",
  "Year 13",
] as const;

export type Placement = {
  group: (typeof GROUPS)[number];
  ageBand: string;
  ageOnSeptemberFirst: number;
  dateRange: string;
};

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDateOfBirth(dateOfBirth: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** Completed age on 1 September of the academic year's first year, or null for an invalid date. */
export function getAgeOnSeptemberFirst(dateOfBirth: string, academicYear: AcademicYear): number | null {
  const birth = parseDateOfBirth(dateOfBirth);
  if (!birth) return null;
  const academicStart = Number(academicYear.slice(0, 4));
  return academicStart - birth.year - (birth.month > 9 || (birth.month === 9 && birth.day > 1) ? 1 : 0);
}

/**
 * KSI placement uses 1 September–31 August cohorts. The result is a guide only;
 * admissions confirms final placement after reviewing the application.
 */
export function getSuggestedPlacement(
  dateOfBirth: string,
  academicYear: AcademicYear,
): Placement | null {
  const birth = parseDateOfBirth(dateOfBirth);
  if (!birth) return null;

  const academicStart = Number(academicYear.slice(0, 4));
  const cohortStart = birth.month >= 9 ? birth.year : birth.year - 1;
  const groupIndex = academicStart - cohortStart - 4;
  if (groupIndex < 0 || groupIndex >= GROUPS.length) return null;

  const lowerAge = groupIndex + 3;
  const ageOnSeptemberFirst = getAgeOnSeptemberFirst(dateOfBirth, academicYear) as number;
  return {
    group: GROUPS[groupIndex],
    ageBand: `${lowerAge}–${lowerAge + 1}`,
    ageOnSeptemberFirst,
    dateRange: `${isoDate(cohortStart, 9, 1)} to ${isoDate(cohortStart + 1, 8, 31)}`,
  };
}
