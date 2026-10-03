"use client";

import { useState } from "react";
import Link from "next/link";
import {
  SightingTimestampField,
  SightingRatCountField,
  SightingDescriptionField,
  SightingContentWarningsField,
  SightingRodentTypesField,
} from "@/components/forms/sighting-fields";
import { MovieIdentityFields } from "@/components/forms/movie-identity-fields";
import { ImageUploadGallery, type InitialGalleryImage } from "@/components/forms/image-upload-gallery";
import { ConfirmSubmitButton } from "@/components/forms/confirm-submit-button";
import {
  getSightingTimestampPercent,
  getSightingImageRefs,
  RODENT_TYPE_OPTIONS,
  rodentCountFieldLabel,
  rodentSwarmNoun,
  type Sighting,
} from "@/lib/whererat";

type EditSightingFormProps = {
  sighting: Sighting;
  slug: string;
  returnTo: string;
  isSeriesTitle: boolean;
  updateAction: (formData: FormData) => void | Promise<void>;
  deleteAction: (formData: FormData) => void | Promise<void>;
  /** When set, the form gets this id and footer buttons are suppressed — parent renders them externally. */
  formId?: string;
  /** Current title this sighting is filed under. Only passed for sightings backed by a submission. */
  movieIdentity?: { movieTitle: string; imdbId?: string };
};

export function EditSightingForm({
  sighting,
  slug,
  returnTo,
  isSeriesTitle,
  updateAction,
  deleteAction,
  formId,
  movieIdentity,
}: EditSightingFormProps) {
  const initialImages = getSightingImageRefs(sighting);
  const initialPercent = getSightingTimestampPercent(sighting.timestamp) ?? 50;
  const initialRodentTypes = (sighting as { rodentTypes?: string[] }).rodentTypes ?? ["rat"];
  const [selectedRodentTypes, setSelectedRodentTypes] = useState<string[]>(initialRodentTypes);
  const rodentOption = RODENT_TYPE_OPTIONS.find((o) => o.id === selectedRodentTypes[0]);

  return (
    <form id={formId} action={updateAction} className={`${formId ? "py-5" : "mt-6"} grid gap-5`}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="sightingId" value={sighting.id} />
      <input type="hidden" name="returnTo" value={returnTo} />

      {movieIdentity ? (
        <MovieIdentityFields
          movieTitle={movieIdentity.movieTitle}
          imdbId={movieIdentity.imdbId}
        />
      ) : null}

      {/* Title */}
      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
        Sighting title
        <input
          name="title"
          required
          defaultValue={sighting.title}
          className="wr-input"
        />
        <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
          A short, punchy label for this rat moment.
        </p>
      </label>

      {/* Rodent type picker */}
      <SightingRodentTypesField
        initialTypes={initialRodentTypes}
        initialOtherLabel={sighting.otherRodentLabel}
        onTypesChange={setSelectedRodentTypes}
      />

      {/* Timestamp slider */}
      <SightingTimestampField
        defaultValue={initialPercent}
        label={`When in the ${isSeriesTitle ? "episode" : "movie"}?`}
      />

      {/* Rodent count stepper */}
      <SightingRatCountField
        defaultValue={sighting.approximateRatCount}
        label={rodentCountFieldLabel(selectedRodentTypes)}
        openmojiCode={rodentOption?.openmojiCode ?? "1F400"}
        rodentId={rodentOption?.id}
        noun={rodentSwarmNoun(selectedRodentTypes)}
      />

      {/* Description + preview */}
      <SightingDescriptionField
        defaultValue={sighting.description}
        required
        minRows={5}
      />

      {/* Curator note */}
      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
        Curator note
        <textarea
          name="curatorNote"
          rows={3}
          defaultValue={sighting.curatorNote ?? ""}
          placeholder="Optional note shown alongside the published sighting."
          className="wr-input h-auto resize-y py-3 leading-relaxed"
          style={{ minHeight: "5rem" }}
        />
      </label>

      {/* Images */}
      <ImageUploadGallery
        label="Sighting images"
        hintSuffix="(optional, max 5)"
        aspectRatio="wide"
        maxImages={5}
        initialImages={initialImages.map(
          (slot): InitialGalleryImage => ({
            url: slot.url,
            alt: slot.alt,
            x: slot.positionX,
            y: slot.positionY,
            zoom: slot.zoom,
          }),
        )}
        fileFieldName="sightingImageFile"
        urlFieldName="sightingImageUrl"
        altFieldName="sightingImageAlt"
        positionXFieldName="sightingImagePositionX"
        positionYFieldName="sightingImagePositionY"
        zoomFieldName="sightingImageZoom"
        sentinelFieldName="sightingImageListManaged"
      />

      {/* Content warnings */}
      <SightingContentWarningsField initialWarnings={sighting.contentWarnings} rodentTypes={selectedRodentTypes} />

      {/* Spoiler toggle */}
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-stone-900/12 bg-stone-50 px-4 py-3 text-sm font-semibold text-stone-800 transition-colors hover:bg-stone-100 dark:border-white/10 dark:bg-stone-900/50 dark:text-stone-100 dark:hover:bg-white/5">
        <div>
          <p>Contains spoilers</p>
          <p className="mt-0.5 text-xs font-normal text-stone-500 dark:text-stone-400">
            Hides the title, description, and images until the viewer opts in.
          </p>
        </div>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            name="spoiler"
            type="checkbox"
            defaultChecked={sighting.spoiler}
            className="peer sr-only"
          />
          <span className="block h-6 w-11 rounded-full bg-stone-300 transition-colors peer-checked:bg-amber-500 dark:bg-stone-600 dark:peer-checked:bg-amber-500" />
          <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
        </span>
      </label>

      {/* Actions — only rendered when not using external footer (formId prop) */}
      {!formId && (
        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-end">
          <ConfirmSubmitButton
            confirmMessage="Delete this sighting? This cannot be undone."
            type="submit"
            formAction={deleteAction}
            className="wr-btn bg-red-100 text-red-900 dark:border-red-400/20 dark:bg-red-950/40 dark:text-red-100"
          >
            Delete sighting
          </ConfirmSubmitButton>
          <Link
            href={returnTo}
            className="wr-btn-ghost"
          >
            Cancel
          </Link>
          <button type="submit" className="wr-btn-primary">
            Save sighting
          </button>
        </div>
      )}
    </form>
  );
}
