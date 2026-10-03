"use client";

import { useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import {
  SightingTimestampField,
  SightingRatCountField,
  SightingDescriptionField,
  SightingContentWarningsField,
  SightingRodentTypesField,
} from "@/components/forms/sighting-fields";
import { MovieIdentityFields } from "@/components/forms/movie-identity-fields";
import { ImageUploadGallery, type InitialGalleryImage } from "@/components/forms/image-upload-gallery";
import {
  getSightingTimestampPercent,
  getSubmissionImageRefs,
  getSubmissionSightingTitle,
  RODENT_TYPE_OPTIONS,
  rodentCountFieldLabel,
  rodentSwarmNoun,
  type Submission,
} from "@/lib/whererat";

export function ModerationEditModal({
  submission,
  moderateAction,
  runtimeMinutes,
}: {
  submission: Submission;
  moderateAction: (formData: FormData) => void | Promise<void>;
  runtimeMinutes?: number;
}) {
  const initialRodentTypes = submission.rodentTypes ?? ["rat"];
  const [selectedRodentTypes, setSelectedRodentTypes] = useState<string[]>(initialRodentTypes);
  const rodentOption = RODENT_TYPE_OPTIONS.find((o) => o.id === selectedRodentTypes[0]);
  const initialImages = getSubmissionImageRefs(submission);
  const initialPercent = getSightingTimestampPercent(submission.timestamp) ?? 50;
  const isSeriesTitle = submission.imdbKind === "series";

  return (
    <ModalShell
      title="Edit submission"
      closeHref="/moderation"
      footer={
        <>
          <button
            form="moderation-edit-form"
            type="submit"
            name="decision"
            value="edited"
            className="wr-btn"
          >
            Save edits
          </button>
          <button
            form="moderation-edit-form"
            type="submit"
            name="decision"
            value="edited and approved"
            className="wr-btn bg-green-700 text-white hover:bg-green-800 dark:bg-green-600 dark:hover:bg-green-500"
          >
            Save &amp; Approve
          </button>
        </>
      }
    >
      <form id="moderation-edit-form" action={moderateAction} className="grid gap-5 py-5">
        <input name="submissionId" type="hidden" value={submission.id} />
        <input name="imdbKind" type="hidden" value={submission.imdbKind ?? "movie"} />
        <input name="seasonNumber" type="hidden" value={submission.seasonNumber ?? ""} />
        <input name="episodeNumber" type="hidden" value={submission.episodeNumber ?? ""} />
        <input name="episodeTitle" type="hidden" value={submission.episodeTitle ?? ""} />

        {/* Movie / show */}
        <MovieIdentityFields movieTitle={submission.movieTitle} imdbId={submission.imdbId} />

        {/* Sighting title */}
        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
          Sighting title
          <input
            name="sightingTitle"
            required
            defaultValue={getSubmissionSightingTitle(submission)}
            className="wr-input"
          />
        </label>

        {/* Rodent types */}
        <SightingRodentTypesField
          initialTypes={initialRodentTypes}
          initialOtherLabel={submission.otherRodentLabel}
          onTypesChange={setSelectedRodentTypes}
        />

        {/* Timestamp */}
        <SightingTimestampField
          defaultValue={initialPercent}
          label={`When in the ${isSeriesTitle ? "episode" : "movie"}?`}
          runtimeMinutes={runtimeMinutes}
        />

        {/* Rat count */}
        <SightingRatCountField
          defaultValue={submission.approximateRatCount}
          label={rodentCountFieldLabel(selectedRodentTypes)}
          openmojiCode={rodentOption?.openmojiCode ?? "1F400"}
          rodentId={rodentOption?.id}
          noun={rodentSwarmNoun(selectedRodentTypes)}
        />

        {/* Description */}
        <SightingDescriptionField
          required
          defaultValue={submission.description}
        />

        {/* Curator message */}
        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
          Curator message
          <textarea
            name="curatorNote"
            rows={3}
            defaultValue={submission.curatorNote ?? ""}
            placeholder="Optional note shown with the published sighting."
            className="wr-input h-auto min-h-20 resize-y py-3 leading-relaxed"
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

        {/* Spoiler + content warnings */}
        <div className="overflow-hidden rounded-xl border border-stone-900/12 bg-stone-50 dark:border-white/10 dark:bg-stone-900/50">
          <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-stone-800 transition-colors hover:bg-stone-100 dark:text-stone-100 dark:hover:bg-white/5">
            <span>Contains plot spoilers</span>
            <span className="relative inline-flex shrink-0 items-center">
              <input
                name="spoiler"
                type="checkbox"
                defaultChecked={submission.spoiler}
                className="peer sr-only"
              />
              <span className="block h-6 w-11 rounded-full bg-stone-300 transition-colors peer-checked:bg-amber-500 dark:bg-stone-600 dark:peer-checked:bg-amber-500" />
              <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
          <SightingContentWarningsField
            embedded
            initialWarnings={submission.contentWarnings}
            rodentTypes={selectedRodentTypes}
          />
        </div>
      </form>
    </ModalShell>
  );
}

