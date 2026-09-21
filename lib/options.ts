export const COUNTRY_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`.split(" ");

const fallbackNames: Record<string, string> = {
  ME: "Montenegro",
  XK: "Kosovo",
  GB: "United Kingdom",
  US: "United States",
};

export function getCountries() {
  const display = typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

  return COUNTRY_CODES.map((code) => ({
    code,
    name: fallbackNames[code] ?? display?.of(code) ?? code,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export const LANGUAGES = [
  "English",
  "Montenegrin",
  "Serbian",
  "Croatian",
  "Bosnian",
  "Albanian",
  "Russian",
  "Ukrainian",
  "German",
  "French",
  "Italian",
  "Spanish",
  "Turkish",
  "Arabic",
  "Mandarin Chinese",
  "Other / not listed",
] as const;

export const LEARNING_SUPPORT = [
  "No known learning support needs",
  "English as an Additional Language",
  "Literacy or dyslexia support",
  "Numeracy or dyscalculia support",
  "Attention or executive-function support",
  "Social communication support",
  "Speech and language support",
  "Gifted or advanced learning provision",
  "Other assessed support need",
] as const;

export const MEDICAL_NEEDS = [
  "No condition the school needs to plan for",
  "Allergy or anaphylaxis",
  "Asthma or breathing condition",
  "Diabetes",
  "Epilepsy or seizure condition",
  "Heart or circulation condition",
  "Mobility or physical access need",
  "Hearing support",
  "Vision support",
  "Emotional wellbeing support",
  "Other diagnosed condition",
] as const;
