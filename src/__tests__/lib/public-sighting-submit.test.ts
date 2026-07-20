import { describe, it, expect, vi, afterEach } from "vitest";

// Mock all external dependencies so we test only the core logic
vi.mock("@/lib/moderation-store", () => ({
  addSubmission: vi.fn().mockResolvedValue({ id: "sub-new" }),
}));
vi.mock("@/lib/movie-catalog", () => ({
  getCatalogMovieByImdbId: vi.fn().mockResolvedValue(null),
  getCatalogMovieByExactTitle: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/media-storage", () => ({
  persistSightingFiles: vi.fn().mockResolvedValue([]),
  parseSightingImageGalleryForm: vi.fn().mockResolvedValue([]),
  SIGHTING_GALLERY_FIELD_NAMES: {
    file: "sightingImageFile",
    url: "sightingImageUrl",
    alt: "sightingImageAlt",
    positionX: "sightingImagePositionX",
    positionY: "sightingImagePositionY",
    zoom: "sightingImageZoom",
  },
  SIGHTING_GALLERY_SENTINEL: "sightingImageListManaged",
}));

import {
  isPublicSubmissionRateLimited,
  executePublicSightingSubmit,
} from "@/lib/public-sighting-submit";
import { addSubmission } from "@/lib/moderation-store";
import { getCatalogMovieByImdbId } from "@/lib/movie-catalog";

const mockAddSubmission = vi.mocked(addSubmission);

// ────────────────────────────────────────────────────────────────────────────
// Rate-limiting
// ────────────────────────────────────────────────────────────────────────────

