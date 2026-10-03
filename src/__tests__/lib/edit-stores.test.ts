/**
 * movie-edit-store.ts + sighting-edit-store.ts against a recording fake pool.
 * Asserts the SQL shape (parameterised, soft-delete) and parameter mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
const invalidate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDbPool: () => ({ query }) }));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: invalidate }));

import {
  getMovieOverride,
  applyMovieOverride,
  updateMovieOverride,
  clearMovieOverride,
  getDeletedMovieIds,
  deleteMovieById,
} from "@/lib/movie-edit-store";
import {
  getSightingOverrides,
  getDeletedSightingIds,
  updateSightingOverride,
  deleteSightingById,
} from "@/lib/sighting-edit-store";
import type { Movie } from "@/lib/whererat";

beforeEach(() => {
  invalidate.mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

const baseMovie = {
  id: "m1",
  title: "Ratatouille",
  releaseYear: 2007,
  metadata: { rating: "G", tagline: "t", director: "d" },
} as unknown as Movie;

describe("movie-edit-store", () => {
  describe("getMovieOverride", () => {
    it("returns the stored override via a parameterised query", async () => {
      query.mockResolvedValue({ rows: [{ override: { title: "X" } }] });
      expect(await getMovieOverride("m1")).toEqual({ title: "X" });
      expect(query.mock.calls[0]![1]).toEqual(["m1"]);
      expect(String(query.mock.calls[0]![0])).toContain("$1");
    });

    it("returns undefined when none exists", async () => {
      expect(await getMovieOverride("m1")).toBeUndefined();
    });
  });

  describe("applyMovieOverride", () => {
    it("returns the movie untouched when there is no override", () => {
      expect(applyMovieOverride(baseMovie, undefined)).toBe(baseMovie);
    });

    it("shallow-merges fields and deep-merges metadata", () => {
      const out = applyMovieOverride(baseMovie, {
        title: "New",
        metadata: { rating: "PG" } as Movie["metadata"],
      });
      expect(out.title).toBe("New");
      expect(out.releaseYear).toBe(2007);
      expect(out.metadata).toMatchObject({ rating: "PG", tagline: "t", director: "d" });
    });

    it("does not mutate its inputs", () => {
      const override = { title: "New", metadata: { rating: "PG" } as Movie["metadata"] };
      const before = JSON.stringify(baseMovie);
      applyMovieOverride(baseMovie, override);
      expect(JSON.stringify(baseMovie)).toBe(before);
      expect(override.metadata).toEqual({ rating: "PG" });
    });

    it("an override without metadata keeps the original metadata", () => {
      expect(applyMovieOverride(baseMovie, { title: "N" }).metadata).toEqual(baseMovie.metadata);
    });

    it("an empty override is a no-op copy", () => {
      expect(applyMovieOverride(baseMovie, {})).toEqual(baseMovie);
    });
  });

  describe("updateMovieOverride", () => {
    it("upserts the override then writes through to the movies row, in that order", async () => {
      await updateMovieOverride("m1", {
        title: "T",
        releaseYear: 2020,
        runtimeMinutes: 90,
        genres: ["Horror"],
        posterTone: "bg-x",
        posterUrl: "/p",
        backdropUrl: "/b",
        posterAlt: "alt",
        summary: "s",
        metadata: { rating: "R" } as Movie["metadata"],
      });
      expect(query).toHaveBeenCalledTimes(2);
      const [upsertSql, upsertParams] = query.mock.calls[0]!;
      expect(String(upsertSql)).toMatch(/insert into movie_overrides/i);
      expect(String(upsertSql)).toMatch(/on conflict \(movie_id\)/i);
      expect(upsertParams[0]).toBe("m1");
      const [updateSql, updateParams] = query.mock.calls[1]!;
      expect(String(updateSql)).toMatch(/update movies/i);
      expect(String(updateSql)).toMatch(/where id = \$1/i);
      expect(updateParams).toEqual([
        "m1", "T", 2020, 90, ["Horror"], "bg-x", "/p", "/b", "alt", "s", { rating: "R" },
      ]);
    });

    it("passes null for absent fields so coalesce() keeps the current column value", async () => {
      await updateMovieOverride("m1", { title: "Only" });
      expect(query.mock.calls[1]![1]).toEqual(["m1", "Only", null, null, null, null, null, null, null, null, null]);
    });

    it("metadata is merged (||), never replaced, in SQL", async () => {
      await updateMovieOverride("m1", { metadata: { rating: "R" } as Movie["metadata"] });
      expect(String(query.mock.calls[1]![0])).toMatch(/metadata \|\| \$11::jsonb/);
    });

    it("never interpolates values into SQL", async () => {
      await updateMovieOverride("m1'; drop table movies;--", { title: "x'); drop table movies;--" });
      for (const [sql] of query.mock.calls) expect(String(sql)).not.toMatch(/drop table/i);
    });

    it("an explicit year of 0 / empty title are NOT swallowed by the null-coalescing (documents ?? semantics)", async () => {
      await updateMovieOverride("m1", { releaseYear: 0, title: "" });
      expect(query.mock.calls[1]![1].slice(1, 3)).toEqual(["", 0]);
    });

    it("propagates failures and does not run the second statement after the first fails", async () => {
      query.mockRejectedValueOnce(new Error("db down"));
      await expect(updateMovieOverride("m1", { title: "x" })).rejects.toThrow("db down");
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  it("clearMovieOverride deletes the override row", async () => {
    await clearMovieOverride("m1");
    expect(String(query.mock.calls[0]![0])).toMatch(/delete from movie_overrides where movie_id = \$1/i);
    expect(query.mock.calls[0]![1]).toEqual(["m1"]);
  });

  it("getDeletedMovieIds returns a Set of soft-deleted ids", async () => {
    query.mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }, { id: "a" }] });
    const ids = await getDeletedMovieIds();
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(["a", "b"]);
    expect(String(query.mock.calls[0]![0])).toMatch(/is_deleted = true/);
  });

  it("deleteMovieById clears overrides and soft-deletes (never hard-deletes the movie)", async () => {
    await deleteMovieById("m1");
    const sqls = query.mock.calls.map(([s]) => String(s).toLowerCase());
    expect(sqls[0]).toContain("delete from movie_overrides");
    expect(sqls[1]).toMatch(/update movies\s+set is_deleted = true/);
    expect(sqls.some((s) => /delete from movies\b/.test(s))).toBe(false);
    expect(query.mock.calls[1]![1]).toEqual(["m1"]);
  });
});

describe("sighting-edit-store", () => {
  it("getSightingOverrides returns an id -> override map", async () => {
    query.mockResolvedValue({
      rows: [
        { sighting_id: "s1", override: { title: "A" } },
        { sighting_id: "s2", override: { spoiler: true } },
      ],
    });
    expect(await getSightingOverrides()).toEqual({ s1: { title: "A" }, s2: { spoiler: true } });
  });

  it("getSightingOverrides is {} when empty", async () => {
    expect(await getSightingOverrides()).toEqual({});
  });

  it("getDeletedSightingIds returns a Set of soft-deleted ids", async () => {
    query.mockResolvedValue({ rows: [{ id: "s1" }] });
    expect([...(await getDeletedSightingIds())]).toEqual(["s1"]);
    expect(String(query.mock.calls[0]![0])).toMatch(/is_deleted = true/);
  });

  describe("updateSightingOverride", () => {
    it("upserts the override then updates the sighting row with positional params", async () => {
      await updateSightingOverride("s1", {
        timestamp: "42%",
        title: "T",
        description: "D",
        spoiler: false,
        curatorNote: "cn",
        approximateRatCount: 4,
        contentWarnings: ["gore"],
        rodentTypes: ["mouse"],
        otherRodentLabel: "vole",
      });
      expect(query).toHaveBeenCalledTimes(2);
      expect(String(query.mock.calls[0]![0])).toMatch(/insert into sighting_overrides/i);
      expect(query.mock.calls[1]![1]).toEqual([
        "s1", "42%", "T", "D", false, "cn", 4, ["gore"], ["mouse"], "vole",
      ]);
    });

    it("spoiler: false is preserved (not coalesced away); non-boolean becomes null", async () => {
      await updateSightingOverride("s1", { spoiler: false });
      expect(query.mock.calls[1]![1][4]).toBe(false);
      query.mockClear();
      await updateSightingOverride("s1", { spoiler: "yes" as unknown as boolean });
      expect(query.mock.calls[1]![1][4]).toBeNull();
    });

    it("absent fields are null so existing column values are kept", async () => {
      await updateSightingOverride("s1", {});
      expect(query.mock.calls[1]![1]).toEqual(["s1", null, null, null, null, null, null, null, null, null]);
    });

    it("array columns are replaced wholesale only when supplied", async () => {
      await updateSightingOverride("s1", { rodentTypes: [] });
      const sql = String(query.mock.calls[1]![0]);
      expect(sql).toMatch(/rodent_types = case when \$9::text\[\] is not null then \$9 else rodent_types end/);
      expect(query.mock.calls[1]![1][8]).toEqual([]);
    });

    it("replaces the whole image gallery when `images` is given, preserving order and defaults", async () => {
      await updateSightingOverride("s1", {
        images: [
          { url: "/a.png", alt: "A", positionX: 10, positionY: 20, zoom: 2 },
          { url: "/b.png" },
        ],
      });
      const sqls = query.mock.calls.map(([s]) => String(s).toLowerCase());
      expect(sqls[2]).toContain("delete from sighting_images");
      expect(sqls[3]).toContain("insert into sighting_images");
      expect(query.mock.calls[3]![1]).toEqual(["s1", "/a.png", "A", 0, 10, 20, 2]);
      expect(query.mock.calls[4]![1]).toEqual(["s1", "/b.png", null, 1, 50, 50, 1]);
    });

    it("an empty `images` array clears the gallery", async () => {
      await updateSightingOverride("s1", { images: [] });
      const sqls = query.mock.calls.map(([s]) => String(s).toLowerCase());
      expect(sqls.some((s) => s.includes("delete from sighting_images"))).toBe(true);
      expect(sqls.some((s) => s.includes("insert into sighting_images"))).toBe(false);
    });

    it("a lone imageUrl upserts slot 0 (and is ignored when images are provided)", async () => {
      await updateSightingOverride("s1", { imageUrl: "/solo.png", imageAlt: "solo" });
      const last = query.mock.calls.at(-1)!;
      expect(String(last[0])).toMatch(/on conflict \(sighting_id, sort_order\)/);
      expect(last[1]).toEqual(["s1", "/solo.png", "solo"]);

      query.mockClear();
      await updateSightingOverride("s1", { imageUrl: "/solo.png", images: [{ url: "/x.png" }] });
      const inserts = query.mock.calls.filter(([s]) => /insert into sighting_images/i.test(String(s)));
      expect(inserts).toHaveLength(1);
      expect(inserts[0]![1][1]).toBe("/x.png");
    });

    it("makes no image queries when neither images nor imageUrl is set", async () => {
      await updateSightingOverride("s1", { title: "x" });
      expect(query).toHaveBeenCalledTimes(2);
    });

    it("keeps hostile strings out of the SQL text", async () => {
      await updateSightingOverride("s1'; drop table sightings;--", {
        title: "x'; drop table sightings;--",
        images: [{ url: "/'; drop table sighting_images;--" }],
      });
      for (const [sql] of query.mock.calls) expect(String(sql)).not.toMatch(/drop table/i);
    });

    it("propagates DB errors", async () => {
      query.mockRejectedValueOnce(new Error("down"));
      await expect(updateSightingOverride("s1", { title: "x" })).rejects.toThrow("down");
    });
  });

  it("deleteSightingById clears overrides then soft-deletes", async () => {
    await deleteSightingById("s1");
    const sqls = query.mock.calls.map(([s]) => String(s).toLowerCase());
    expect(sqls[0]).toContain("delete from sighting_overrides");
    expect(sqls[1]).toMatch(/update sightings set is_deleted = true/);
    expect(sqls.some((s) => /delete from sightings\b/.test(s))).toBe(false);
    expect(query.mock.calls[1]![1]).toEqual(["s1"]);
  });
});

describe("catalog cache invalidation", () => {
  it("updating a movie override expires the cache after the movie row is rewritten", async () => {
    await updateMovieOverride("m1", { title: "New" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    // ...and only after both statements ran, so the next read sees the new row.
    expect(invalidate.mock.invocationCallOrder[0]!).toBeGreaterThan(query.mock.invocationCallOrder.at(-1)!);
  });

  it("deleting a movie expires the cache", async () => {
    await deleteMovieById("m1");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("updating or deleting a sighting expires the cache", async () => {
    await updateSightingOverride("s1", { description: "x" });
    await deleteSightingById("s1");
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("reads and override clearing leave the cache alone (the movies row is unchanged)", async () => {
    await getMovieOverride("m1");
    await getDeletedMovieIds();
    await clearMovieOverride("m1");
    await getSightingOverrides();
    await getDeletedSightingIds();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("a failed write does not expire it", async () => {
    query.mockRejectedValueOnce(new Error("db down"));
    await expect(deleteMovieById("m1")).rejects.toThrow("db down");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
