#!/usr/bin/env node
// Builds lib/openapply/data/{countries,languages}.ts from the KSI OpenApply tenant's option lists
// (scripts/openapply-tenant-snapshot.json). OpenApply stores countries, nationalities and languages
// as option IDs, so every value the form can produce must resolve to an exact tenant option.
//
//   node scripts/generate-openapply-data.mjs
//
// The output is committed on purpose: region names from Intl change between ICU releases
// ("Turkey" → "Türkiye"), and the mapping must stay stable at runtime.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(readFileSync(join(root, "scripts/openapply-tenant-snapshot.json"), "utf8"));
const codes = readFileSync(join(root, "lib/options.ts"), "utf8").match(/COUNTRY_CODES = `([^`]*)`/)[1].split(" ");

// ISO codes whose English (Intl) name differs from the tenant's country name.
const COUNTRY_OVERRIDES = {
  AG: "Antigua and Barbuda", AX: "Aland Islands", BA: "Bosnia and Herzegovina", BL: "Saint Barthelemy",
  BN: "Brunei Darussalam", BQ: "Bonaire, Sint Eustatius and Saba", CD: "Congo, Democratic Republic of the",
  CG: "Congo", CI: "Cote D'Ivoire", CW: "Curacao", CZ: "Czech Republic", FK: "Falkland Islands (Malvinas)",
  FM: "Micronesia, Federated States of", GS: "South Georgia and the South Sandwich Islands",
  HK: "China (Hong Kong)", HM: "Heard Island and McDonald Islands", KN: "Saint Kitts And Nevis",
  LC: "Saint Lucia", MF: "Saint Martin (French part)", MM: "Myanmar", MO: "China (Macao)",
  PM: "Saint Pierre And Miquelon", PN: "Pitcairn", PS: "Palestine", RE: "Reunion", RU: "Russian Federation",
  SH: "Saint Helena", SJ: "Svalbard And Jan Mayen", ST: "Sao Tome and Principe", SX: "Sint Maarten (Dutch part)",
  SY: "Syrian Arab Republic", TC: "Turks and Caicos Islands", TR: "Turkey", TT: "Trinidad and Tobago",
  TW: "Taiwan, China", UM: "United States Minor Outlying Islands", VC: "Saint Vincent And The Grenadines",
  VG: "Virgin Islands, British", VI: "Virgin Islands, U.S.", WF: "Wallis and Futuna",
};

// Nationality options normally share the country option's ID; these do not.
const NATIONALITY_OVERRIDES = {
  AQ: "Antarctica", AX: "Finnish (Aland Islands)", BQ: "Dutch (Bonaire, Sint Eustatius and Saba)",
  BV: "Bouvet Island", CD: "Congolese (Congo, The Democratic Republic Of The)", CW: "Dutch (Curacao)",
  DO: "Dominican (Dominican Republic)", GF: "French Guiana", IO: "Indian (British Indian Ocean Territory)",
  JE: "Channel Islander (Jersey)", MF: "Saint Martin Islander", MP: "American (Northern Mariana Islands)",
  MQ: "French (Martinique)", NG: "Nigerian (Nigeria)", PM: "French (Saint Pierre And Miquelon)",
  SJ: "Norwegian (Svalbard And Jan Mayen)", SS: "South Sudanese", SX: "Dutch (Sint Maarten)",
  TF: "French (French Southern Territories)", UM: "American (United States Minor Outlying Islands)",
  VA: "Italian (Holy See (Vatican City State))", VG: "Virgin Islander (Virgin Islands, British)",
  YT: "French (Mayotte)",
};

export const normalize = (value) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryByName = new Map(snapshot.countries.map(([id, name]) => [normalize(name), { id, name }]));
const nationalityById = new Map(snapshot.nationalities.map(([id, name]) => [id, name]));
const nationalityByName = new Map(snapshot.nationalities.map(([id, name]) => [name, id]));

const problems = [];
const usedCountryIds = new Map();
const countries = {};
for (const code of codes) {
  const name = COUNTRY_OVERRIDES[code] ?? regionNames.of(code);
  const country = countryByName.get(normalize(name));
  if (!country) {
    problems.push(`${code}: no tenant country named "${name}"`);
    continue;
  }
  if (usedCountryIds.has(country.id)) problems.push(`${code}: country ${country.id} already used by ${usedCountryIds.get(country.id)}`);
  usedCountryIds.set(country.id, code);

  let nationalityId = null;
  if (NATIONALITY_OVERRIDES[code]) {
    nationalityId = nationalityByName.get(NATIONALITY_OVERRIDES[code]) ?? null;
    if (nationalityId === null) problems.push(`${code}: no tenant nationality named "${NATIONALITY_OVERRIDES[code]}"`);
  } else if (nationalityById.has(country.id)) {
    nationalityId = country.id;
  } else {
    problems.push(`${code}: no nationality option shares country ID ${country.id}; add an override`);
  }
  countries[code] = {
    countryId: country.id,
    country: country.name,
    nationalityId,
    nationality: nationalityId === null ? null : nationalityById.get(nationalityId),
  };
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const languages = Object.fromEntries(
  [...snapshot.languages]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => [normalize(name), { id, name }]),
);

const header = "// Generated by scripts/generate-openapply-data.mjs from the KSI OpenApply tenant's option lists. Do not edit by hand.\n";
writeFileSync(
  join(root, "lib/openapply/data/countries.ts"),
  `${header}\nexport type OpenApplyCountry = {\n  countryId: number;\n  country: string;\n  nationalityId: number | null;\n  nationality: string | null;\n};\n\nexport const OPENAPPLY_COUNTRIES: Record<string, OpenApplyCountry> = {\n${Object.entries(countries)
    .map(([code, value]) => `  ${code}: ${JSON.stringify(value)},`)
    .join("\n")}\n};\n`,
);
writeFileSync(
  join(root, "lib/openapply/data/languages.ts"),
  `${header}\n/** Keyed by normalized language name (lowercase, no diacritics, single spaces). */\nexport const OPENAPPLY_LANGUAGES: Record<string, { id: number; name: string }> = {\n${Object.entries(languages)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n")}\n};\n`,
);
console.log(`countries: ${Object.keys(countries).length}, languages: ${Object.keys(languages).length}`);
