import { describe, it, expect } from "vitest";
import { isSafeToken, isValidSlug } from "@/lib/identifiers";

describe("isValidSlug", () => {
  it.each(["ratatouille-2007", "downton-abbey-2019", "a", "Life_2017", "x.y~z", "a".repeat(200)])("accepts %j", (v) =>
    expect(isValidSlug(v)).toBe(true),
  );
  it.each(["", "a".repeat(201), "a\u0000b", "\u0000", "a b", "a/b", "../etc", "a%00", "<script>", "ü", "��", "a\nb", undefined, null, 5])(
    "rejects %j",
    (v) => expect(isValidSlug(v)).toBe(false),
  );
});

describe("isSafeToken", () => {
  it.each(["a1b2c3", "unsub-token-1", "x".repeat(200), "0".repeat(64)])("accepts %j", (v) => expect(isSafeToken(v)).toBe(true));
  it.each(["", "x".repeat(201), "a\u0000b", "a b", "a\nb", "é", undefined, null, 5])("rejects %j", (v) =>
    expect(isSafeToken(v)).toBe(false),
  );
});
