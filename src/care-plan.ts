export interface EpicCarePlanSearchType {
  readonly category: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Epic routes CarePlan searches by one required category token. Keep the
 * patient-facing labels and the server-side allowlist sourced from this single
 * catalog so a UI option can never submit a category the connector rejects.
 */
export const EPIC_CARE_PLAN_SEARCH_TYPES = [
  {
    category: "38717003",
    label: "Longitudinal",
    description: "ongoing care plan",
  },
  {
    category: "734163000",
    label: "Encounter-level",
    description: "visit assessment and plan",
  },
  {
    category: "736271009",
    label: "Outpatient",
    description: "ambulatory care plan",
  },
  {
    category: "738906000",
    label: "Dental",
    description: "dental treatment plan",
  },
  {
    category: "assess-plan",
    label: "Outside record",
    description: "imported assessment and plan",
  },
] as const satisfies readonly EpicCarePlanSearchType[];

const epicCarePlanSearchCategories = new Set<string>(
  EPIC_CARE_PLAN_SEARCH_TYPES.map(({ category }) => category),
);

export function isEpicCarePlanSearchCategory(category: string): boolean {
  return epicCarePlanSearchCategories.has(category);
}
