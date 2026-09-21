import { describe, expect, it } from "vitest";
import { getSuggestedPlacement } from "../lib/placement";

describe("getSuggestedPlacement", () => {
  it("uses the September cutoff for 2026–27", () => {
    expect(getSuggestedPlacement("2022-09-01", "2026-2027")?.group).toBe("Nursery");
    expect(getSuggestedPlacement("2022-08-31", "2026-2027")?.group).toBe("Reception");
  });

  it("advances the same child one group for 2027–28", () => {
    expect(getSuggestedPlacement("2018-10-12", "2026-2027")?.group).toBe("Year 3");
    expect(getSuggestedPlacement("2018-10-12", "2027-2028")?.group).toBe("Year 4");
    expect(getSuggestedPlacement("2018-10-12", "2027-2028")?.ageOnSeptemberFirst).toBe(8);
  });

  it("shows completed age on 1 September of the application year", () => {
    expect(getSuggestedPlacement("2018-09-01", "2027-2028")?.ageOnSeptemberFirst).toBe(9);
    expect(getSuggestedPlacement("2018-09-02", "2027-2028")?.ageOnSeptemberFirst).toBe(8);
    expect(getSuggestedPlacement("2018-08-31", "2027-2028")?.ageOnSeptemberFirst).toBe(9);
  });

  it("matches the youngest and oldest listed ranges", () => {
    expect(getSuggestedPlacement("2023-08-31", "2026-2027")?.group).toBe("Nursery");
    expect(getSuggestedPlacement("2008-09-01", "2026-2027")?.group).toBe("Year 13");
  });

  it("returns null outside the supplied placement table", () => {
    expect(getSuggestedPlacement("2024-09-01", "2026-2027")).toBeNull();
    expect(getSuggestedPlacement("2008-08-31", "2026-2027")).toBeNull();
  });
});
