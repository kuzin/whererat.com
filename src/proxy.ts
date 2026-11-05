import { NextResponse, type NextRequest } from "next/server";

/**
 * Next's router throws (and answers 500, with nothing in our logs) when a dynamic path
 * segment contains a malformed percent-escape, e.g. `/movies/%ff%fe` or `/movies/%E0%A4%A`.
 * Nothing can match such a path, so answer with a 404 instead.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  try {
    decodeURIComponent(pathname);
  } catch {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "not_found", message: "Not found" }, { status: 404 });
    }
    // Rewrite to the *other* catalog route: rewriting /movies/<bad> to another /movies/<x>
    // would keep the same dynamic segment in play and fail again. Either page renders the
    // normal 404 for a slug that doesn't exist.
    const target = pathname.startsWith("/movies/") ? "/shows/not-found" : "/movies/not-found";
    return NextResponse.rewrite(new URL(target, request.url), { status: 404 });
  }
  return NextResponse.next();
}

// Only the dynamic catalog routes are affected, so only they pay for this.
export const config = {
  matcher: ["/movies/:path*", "/shows/:path*", "/api/v1/movies/:path*"],
};
