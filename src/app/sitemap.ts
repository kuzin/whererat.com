import type { MetadataRoute } from "next";
import { getCatalogMovies } from "@/lib/movie-catalog";
import { getMoviePath } from "@/lib/whererat";

const BASE_URL = "https://whererat.com";

// Without this the sitemap is prerendered once at build time, so movies added after a
// deploy (approved community titles) would be missing until the next deploy.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let movies: Awaited<ReturnType<typeof getCatalogMovies>> = [];
  try {
    movies = await getCatalogMovies();
  } catch {
    // No DB available (e.g. CI build) — serve static routes only.
  }

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${BASE_URL}/submit`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/guidelines`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.35,
    },
  ];

  const movieRoutes: MetadataRoute.Sitemap = movies.map((movie) => ({
    url: `${BASE_URL}${getMoviePath(movie)}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...staticRoutes, ...movieRoutes];
}
