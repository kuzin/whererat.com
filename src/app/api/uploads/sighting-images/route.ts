import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { persistSightingFiles } from "@/lib/media-storage";

const MAX_SIGHTING_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await verifyModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const formData = await request.formData();
  const files = formData
    .getAll("images")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)
    .slice(0, 5);

  if (files.length === 0) {
    return NextResponse.json({ uploaded: [] });
  }

  const uploaded = await persistSightingFiles(files, MAX_SIGHTING_UPLOAD_BYTES);

  return NextResponse.json({ uploaded: uploaded.slice(0, 5) });
}
