"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  MODERATOR_SESSION_COOKIE,
} from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import {
  clampApproximateRatCount,
  normalizeSightingTimestampInput,
  getMoviePath,
  type ImdbReview,
  type SightingImageSlot,
} from "@/lib/whererat";
import {
  clearMovieOverride,
  deleteMovieById,
  updateMovieOverride,
} from "@/lib/movie-edit-store";
import { fetchImdbMedia, fetchImdbRelated } from "@/lib/movie-imdb-sync";
import { reviewSubmission } from "@/lib/moderation-store";
import { parseMovieIdentityEdits } from "@/lib/movie-identity-form";
import {
  SUBMISSION_LIMITS,
  cleanContentWarnings,
  cleanRodentTypes,
  cleanText,
  safeReturnTo,
} from "@/lib/submission-input";
import { deleteSightingById, updateSightingOverride } from "@/lib/sighting-edit-store";
import { getCatalogMovieByImdbId, getCatalogMovieBySlug } from "@/lib/movie-catalog";
import {
  persistSightingFiles,
  parseSightingImageGalleryForm,
  SIGHTING_GALLERY_FIELD_NAMES,
  SIGHTING_GALLERY_SENTINEL,
} from "@/lib/media-storage";
import { getSyncedMoviePageVisuals } from "@/lib/movie-page-visuals";
import { getTmdbBackdropUrl } from "@/lib/tmdb-banner";

const MAX_SIGHTING_UPLOAD_BYTES = 8 * 1024 * 1024;
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

async function requireModerator() {
  const cookieStore = await cookies();
  const session = await verifyModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );
  if (!session) {
    redirect("/login");
  }
  return session;
}

async function persistSightingUploads(formData: FormData): Promise<SightingImageSlot[]> {
  const raw = formData.getAll("sightingImages");
  const files = raw.filter((e): e is File => e instanceof File && e.size > 0);
  const capped = files.slice(0, 5);
  if (!capped.length) return [];
  return persistSightingFiles(capped, MAX_SIGHTING_UPLOAD_BYTES);
}

export async function updateMovieInfo(formData: FormData) {
  await requireModerator();

  const slug = String(formData.get("slug") ?? "").trim();
  const movie = await getCatalogMovieBySlug(slug);
  if (!movie) redirect("/#catalog");

  const genresRaw = String(formData.get("genres") ?? "").trim();
  const countriesRaw = String(formData.get("countries") ?? "").trim();
  const overrideAccentRaw = String(formData.get("overrideAccent") ?? "").trim();
  // Use null (not undefined) when clearing so the JSONB merge actually overwrites the stored value.
  const overrideAccent: string | null = overrideAccentRaw && HEX_COLOR_RE.test(overrideAccentRaw)
    ? (overrideAccentRaw.startsWith("#") ? overrideAccentRaw.toLowerCase() : `#${overrideAccentRaw.toLowerCase()}`)
    : null;

  await updateMovieOverride(movie.id, {
    title: String(formData.get("title") ?? "").trim() || movie.title,
    releaseYear: Number(formData.get("releaseYear") ?? movie.releaseYear),
    runtimeMinutes: Number(formData.get("runtimeMinutes") ?? movie.runtimeMinutes),
    summary: String(formData.get("summary") ?? "").trim() || movie.summary,
    posterUrl: String(formData.get("posterUrl") ?? "").trim() || movie.posterUrl,
    genres: genresRaw
      ? genresRaw.split(",").map((item) => item.trim()).filter(Boolean)
      : movie.genres,
    metadata: {
      ...movie.metadata,
      tagline: String(formData.get("tagline") ?? "").trim(),
      rating: String(formData.get("rating") ?? "").trim(),
      director: String(formData.get("director") ?? "").trim(),
      writers: String(formData.get("writers") ?? "").trim(),
      cast: String(formData.get("cast") ?? "").trim(),
      imdbRating: String(formData.get("imdbRating") ?? "").trim(),
      imdbVotes: String(formData.get("imdbVotes") ?? "").trim(),
      metascore: String(formData.get("metascore") ?? "").trim(),
      awards: String(formData.get("awards") ?? "").trim(),
      originalLanguage: String(formData.get("originalLanguage") ?? "").trim(),
      productionCountries: countriesRaw
        ? countriesRaw.split(",").map((item) => item.trim()).filter(Boolean)
        : movie.metadata.productionCountries,
      overrideAccent,
      pagePalette: undefined,
      pagePaletteDark: undefined,
    },
  });

  revalidatePath(`/movies/${slug}`);
  revalidatePath(`/shows/${slug}`);
  revalidatePath("/moderation");
  redirect(`${getMoviePath(movie)}?toast=movie-saved`);
}

