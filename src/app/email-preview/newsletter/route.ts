import { NextResponse } from "next/server";
import { buildNewsletterDigestEmail, defaultDigestSubject } from "@/lib/news-notify";
import { getNewsItemById } from "@/lib/news-store";
import { requirePreviewOwner, wrapWithPreviewNav } from "../_fixtures";

export const dynamic = "force-dynamic";

const FAKE_NEWS_ITEMS = [
  {
    id: "preview-news-001",
    title: "Dark fur detected in Paddington",
    body: "A WhereRat community member has submitted a fresh sighting from the 2014 film Paddington. Look out for a grey blur darting across the bakery floor at around the 23-minute mark. Small, fast, unmistakable. Head to the catalog to see the full entry.",
    type: "community" as const,
    imageUrl: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=600&q=80",
    imageAlt: "A rat in a bakery scene from Paddington",
    imagePositionX: 50,
    imagePositionY: 50,
    imageZoom: 1,
    authorId: "author-1",
    authorName: "WhereRat",
    authorAvatarUrl: "",
    publishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "preview-news-002",
    title: "Mobile app rat tracker is live",
    body: "We just shipped the iOS + Android companion app. Submit sightings on the go, browse the catalog offline, and get notified when moderators approve your scoops.",
    type: "product-news" as const,
    imageUrl: null,
    imageAlt: null,
    imagePositionX: 50,
    imagePositionY: 50,
    imageZoom: 1,
    authorId: "author-1",
    authorName: "WhereRat",
    authorAvatarUrl: "",
    publishedAt: new Date(Date.now() - 86400000),
    createdAt: new Date(Date.now() - 86400000),
    updatedAt: new Date(Date.now() - 86400000),
  },
  {
    id: "preview-news-003",
    title: "Write-in rodent species now supported",
    body: "Submitters can now choose 'Other' and type a custom species — capybara, porcupine, vole, anything goes. Moderators see the typed name during review; approved sightings display it as a tag on the public card.",
    type: "announcement" as const,
    imageUrl: null,
    imageAlt: null,
    imagePositionX: 50,
    imagePositionY: 50,
    imageZoom: 1,
    authorId: "author-1",
    authorName: "WhereRat",
    authorAvatarUrl: "",
    publishedAt: new Date(Date.now() - 2 * 86400000),
    createdAt: new Date(Date.now() - 2 * 86400000),
    updatedAt: new Date(Date.now() - 2 * 86400000),
  },
];

const FAKE_UNSUBSCRIBE_TOKEN = "preview-token-abc123";

export async function GET(request: Request) {
  const baseUrl = await requirePreviewOwner(request);
  const { searchParams } = new URL(request.url);
  const headingOverride = searchParams.get("heading") ?? undefined;
  const subheadOverride = searchParams.get("subhead") ?? undefined;

  const ids = searchParams.getAll("id");
  let newsItems = FAKE_NEWS_ITEMS;

  if (ids.length > 0) {
    const loaded = await Promise.all(ids.map((id) => getNewsItemById(id)));
    const real = loaded.filter((item) => item != null && item.publishedAt != null);
    if (real.length > 0) {
      newsItems = real as typeof FAKE_NEWS_ITEMS;
    }
  }

  const subject = defaultDigestSubject(newsItems);
  const { html } = buildNewsletterDigestEmail(
    newsItems,
    FAKE_UNSUBSCRIBE_TOKEN,
    subject,
    baseUrl,
    headingOverride,
    subheadOverride,
  );
  return new NextResponse(wrapWithPreviewNav(html, "newsletter"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