describe("isPublicSubmissionRateLimited", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to 5 requests from the same IP", () => {
    const ip = `test-ip-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(isPublicSubmissionRateLimited(ip)).toBe(false);
    }
  });

  it("blocks the 6th request from the same IP", () => {
    const ip = `test-ip-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      isPublicSubmissionRateLimited(ip);
    }
    expect(isPublicSubmissionRateLimited(ip)).toBe(true);
  });

  it("normalises empty IP to 'unknown'", () => {
    // Covers the `clientIp.trim() || "unknown"` fallback branch
    expect(isPublicSubmissionRateLimited("")).toBe(false);
    expect(isPublicSubmissionRateLimited("  ")).toBe(false);
  });

  it("treats different IPs independently", () => {
    const ip1 = `test-ip-${Math.random()}`;
    const ip2 = `test-ip-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      isPublicSubmissionRateLimited(ip1);
    }
    // ip1 is exhausted; ip2 still has capacity
    expect(isPublicSubmissionRateLimited(ip1)).toBe(true);
    expect(isPublicSubmissionRateLimited(ip2)).toBe(false);
  });

  it("resets after the window expires", () => {
    vi.useFakeTimers();
    const ip = `test-ip-${Math.random()}`;
    // Exhaust the quota
    for (let i = 0; i < 5; i++) {
      isPublicSubmissionRateLimited(ip);
    }
    expect(isPublicSubmissionRateLimited(ip)).toBe(true);

    // Advance past the 1-hour window
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(isPublicSubmissionRateLimited(ip)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// executePublicSightingSubmit — field validation
// ────────────────────────────────────────────────────────────────────────────

function makeValidFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.append("movieTitle", "Ratatouille");
  fd.append("imdbId", "tt0382932");
  fd.append("sightingTitle", "Rat in kitchen");
  fd.append("timestamp", "42%");
  fd.append("description", "Remy appears on the counter.");
  fd.append("submitterName", "Alice");
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

describe("executePublicSightingSubmit — validation", () => {
  it("succeeds with all required fields", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-ok" } as never);
    const result = await executePublicSightingSubmit(makeValidFormData(), "1.2.3.4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submissionId).toBe("sub-ok");
    }
  });

  it("returns missing error when movieTitle is absent", async () => {
    const fd = makeValidFormData({ movieTitle: "" });
    const result = await executePublicSightingSubmit(fd, "1.2.3.5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing");
  });

  it("returns missing error when sightingTitle is absent", async () => {
    const fd = makeValidFormData({ sightingTitle: "" });
    const result = await executePublicSightingSubmit(fd, "1.2.3.6");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing");
  });

  it("returns missing error when timestamp is absent", async () => {
    const fd = makeValidFormData({ timestamp: "" });
    const result = await executePublicSightingSubmit(fd, "1.2.3.7");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing");
  });

  it("returns no-imdb error when imdbId is absent", async () => {
    const fd = makeValidFormData({ imdbId: "" });
    const result = await executePublicSightingSubmit(fd, "1.2.3.8");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no-imdb");
  });

  it("returns missing error for series without season/episode", async () => {
    const fd = makeValidFormData({ imdbKind: "series" });
    fd.delete("seasonNumber");
    fd.delete("episodeNumber");
    const result = await executePublicSightingSubmit(fd, "1.2.3.9");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing");
  });

  it("succeeds for a series with valid season and episode", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-series" } as never);
    const fd = makeValidFormData({ imdbKind: "series" });
    fd.set("seasonNumber", "2");
    fd.set("episodeNumber", "5");
    const result = await executePublicSightingSubmit(fd, "1.2.3.10");
    expect(result.ok).toBe(true);
  });

  it("returns rate-limited when IP is exhausted", async () => {
    const ip = `exhaust-ip-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      isPublicSubmissionRateLimited(ip);
    }
    const result = await executePublicSightingSubmit(makeValidFormData(), ip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate-limited");
  });

  it("returns server-error when addSubmission throws", async () => {
    mockAddSubmission.mockRejectedValueOnce(new Error("DB down"));
    const fd = makeValidFormData();
    const result = await executePublicSightingSubmit(fd, "5.5.5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("server-error");
      expect(result.message).toContain("DB down");
    }
  });

  it("passes contentWarningOther to the submission", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-cw" } as never);
    const fd = makeValidFormData();
    fd.set("contentWarningOther", "Custom warning");
    const result = await executePublicSightingSubmit(fd, "1.2.3.100");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        contentWarnings: expect.arrayContaining(["Custom warning"]),
      }),
    );
  });

  it("passes rodentTypes to the submission", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-rt" } as never);
    const fd = makeValidFormData();
    fd.append("rodentTypes", "mouse");
    fd.append("rodentTypes", "rat");
    const result = await executePublicSightingSubmit(fd, "1.2.3.101");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        rodentTypes: expect.arrayContaining(["mouse", "rat"]),
      }),
    );
  });

  it("passes otherRodentLabel when 'other' is selected", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-other" } as never);
    const fd = makeValidFormData();
    fd.set("rodentTypes", "other");
    fd.set("otherRodentLabel", "capybara");
    const result = await executePublicSightingSubmit(fd, "1.2.3.110");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        rodentTypes: ["other"],
        otherRodentLabel: "capybara",
      }),
    );
  });

  it("rejects 'other' rodent type with no species label", async () => {
    mockAddSubmission.mockClear();
    const fd = makeValidFormData();
    fd.set("rodentTypes", "other");
    fd.set("otherRodentLabel", "   ");
    const result = await executePublicSightingSubmit(fd, "1.2.3.111");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing");
    expect(mockAddSubmission).not.toHaveBeenCalled();
  });

  it("ignores otherRodentLabel when 'other' is not selected", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-other-ignored" } as never);
    const fd = makeValidFormData();
    fd.set("rodentTypes", "mouse");
    fd.set("otherRodentLabel", "stowaway text");
    const result = await executePublicSightingSubmit(fd, "1.2.3.112");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        rodentTypes: ["mouse"],
        otherRodentLabel: undefined,
      }),
    );
  });

  it("strips invalid submitter email", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-email" } as never);
    const fd = makeValidFormData();
    fd.set("submitterEmail", "not-an-email");
    const result = await executePublicSightingSubmit(fd, "1.2.3.102");
    expect(result.ok).toBe(true);
    // Invalid email should be silently dropped (submitterEmail omitted from submission)
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        submitterEmail: undefined,
      }),
    );
  });

  it("accepts a valid submitter email", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-valid-email" } as never);
    const fd = makeValidFormData();
    fd.set("submitterEmail", "alice@example.com");
    const result = await executePublicSightingSubmit(fd, "1.2.3.103");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        submitterEmail: "alice@example.com",
      }),
    );
  });

  it("passes contentWarnings array items to submission", async () => {
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-cw2" } as never);
    const fd = makeValidFormData();
    fd.append("contentWarnings", "rat-dies");
    fd.append("contentWarnings", "jump-scare");
    const result = await executePublicSightingSubmit(fd, "1.2.3.105");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        contentWarnings: expect.arrayContaining(["rat-dies", "jump-scare"]),
      }),
    );
  });

  it("attaches uploaded images to the submission", async () => {
    const { persistSightingFiles } = await import("@/lib/media-storage");
    vi.mocked(persistSightingFiles).mockResolvedValueOnce([
      { url: "https://example.com/rat.jpg", alt: "Rat" },
    ] as never);
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-img" } as never);

    const fd = makeValidFormData();
    const file = new File(["image data"], "rat.jpg", { type: "image/jpeg" });
    fd.append("sightingImages", file);

    const result = await executePublicSightingSubmit(fd, "1.2.3.104");
    expect(result.ok).toBe(true);
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "https://example.com/rat.jpg",
      }),
    );
  });

  it("includes catalog match hint when movie already exists in catalog", async () => {
    vi.mocked(getCatalogMovieByImdbId).mockResolvedValueOnce({
      id: "movie-tt0382932",
      slug: "ratatouille",
      title: "Ratatouille",
      posterUrl: "https://example.com/poster.jpg",
    } as never);
    mockAddSubmission.mockResolvedValueOnce({ id: "sub-match" } as never);

    const fd = makeValidFormData();
    const result = await executePublicSightingSubmit(fd, "1.2.3.106");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.catalogMatchSlug).toBe("ratatouille");
    expect(mockAddSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        duplicateHint: expect.stringContaining("Ratatouille"),
      }),
    );
  });
});