type RatFactsResult =
  | { status: "http-error"; httpStatus: number }
  | { status: "api-error" }
  | { status: "no-edges" }
  | { status: "no-rat-facts"; totalTrivia: number }
  | { status: "found"; facts: string[]; totalTrivia: number };

/** Fetch IMDb trivia and classify the result for toast feedback. */
async function fetchRatFacts(imdbId: string): Promise<RatFactsResult> {
  const IMDB_GRAPHQL_URL = "https://api.graphql.imdb.com/";
  const query = `
    query {
      title(id: "${imdbId}") {
        trivia(first: 50) {
          edges {
            node {
              id
              displayableArticle { body { plaidHtml } }
            }
          }
        }
      }
    }
  `;
  let res: Response;
  try {
    res = await fetch(IMDB_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: "http-error", httpStatus: 0 };
  }
  if (!res.ok) return { status: "http-error", httpStatus: res.status };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json()) as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edges: any[] = json?.data?.title?.trivia?.edges ?? [];
  if (!edges.length) {
    if (!json?.data?.title) return { status: "api-error" };
    return { status: "no-edges" };
  }

  const facts: string[] = [];
  for (const edge of edges) {
    if (facts.length >= 3) break;
    const raw: string = edge?.node?.displayableArticle?.body?.plaidHtml ?? "";
    if (!raw) continue;
    const plain = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (plain && /\brat(s|ty|like|proof|infested|catcher)?\b/i.test(plain)) facts.push(plain);
  }
  if (!facts.length) return { status: "no-rat-facts", totalTrivia: edges.length };
  return { status: "found", facts, totalTrivia: edges.length };
}

