import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";
import type { SightingImageSlot } from "@/lib/whererat";

const IMAGE_MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function isBlobEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

function sanitizeAlt(fileName: string) {
  const safeStem = fileName.replace(/[^\w.\- ]+/g, "").trim().slice(0, 96);
  return safeStem ? `${safeStem} (uploaded)` : "Uploaded sighting photo";
}

async function writeLocalImage(file: File, folder: "sightings" | "avatars", ext: string) {
  const dir = path.join(process.cwd(), "public", "uploads", folder);
  await mkdir(dir, { recursive: true });
  const fileName = `${crypto.randomUUID()}${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, fileName), bytes);
  return `/uploads/${folder}/${fileName}`;
}

async function writeBlobImage(file: File, folder: "sightings" | "avatars", ext: string) {
  const pathname = `${folder}/${crypto.randomUUID()}${ext}`;
  const blob = await put(pathname, file, {
    access: "public",
    contentType: file.type,
  });
  return blob.url;
}

/** The declared MIME type is client-controlled, so also check the file's leading bytes. */
async function matchesDeclaredImageType(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  switch (file.type) {
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/gif":
      return startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    case "image/webp":
      return startsWith(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
    default:
      return false;
  }
}

export async function persistImageFile(
  file: File,
  options: {
    folder: "sightings" | "avatars";
    maxBytes: number;
  },
) {
  const ext = IMAGE_MIME_EXT[file.type];
  if (!ext || file.size > options.maxBytes || file.size === 0) return undefined;
  if (!(await matchesDeclaredImageType(file))) return undefined;

  if (isBlobEnabled()) {
    return writeBlobImage(file, options.folder, ext);
  }

  return writeLocalImage(file, options.folder, ext);
}

export async function persistSightingFiles(files: File[], maxBytes: number): Promise<SightingImageSlot[]> {
  const out: SightingImageSlot[] = [];
  for (const file of files.slice(0, 5)) {
    const url = await persistImageFile(file, { folder: "sightings", maxBytes });
    if (!url) continue;
    out.push({
      url,
      alt: sanitizeAlt(file.name),
    });
  }
  return out.slice(0, 5);
}

/**
 * Field-name set for the per-slot gallery payload. Each field is repeated once
 * per image (in slot order). Server reads them via `formData.getAll(...)` and
 * pairs by index.
 */
export type GalleryFormFieldNames = {
  file: string;
  url: string;
  alt: string;
  positionX: string;
  positionY: string;
  zoom: string;
};

function clampPercent(v: number) {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, v));
}
function clampZoom(v: number) {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(4, v));
}

/**
 * Parse an `<ImageUploadGallery>` payload from FormData into ordered slots.
 * Newly-picked files are persisted to the sightings folder; existing slots
 * pass through their persisted URL. The result includes per-image
 * position/zoom data.
 */
export async function parseSightingImageGalleryForm(
  formData: FormData,
  fields: GalleryFormFieldNames,
  options?: {
    maxBytes?: number;
    maxImages?: number;
    /** Gate for client-supplied URLs (existing images). Defaults to allowing any; public intake restricts it. */
    allowPersistedUrl?: (url: string) => boolean;
  },
): Promise<SightingImageSlot[]> {
  const maxImages = options?.maxImages ?? 5;
  const maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;

  const files = formData.getAll(fields.file);
  const urls = formData.getAll(fields.url).map((v) => String(v ?? "").trim());
  const alts = formData.getAll(fields.alt).map((v) => String(v ?? "").trim());
  const xs = formData.getAll(fields.positionX).map((v) => String(v ?? ""));
  const ys = formData.getAll(fields.positionY).map((v) => String(v ?? ""));
  const zooms = formData.getAll(fields.zoom).map((v) => String(v ?? ""));

  const len = Math.max(files.length, urls.length);
  const out: SightingImageSlot[] = [];

  for (let i = 0; i < len && out.length < maxImages; i++) {
    const file = files[i];
    const persistedUrl = urls[i] ?? "";
    const alt = alts[i] ?? "";
    const positionX = clampPercent(parseFloat(xs[i] ?? "50"));
    const positionY = clampPercent(parseFloat(ys[i] ?? "50"));
    const zoom = clampZoom(parseFloat(zooms[i] ?? "1"));

    let finalUrl: string | undefined;
    let finalAlt: string | undefined = alt || undefined;

    if (file instanceof File && file.size > 0) {
      const uploaded = await persistImageFile(file, { folder: "sightings", maxBytes });
      if (uploaded) {
        finalUrl = uploaded;
        if (!finalAlt) finalAlt = sanitizeAlt(file.name);
      }
    } else if (persistedUrl && (options?.allowPersistedUrl?.(persistedUrl) ?? true)) {
      finalUrl = persistedUrl;
    }

    if (finalUrl) {
      out.push({ url: finalUrl, alt: finalAlt, positionX, positionY, zoom });
    }
  }
  return out;
}

export const SIGHTING_GALLERY_FIELD_NAMES: GalleryFormFieldNames = {
  file: "sightingImageFile",
  url: "sightingImageUrl",
  alt: "sightingImageAlt",
  positionX: "sightingImagePositionX",
  positionY: "sightingImagePositionY",
  zoom: "sightingImageZoom",
};

export const SIGHTING_GALLERY_SENTINEL = "sightingImageListManaged";
