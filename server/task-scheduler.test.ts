import { describe, expect, it } from "vitest";
import { isTaskGenerationEnabled } from "./task-scheduler";

describe("daily task scheduler configuration", () => {
  it("defaults to enabled after deployment when the variable is omitted", () => {
    expect(isTaskGenerationEnabled(undefined)).toBe(true);
    expect(isTaskGenerationEnabled("")).toBe(true);
    expect(isTaskGenerationEnabled("   ")).toBe(true);
  });

  it("can be explicitly disabled during import or maintenance", () => {
    expect(isTaskGenerationEnabled("false")).toBe(false);
    expect(isTaskGenerationEnabled(" FALSE ")).toBe(false);
  });

  it("requires an explicit true for non-empty values", () => {
    expect(isTaskGenerationEnabled("true")).toBe(true);
    expect(isTaskGenerationEnabled("TRUE")).toBe(true);
    expect(isTaskGenerationEnabled("0")).toBe(false);
    expect(isTaskGenerationEnabled("yes")).toBe(false);
  });
});