/** Fetch up to 20 IMDb user reviews. Returns an empty array on any failure. */
async function fetchReviewsForResync(imdbId: string): Promise<ImdbReview[]> {
  const IMDB_GRAPHQL_URL = "https://api.graphql.imdb.com/";
  const query = `
    query {
      title(id: "${imdbId}") {
        reviews(first: 20) {
          edges {
            node {
              id
              author { nickName }
              summary { originalText }
              text { originalText { plainText } }
              authorRating
              submissionDate
            }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(IMDB_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json()) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edges: any[] = json?.data?.title?.reviews?.edges ?? [];
    const reviews: ImdbReview[] = [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const summary = String(node.summary?.originalText ?? "").replace(/<[^>]*>/g, " ").trim();
      const text = String(node.text?.originalText?.plainText ?? "").replace(/<[^>]*>/g, " ").trim();
      if (!summary && !text) continue;
      const combined = `${summary} ${text}`;
      const mentionsRat = /\brat(s|ty|like|proof|infested|catcher)?\b/i.test(combined);
      const ratingRaw = node.authorRating;
      reviews.push({
        id: String(node.id ?? reviews.length),
        author: String(node.author?.nickName ?? "Anonymous"),
        summary,
        text,
        rating: typeof ratingRaw === "number" ? ratingRaw : undefined,
        date: String(node.submissionDate ?? ""),
        mentionsRat,
      });
    }
    return reviews.sort((a, b) => Number(b.mentionsRat) - Number(a.mentionsRat));
  } catch {
    return [];
  }
}

type OmdbFullDetails = {
  Title: string;
  Year: string;
  Type?: string;
  totalSeasons?: string;
  TotalSeasons?: string;
  Rated?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Writer?: string;
  Actors?: string;
  Plot?: string;
  Language?: string;
  Country?: string;
  Awards?: string;
  Poster?: string;
  Metascore?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Response: "True" | "False";
};

type OmdbSeasonDetails = {
  Response: "True" | "False";
  Episodes?: Array<{ Episode?: string }>;
};

async function fetchOmdbTotalEpisodeCount(params: {
  imdbId: string;
  apiKey: string;
  totalSeasonsRaw?: string;
}): Promise<number | undefined> {
  const totalSeasons = Number.parseInt(params.totalSeasonsRaw ?? "", 10);
  if (!Number.isFinite(totalSeasons) || totalSeasons < 1) return undefined;
  const cappedSeasons = Math.min(200, totalSeasons);
  let totalEpisodes = 0;

  for (let season = 1; season <= cappedSeasons; season++) {
    try {
      const url = new URL("https://www.omdbapi.com/");
      url.searchParams.set("apikey", params.apiKey);
      url.searchParams.set("i", params.imdbId);
      url.searchParams.set("Season", String(season));
      const res = await fetch(url.toString(), {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as OmdbSeasonDetails;
      if (json.Response !== "True") continue;
      totalEpisodes += Array.isArray(json.Episodes) ? json.Episodes.length : 0;
    } catch {
      // Best-effort aggregation: ignore per-season failures.
    }
  }

  return totalEpisodes > 0 ? totalEpisodes : undefined;
}

export async function resyncMovieFromImdb(formData: FormData) {
  await requireModerator();
  const slug = String(formData.get("slug") ?? "").trim();
  const movie = await getCatalogMovieBySlug(slug);
  if (!movie) redirect("/#catalog");

  const apiKey = process.env.OMDB_API_KEY;
  const imdbId = movie.externalIds.imdb;

  if (!apiKey || !imdbId) {
    await clearMovieOverride(movie.id);
    revalidatePath(`/movies/${slug}`);
    revalidatePath(`/shows/${slug}`);
    revalidatePath("/moderation");
    redirect(`${getMoviePath(movie)}?toast=resync-no-key`);
  }

  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", imdbId);
  url.searchParams.set("plot", "full");

  let omdb: OmdbFullDetails | undefined;
  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (response.ok) {
      const json = (await response.json()) as OmdbFullDetails;
      if (json.Response === "True") omdb = json;
    }
  } catch {
    // Network failure — proceed without OMDb data
  }

  if (!omdb) {
    revalidatePath(`/movies/${slug}`);
    revalidatePath(`/shows/${slug}`);
    redirect(`${getMoviePath(movie)}?toast=resync-failed`);
  }

  function omdbStr(val: string | undefined) {
    return val && val !== "N/A" ? val.trim() : undefined;
  }

  const runtimeMinutes = omdb.Runtime
    ? Number.parseInt(omdb.Runtime, 10) || undefined
    : undefined;

  const genres = omdbStr(omdb.Genre)
    ? omdb.Genre!.split(",").map((g) => g.trim()).filter(Boolean)
    : undefined;

  const productionCountries = omdbStr(omdb.Country)
    ? omdb.Country!.split(",").map((c) => c.trim()).filter(Boolean)
    : undefined;

  const posterUrl =
    omdb.Poster && omdb.Poster !== "N/A" ? omdb.Poster : undefined;
  const totalEpisodesPromise = fetchOmdbTotalEpisodeCount({
    imdbId,
    apiKey,
    totalSeasonsRaw: omdb.totalSeasons ?? omdb.TotalSeasons,
  });

  const [ratFactsResult, imdbReviews, imdbRelated, imdbMedia, totalEpisodes] = await Promise.all([
    fetchRatFacts(imdbId),
    fetchReviewsForResync(imdbId),
    fetchImdbRelated(imdbId),
    fetchImdbMedia(imdbId),
    totalEpisodesPromise,
  ]);
  const ratFacts = ratFactsResult.status === "found" ? ratFactsResult.facts : [];
  const tmdbBackdrop = await getTmdbBackdropUrl({
    tmdbId: movie.externalIds.tmdb,
    imdbId,
    forceRefresh: true,
  });
  const hasTmdbToken = Boolean(
    process.env.TMDB_READ_ACCESS_TOKEN?.trim() ||
    process.env.TMDB_API_READ_ACCESS_TOKEN?.trim() ||
    process.env.TMDB_BEARER_TOKEN?.trim(),
  );
  const tmdbBannerStatus = tmdbBackdrop ? "ok" : hasTmdbToken ? "failed" : "not-configured";
  const syncedVisuals = await getSyncedMoviePageVisuals({
    ...movie,
    ...(posterUrl ? { posterUrl } : {}),
  }, { forceRefresh: true });
  const nextSyncSnapshot: Record<string, unknown> = {
    title: omdb.Title,
    Year: omdb.Year,
    ...(omdbStr(omdb.Type) ? { Type: omdb.Type } : {}),
    ...(omdbStr(omdb.totalSeasons) ? { totalSeasons: omdb.totalSeasons } : {}),
    ...(omdbStr(omdb.TotalSeasons) ? { TotalSeasons: omdb.TotalSeasons } : {}),
    ...(Number.isFinite(totalEpisodes) ? { totalEpisodes } : {}),
    releaseYear: omdb.Year,
    runtimeMinutes: runtimeMinutes ?? movie.runtimeMinutes,
    genres: genres ?? movie.genres,
    summary: omdb.Plot,
    posterUrl: posterUrl ?? movie.posterUrl,
    rating: omdb.Rated ?? "",
    director: omdb.Director ?? "",
    writers: omdb.Writer ?? "",
    cast: omdb.Actors ?? "",
    imdbRating: omdb.imdbRating ?? "",
    imdbVotes: omdb.imdbVotes ?? "",
    metascore: omdb.Metascore ?? "",
    awards: omdb.Awards ?? "",
    originalLanguage: omdb.Language ?? "",
    productionCountries: productionCountries ?? movie.metadata.productionCountries,
    ratFactsCount: ratFacts.length,
    imdbReviewsCount: imdbReviews.length,
    imdbRelatedCount: imdbRelated.length,
    imdbVideosCount: imdbMedia.videos.length,
    imdbImagesCount: imdbMedia.images.length,
    syncedHeaderBannerUrl: syncedVisuals.bannerUrl,
    syncedPagePalette: syncedVisuals.palette,
  };
  const prevSyncSnapshot =
    movie.metadata.syncSnapshot && typeof movie.metadata.syncSnapshot === "object"
      ? movie.metadata.syncSnapshot
      : {};
  const changedLabels: string[] = [];
  const syncFieldLabels: Record<string, string> = {
    title: "Title",
    Year: "Year range",
    Type: "Title type",
    totalSeasons: "Total seasons",
    TotalSeasons: "Total seasons",
    totalEpisodes: "Total episodes",
    releaseYear: "Release year",
    runtimeMinutes: "Runtime",
    genres: "Genres",
    summary: "Summary",
    posterUrl: "Poster URL",
    rating: "Certificate",
    director: "Director",
    writers: "Writers",
    cast: "Cast",
    imdbRating: "IMDb score",
    imdbVotes: "IMDb votes",
    metascore: "Metascore",
    awards: "Awards",
    originalLanguage: "Language",
    productionCountries: "Countries",
    ratFactsCount: "Rat facts",
    imdbReviewsCount: "Reviews",
    imdbRelatedCount: "Related titles",
    imdbVideosCount: "Videos",
    imdbImagesCount: "Images",
    syncedHeaderBannerUrl: "Header banner URL",
    syncedPagePalette: "Synced color palette",
  };
  for (const key of Object.keys(nextSyncSnapshot)) {
    if (JSON.stringify(prevSyncSnapshot[key]) !== JSON.stringify(nextSyncSnapshot[key])) {
      changedLabels.push(syncFieldLabels[key] ?? key);
    }
  }

  await updateMovieOverride(movie.id, {
    ...(omdbStr(omdb.Title) ? { title: omdb.Title } : {}),
    ...(omdb.Year ? { releaseYear: Number.parseInt(omdb.Year, 10) || movie.releaseYear } : {}),
    ...(runtimeMinutes ? { runtimeMinutes } : {}),
    ...(genres ? { genres } : {}),
    ...(omdbStr(omdb.Plot) ? { summary: omdb.Plot } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(tmdbBackdrop ? { backdropUrl: tmdbBackdrop } : {}),
    metadata: {
      ...movie.metadata,
      ...(omdbStr(omdb.Rated) ? { rating: omdb.Rated } : {}),
      ...(omdbStr(omdb.Director) ? { director: omdb.Director } : {}),
      ...(omdbStr(omdb.Writer) ? { writers: omdb.Writer } : {}),
      ...(omdbStr(omdb.Actors) ? { cast: omdb.Actors } : {}),
      ...(omdbStr(omdb.imdbRating) ? { imdbRating: omdb.imdbRating } : {}),
      ...(omdbStr(omdb.imdbVotes) ? { imdbVotes: omdb.imdbVotes } : {}),
      ...(omdbStr(omdb.Metascore) ? { metascore: omdb.Metascore } : {}),
      ...(omdbStr(omdb.Awards) ? { awards: omdb.Awards } : {}),
      ...(omdbStr(omdb.Language) ? { originalLanguage: omdb.Language } : {}),
      ...(productionCountries ? { productionCountries } : {}),
      metadataProvider: "OMDb via IMDb ID",
      lastSyncedAt: new Date().toISOString().slice(0, 10),
      syncedHeaderBannerUrl: syncedVisuals.bannerUrl,
      ...(syncedVisuals.palette ? { syncedPalette: syncedVisuals.palette } : {}),
      ...(syncedVisuals.paletteDark ? { syncedPaletteDark: syncedVisuals.paletteDark } : {}),
      syncSnapshot: nextSyncSnapshot,
      lastSyncChangedFields: changedLabels,
      ...(ratFacts.length > 0 ? { ratFacts } : {}),
      ...(imdbReviews.length > 0 ? { imdbReviews } : {}),
      ...(imdbRelated.length > 0 ? { imdbRelated } : {}),
      ...(imdbMedia.videos.length > 0 ? { imdbVideos: imdbMedia.videos } : {}),
      ...(imdbMedia.images.length > 0 ? { imdbImages: imdbMedia.images } : {}),
    },
  });

  revalidatePath(`/movies/${slug}`);
  revalidatePath(`/shows/${slug}`);
  revalidatePath("/moderation");

  // Build a single comprehensive resync-complete toast with all outcome details.
  const params = new URLSearchParams({ toast: "resync-complete" });
  // Metadata was saved (omdb was present — we already redirected earlier if not)
  params.set("meta", "1");
  // Rat facts
  if (ratFactsResult.status === "found") {
    params.set("facts", String(ratFactsResult.facts.length));
  } else if (ratFactsResult.status === "no-rat-facts") {
    params.set("trivia", "none");
  } else {
    params.set("trivia", "error");
  }
  // Reviews
  if (imdbReviews.length > 0) {
    params.set("reviews", String(imdbReviews.length));
    const ratReviewCount = imdbReviews.filter((r) => r.mentionsRat).length;
    if (ratReviewCount > 0) params.set("ratreviews", String(ratReviewCount));
  } else {
    params.set("reviews", "0");
  }
  // Related titles + media
  params.set("related", String(imdbRelated.length));
  params.set("videos", String(imdbMedia.videos.length));
  params.set("images", String(imdbMedia.images.length));
  params.set("changed", String(changedLabels.length));
  params.set("tmdbbanner", tmdbBannerStatus);
  // After resync, the type may have changed; use the new syncSnapshot to determine route.
  const newType = (nextSyncSnapshot as Record<string, unknown>).Type;
  const targetPath = newType === "series" ? `/shows/${slug}` : `/movies/${slug}`;
  redirect(`${targetPath}?${params.toString()}`);
}

export async function deleteMovie(formData: FormData) {
  const session = await requireModerator();
  if (session.role !== "owner") {
    redirect("/login");
  }
  const slug = String(formData.get("slug") ?? "").trim();
  const movie = await getCatalogMovieBySlug(slug);
  if (!movie) redirect("/#catalog");
  await deleteMovieById(movie.id);
  revalidatePath("/");
  revalidatePath(`/movies/${slug}`);
  revalidatePath(`/shows/${slug}`);
  revalidatePath("/moderation");
  redirect("/?toast=deleted");
}

export async function updateSightingInfo(formData: FormData) {
  const moderator = await requireModerator();
  const slug = String(formData.get("slug") ?? "").trim();
  const returnTo = safeReturnTo(formData.get("returnTo"), `/movies/${slug}`);
  const sightingId = String(formData.get("sightingId") ?? "").trim();
  const title = cleanText(formData.get("title"), SUBMISSION_LIMITS.sightingTitle);
  const timestamp = normalizeSightingTimestampInput(
    cleanText(formData.get("timestamp"), SUBMISSION_LIMITS.timestamp),
  );
  const description = cleanText(formData.get("description"), SUBMISSION_LIMITS.description);
  const spoiler = formData.get("spoiler") === "on";
  const approximateRatCount = clampApproximateRatCount(
    formData.get("approximateRatCount"),
  );
  const curatorNote = cleanText(formData.get("curatorNote"), 2_000);
  const otherWarning = cleanText(formData.get("contentWarningOther"), SUBMISSION_LIMITS.contentWarning);
  const contentWarnings = cleanContentWarnings([
    ...formData.getAll("contentWarnings"),
    ...(otherWarning ? [otherWarning] : []),
  ]);
  const rodentTypes = cleanRodentTypes(formData.getAll("rodentTypes"));
  const otherRodentLabel = cleanText(formData.get("otherRodentLabel"), 60);
  const reason = "Edited from movie page.";
  const galleryManaged = Boolean(formData.get(SIGHTING_GALLERY_SENTINEL));
  const legacyListManaged = String(formData.get("imageListManaged") ?? "") === "1";
  let nextImages: SightingImageSlot[] = [];
  if (galleryManaged) {
    nextImages = await parseSightingImageGalleryForm(
      formData,
      SIGHTING_GALLERY_FIELD_NAMES,
    );
  } else if (legacyListManaged) {
    const finalImageAlts = formData
      .getAll("finalImageAlt")
      .map((value) => String(value ?? "").trim());
    nextImages = formData
      .getAll("finalImageUrl")
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .map((url, index) => ({
        url,
        alt: finalImageAlts[index] || undefined,
      }))
      .slice(0, 5);
  } else {
    const existingImageUrls = formData
      .getAll("existingImageUrl")
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    const existingImageAlts = formData
      .getAll("existingImageAlt")
      .map((value) => String(value ?? "").trim());
    const removeExistingImageUrls = new Set(
      formData
        .getAll("removeExistingImageUrl")
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    const keptExistingImages: SightingImageSlot[] = existingImageUrls
      .map((url, index) => ({
        url,
        alt: existingImageAlts[index] || undefined,
      }))
      .filter((slot) => !removeExistingImageUrls.has(slot.url));
    const uploadedImages = await persistSightingUploads(formData);
    nextImages = [...keptExistingImages, ...uploadedImages].slice(0, 5);
  }
  const leadImage = nextImages[0];

  if (!slug || !sightingId || !title || !timestamp || !description) {
    redirect(returnTo);
  }

  let movedToPath: string | undefined;
  if (sightingId.startsWith("queue-")) {
    const submissionId = sightingId.slice("queue-".length);
    const movieIdentity = parseMovieIdentityEdits(formData);
    if (!movieIdentity.ok) {
      const sep = returnTo.includes("?") ? "&" : "?";
      redirect(`${returnTo}${sep}toast=invalid-movie`);
    }
    await reviewSubmission({
      submissionId,
      decision: "edited and approved",
      moderator,
      reason,
      edits: {
        ...movieIdentity.edits,
        title,
        timestamp,
        description,
        spoiler,
        approximateRatCount,
        curatorNote: curatorNote || undefined,
        images: nextImages,
        imageUrl: leadImage?.url,
        imageAlt: leadImage?.alt,
        contentWarnings: contentWarnings.length ? contentWarnings : undefined,
        rodentTypes: rodentTypes.length ? rodentTypes : undefined,
        otherRodentLabel:
          rodentTypes.includes("other") && otherRodentLabel ? otherRodentLabel : undefined,
      },
    });
    // Re-homed under a different title: the sighting is no longer on this page.
    const newImdbId = movieIdentity.edits.imdbId;
    if (newImdbId && newImdbId !== (await getCatalogMovieBySlug(slug))?.externalIds.imdb) {
      const target = await getCatalogMovieByImdbId(newImdbId);
      if (target) movedToPath = getMoviePath(target);
    }
  } else {
    await updateSightingOverride(sightingId, {
      title,
      timestamp,
      description,
      spoiler,
      approximateRatCount,
      curatorNote: curatorNote || undefined,
      images: nextImages,
      imageUrl: leadImage?.url,
      imageAlt: leadImage?.alt,
      contentWarnings: contentWarnings.length ? contentWarnings : undefined,
      rodentTypes: rodentTypes.length ? rodentTypes : undefined,
      otherRodentLabel:
        rodentTypes.includes("other") && otherRodentLabel ? otherRodentLabel : undefined,
    });
  }

  revalidatePath(returnTo.split("?")[0] || `/movies/${slug}`);
  revalidatePath("/moderation");
  if (movedToPath) {
    revalidatePath(movedToPath);
    redirect(`${movedToPath}?toast=sighting-saved`);
  }
  const sightingSavedReturnTo = returnTo.includes("?")
    ? `${returnTo}&toast=sighting-saved`
    : `${returnTo}?toast=sighting-saved`;
  redirect(sightingSavedReturnTo);
}

export async function deleteSighting(formData: FormData) {
  await requireModerator();
  const slug = String(formData.get("slug") ?? "").trim();
  const returnTo = safeReturnTo(formData.get("returnTo"), `/movies/${slug}`);
  const sightingId = String(formData.get("sightingId") ?? "").trim();
  if (!slug || !sightingId) {
    redirect(returnTo);
  }
  if (sightingId.startsWith("queue-")) {
    const submissionId = sightingId.slice("queue-".length);
    const moderator = await requireModerator();
    await reviewSubmission({
      submissionId,
      decision: "rejected",
      moderator,
      reason: "Removed from movie page.",
    });
  } else {
    await deleteSightingById(sightingId);
  }
  revalidatePath(returnTo.split("?")[0] || `/movies/${slug}`);
  revalidatePath("/moderation");
  const returnToWithToast = returnTo.includes("?")
    ? `${returnTo}&toast=deleted`
    : `${returnTo}?toast=deleted`;
  redirect(returnToWithToast);
}
