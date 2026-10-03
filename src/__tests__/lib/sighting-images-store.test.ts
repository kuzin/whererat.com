/**
 * replaceSightingImages (sighting-edit-store.ts) against a recording fake
 * transaction client: approved submissions keep images in submission_images,
 * catalog sightings in their override (+ sighting_images mirror).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  liveRowCount: 1,
}));

vi.mock("@/lib/db", () => ({
  getDbPool: () => ({ query: vi.fn() }),
  withTransaction: async (fn: (client: { query: typeof h.clientQuery }) => unknown) =>
    fn({ query: h.clientQuery }),
}));

import { replaceSightingImages } from "@/lib/sighting-edit-store";

beforeEach(() => {
  h.liveRowCount = 1;
  h.clientQuery.mockReset();
  h.clientQuery.mockImplementation(async (sql: string) =>
    /^\s*select 1/i.test(sql) ? { rows: [], rowCount: h.liveRowCount } : { rows: [], rowCount: 1 },
  );
});

const calls = () => h.clientQuery.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));

const slots = [
  { url: "https://blob.example/a.jpg", alt: "Remy", positionX: 10, positionY: 20, zoom: 2 },
  { url: "https://blob.example/b.jpg" },
];

describe("replaceSightingImages — approved submission (queue- id)", () => {
  it("rewrites submission_images in order with framing defaults", async () => {
    expect(await replaceSightingImages("queue-sub-1", slots)).toBe(true);
    const log = calls();
    expect(log[0]!.sql).toMatch(/from submissions where id = \$1 and status = 'approved' for update/);
    expect(log[0]!.params).toEqual(["sub-1"]);
    expect(log[1]).toEqual({ sql: "delete from submission_images where submission_id = $1", params: ["sub-1"] });
    const inserts = log.filter((c) => /insert into submission_images/.test(c.sql));
    expect(inserts.map((c) => c.params)).toEqual([
      ["sub-1", "https://blob.example/a.jpg", "Remy", 0, 10, 20, 2],
      ["sub-1", "https://blob.example/b.jpg", null, 1, 50, 50, 1],
    ]);
  });

  it("touches only images: no status change, no review action, no override", async () => {
    await replaceSightingImages("queue-sub-1", slots);
    const sql = calls().map((c) => c.sql).join("\n");
    expect(sql).not.toMatch(/review_actions/);
    expect(sql).not.toMatch(/set status/i);
    expect(sql).not.toMatch(/sighting_overrides/);
  });

  it("an empty list removes every image", async () => {
    expect(await replaceSightingImages("queue-sub-1", [])).toBe(true);
    expect(calls().some((c) => /^delete from submission_images/.test(c.sql))).toBe(true);
    expect(calls().some((c) => /insert into/.test(c.sql))).toBe(false);
  });

  it("refuses a submission that is not approved (or does not exist) and writes nothing", async () => {
    h.liveRowCount = 0;
    expect(await replaceSightingImages("queue-sub-pending", slots)).toBe(false);
    expect(calls()).toHaveLength(1);
  });

  it("caps the carousel at five images", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ url: `/u${i}.png` }));
    await replaceSightingImages("queue-sub-1", seven);
    expect(calls().filter((c) => /insert into submission_images/.test(c.sql))).toHaveLength(5);
  });
});

describe("replaceSightingImages — catalog sighting", () => {
  it("merges images into the override (dropping legacy imageUrl/imageAlt) and mirrors sighting_images", async () => {
    expect(await replaceSightingImages("s-1", slots)).toBe(true);
    const log = calls();
    expect(log[0]!.sql).toMatch(/from sightings where id = \$1 and is_deleted = false for update/);
    const upsert = log.find((c) => /insert into sighting_overrides/.test(c.sql))!;
    expect(upsert.sql).toMatch(/sighting_overrides\.override - 'imageUrl' - 'imageAlt'\) \|\| excluded\.override/);
    expect(upsert.params![0]).toBe("s-1");
    expect(JSON.parse(String(upsert.params![1]))).toEqual({ images: slots });
    expect(log.some((c) => c.sql === "delete from sighting_images where sighting_id = $1")).toBe(true);
    expect(log.filter((c) => /insert into sighting_images/.test(c.sql)).map((c) => c.params)).toEqual([
      ["s-1", "https://blob.example/a.jpg", "Remy", 0, 10, 20, 2],
      ["s-1", "https://blob.example/b.jpg", null, 1, 50, 50, 1],
    ]);
  });

  it("refuses a soft-deleted or unknown sighting", async () => {
    h.liveRowCount = 0;
    expect(await replaceSightingImages("s-gone", slots)).toBe(false);
    expect(calls()).toHaveLength(1);
  });
});
