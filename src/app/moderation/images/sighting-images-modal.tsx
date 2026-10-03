"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ModalShell } from "@/components/ui/modal-shell";
import { ImageUploadGallery, type InitialGalleryImage } from "@/components/forms/image-upload-gallery";
import type { SightingImagesListState } from "@/lib/sighting-images-view";
import { saveSightingImages } from "./actions";

const FORM_ID = "sighting-images-form";

export function SightingImagesModal({
  sightingId,
  sightingTitle,
  movieTitle,
  movieYear,
  moviePath,
  posterUrl,
  details,
  spoiler,
  initialImages,
  list,
  closeHref,
  nextSightingId,
  positionLabel,
  description,
}: {
  sightingId: string;
  sightingTitle: string;
  movieTitle: string;
  movieYear: number;
  moviePath: string;
  posterUrl: string;
  /** Episode / moment line shown under the sighting title. */
  details: string;
  spoiler: boolean;
  initialImages: InitialGalleryImage[];
  list: SightingImagesListState;
  closeHref: string;
  nextSightingId?: string;
  /** e.g. "3 of 12" — where this sighting sits in the filtered list. */
  positionLabel?: string;
  /** Rendered sighting description (server-rendered markdown). */
  description: ReactNode;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <ModalShell
      title={`Images: ${sightingTitle}`}
      closeHref={closeHref}
      footer={
        <>
          {positionLabel ? (
            <p className="text-xs font-semibold text-stone-500 sm:mr-auto sm:self-center dark:text-stone-400">
              Sighting {positionLabel}
            </p>
          ) : null}
          <Link href={closeHref} className="wr-btn-ghost">
            Cancel
          </Link>
          <button
            form={FORM_ID}
            type="submit"
            name="intent"
            value="save"
            disabled={saving}
            className={nextSightingId ? "wr-btn" : "wr-btn-primary"}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {nextSightingId ? (
            <button
              form={FORM_ID}
              type="submit"
              name="intent"
              value="next"
              disabled={saving}
              className="wr-btn-primary"
            >
              {saving ? "Saving…" : "Save & next"}
            </button>
          ) : null}
        </>
      }
    >
      <form id={FORM_ID} action={saveSightingImages} onSubmit={() => setSaving(true)} className="grid gap-5 py-5">
        <input type="hidden" name="sightingId" value={sightingId} />
        <input type="hidden" name="filter" value={list.filter} />
        <input type="hidden" name="q" value={list.q} />
        {list.page ? <input type="hidden" name="page" value={list.page} /> : null}
        {nextSightingId ? <input type="hidden" name="nextSightingId" value={nextSightingId} /> : null}

        <div className="flex gap-4 rounded-xl border border-stone-900/12 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-900/50">
          <img
            src={posterUrl}
            alt=""
            className="h-24 w-16 shrink-0 rounded-lg border border-stone-900/12 object-cover dark:border-white/12"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-stone-600 dark:text-stone-300">
              <a
                href={moviePath}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-stone-900/30 underline-offset-2 hover:decoration-stone-900 dark:decoration-white/30 dark:hover:decoration-white"
              >
                {movieTitle} ({movieYear})
              </a>
            </p>
            <p className="mt-0.5 font-black text-stone-950 dark:text-stone-100">{sightingTitle}</p>
            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
              {details}
              {spoiler ? (
                <span className="ml-2 inline-flex rounded-md border border-red-700/35 bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-950 dark:border-red-400/30 dark:bg-red-950/35 dark:text-red-200">
                  Spoiler
                </span>
              ) : null}
            </p>
            <div className="mt-2 max-h-28 overflow-y-auto text-sm text-stone-700 dark:text-stone-200">
              {description}
            </div>
          </div>
        </div>

        {/* Field names must match SIGHTING_GALLERY_FIELD_NAMES in media-storage.ts (server-only). */}
        <ImageUploadGallery
          label="Sighting images"
          hintSuffix="(max 5)"
          aspectRatio="wide"
          maxImages={5}
          initialImages={initialImages}
          fileFieldName="sightingImageFile"
          urlFieldName="sightingImageUrl"
          altFieldName="sightingImageAlt"
          positionXFieldName="sightingImagePositionX"
          positionYFieldName="sightingImagePositionY"
          zoomFieldName="sightingImageZoom"
          sentinelFieldName="sightingImageListManaged"
        />
        <p className="-mt-2 text-xs text-stone-500 dark:text-stone-400">
          Drag to reframe, scroll to zoom. The first image leads the public carousel. Removing every
          image and saving leaves the sighting without images.
        </p>
      </form>
    </ModalShell>
  );
}
