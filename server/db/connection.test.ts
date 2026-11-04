import { describe, expect, it } from "vitest";
import { assertNarisDatabaseUrl } from "./connection";

describe("database target safety", () => {
  it("accepts only the dedicated naris_ops database", () => {
    expect(assertNarisDatabaseUrl("postgresql://app:secret@localhost:5432/naris_ops"))
      .toBe("postgresql://app:secret@localhost:5432/naris_ops");
  });

  it("refuses the existing marketing database before connecting", () => {
    expect(() => assertNarisDatabaseUrl("postgresql://app:secret@localhost:5432/marketing_ops"))
      .toThrow(/expected database 'naris_ops'/);
  });

  it("refuses the Evolution database before connecting", () => {
    expect(() => assertNarisDatabaseUrl("postgresql://app:secret@localhost:5432/evolution"))
      .toThrow(/expected database 'naris_ops'/);
  });

  it("rejects missing or malformed connection strings", () => {
    expect(() => assertNarisDatabaseUrl(undefined)).toThrow(/required/);
    expect(() => assertNarisDatabaseUrl("not-a-url")).toThrow(/valid PostgreSQL/);
  });
});
