import { NextResponse, type NextRequest } from "next/server";
import { getV1MovieDetailJson } from "@/lib/api-v1/movie-detail";

export const dynamic = "force-dynamic";

const CACHE_HEADER = "public, s-maxage=60, stale-while-revalidate=120";

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { slug: rawSlug } = await context.params;
  // Next may already have decoded the param; a malformed escape must be a 404, not a 500.
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    // keep the raw value; validation below rejects it
  }

  const url = new URL(request.url);
  const sort = url.searchParams.get("sort");
  const page = url.searchParams.get("page");

  const body = await getV1MovieDetailJson(slug, {
    sort,
    page,
  });

  if (!body) {
    return NextResponse.json(
      { error: "not_found", message: "Movie not found" },
      { status: 404 },
    );
  }

  return NextResponse.json(body, {
    headers: { "Cache-Control": CACHE_HEADER },
  });
}
