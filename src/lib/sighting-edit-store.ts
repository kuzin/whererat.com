import type { Sighting, SightingImageSlot } from "@/lib/whererat";
import { getDbPool, withTransaction } from "@/lib/db";
import { invalidateCatalogCache } from "@/lib/catalog-cache";

export async function getSightingOverrides() {
  const pool = getDbPool();
  const result = await pool.query<{ sighting_id: string; override: Partial<Sighting> }>(
    `select sighting_id, override from sighting_overrides`,
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.sighting_id, row.override]),
  ) as Record<string, Partial<Sighting>>;
}

export async function getDeletedSightingIds() {
  const pool = getDbPool();
  const result = await pool.query<{ id: string }>(
    `select id from sightings where is_deleted = true`,
  );
  return new Set(result.rows.map((row) => row.id));
}

export async function updateSightingOverride(
  sightingId: string,
  override: Partial<Sighting>,
) {
  const pool = getDbPool();
  await pool.query(
    `insert into sighting_overrides (sighting_id, override, updated_at)
     values ($1,$2,now())
     on conflict (sighting_id) do update
       set override = excluded.override,
           updated_at = now()`,
    [sightingId, override],
  );
  await pool.query(
    `update sightings
        set timestamp_code = coalesce($2, timestamp_code),
            title = coalesce($3, title),
            description = coalesce($4, description),
            spoiler = coalesce($5, spoiler),
            curator_note = coalesce($6, curator_note),
            approximate_rat_count = coalesce($7, approximate_rat_count),
            content_warnings = case when $8::text[] is not null then $8 else content_warnings end,
            rodent_types = case when $9::text[] is not null then $9 else rodent_types end,
            other_rodent_label = coalesce($10, other_rodent_label),
            updated_at = now()
      where id = $1`,
    [
      sightingId,
      override.timestamp ?? null,
      override.title ?? null,
      override.description ?? null,
      typeof override.spoiler === "boolean" ? override.spoiler : null,
      override.curatorNote ?? null,
      override.approximateRatCount ?? null,
      override.contentWarnings ?? null,
      override.rodentTypes ?? null,
      override.otherRodentLabel ?? null,
    ],
  );
  if (override.images) {
    await pool.query(`delete from sighting_images where sighting_id = $1`, [sightingId]);
    for (const [index, slot] of override.images.entries()) {
      await pool.query(
        `insert into sighting_images (sighting_id, image_url, image_alt, sort_order, image_position_x, image_position_y, image_zoom)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          sightingId,
          slot.url,
          slot.alt ?? null,
          index,
          slot.positionX ?? 50,
          slot.positionY ?? 50,
          slot.zoom ?? 1,
        ],
      );
    }
  }
  if (override.imageUrl && !override.images) {
    await pool.query(
      `insert into sighting_images (sighting_id, image_url, image_alt, sort_order)
       values ($1,$2,$3,0)
       on conflict (sighting_id, sort_order) do update
         set image_url = excluded.image_url,
             image_alt = excluded.image_alt`,
      [sightingId, override.imageUrl, override.imageAlt ?? null],
    );
  }
  invalidateCatalogCache();
}

/**
 * Replaces the image carousel of one live sighting and nothing else — no review
 * action, no submitter e-mail, other overridden fields untouched. Returns false when
 * the id is not a live sighting (unknown, soft-deleted, or a submission that is not
 * approved).
 *
 * Approved submissions (`queue-<submissionId>`) read their images from
 * submission_images. Catalog sightings read them from their override, mirrored into
 * sighting_images the way {@link updateSightingOverride} does.
 */
export async function replaceSightingImages(
  sightingId: string,
  images: SightingImageSlot[],
): Promise<boolean> {
  const slots = images.slice(0, 5);
  const saved = await withTransaction(async (client) => {
    if (sightingId.startsWith("queue-")) {
      const submissionId = sightingId.slice("queue-".length);
      const live = await client.query(
        `select 1 from submissions where id = $1 and status = 'approved' for update`,
        [submissionId],
      );
      if (!live.rowCount) return false;
      await client.query(`delete from submission_images where submission_id = $1`, [submissionId]);
      for (const [index, slot] of slots.entries()) {
        await client.query(
          `insert into submission_images (submission_id, image_url, image_alt, sort_order, image_position_x, image_position_y, image_zoom)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [submissionId, slot.url, slot.alt ?? null, index, slot.positionX ?? 50, slot.positionY ?? 50, slot.zoom ?? 1],
        );
      }
      await client.query(`update submissions set updated_at = now() where id = $1`, [submissionId]);
      return true;
    }

    const live = await client.query(
      `select 1 from sightings where id = $1 and is_deleted = false for update`,
      [sightingId],
    );
    if (!live.rowCount) return false;
    // Merge rather than replace the override; drop the legacy single-image keys so a
    // removed lead image can't come back through `imageUrl`.
    await client.query(
      `insert into sighting_overrides (sighting_id, override, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (sighting_id) do update
         set override = (sighting_overrides.override - 'imageUrl' - 'imageAlt') || excluded.override,
             updated_at = now()`,
      [sightingId, JSON.stringify({ images: slots })],
    );
    await client.query(`delete from sighting_images where sighting_id = $1`, [sightingId]);
    for (const [index, slot] of slots.entries()) {
      await client.query(
        `insert into sighting_images (sighting_id, image_url, image_alt, sort_order, image_position_x, image_position_y, image_zoom)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [sightingId, slot.url, slot.alt ?? null, index, slot.positionX ?? 50, slot.positionY ?? 50, slot.zoom ?? 1],
      );
    }
    await client.query(`update sightings set updated_at = now() where id = $1`, [sightingId]);
    return true;
  });
  if (saved) invalidateCatalogCache();
  return saved;
}

export async function deleteSightingById(sightingId: string) {
  const pool = getDbPool();
  await pool.query(`delete from sighting_overrides where sighting_id = $1`, [sightingId]);
  await pool.query(
    `update sightings set is_deleted = true, updated_at = now() where id = $1`,
    [sightingId],
  );
  invalidateCatalogCache();
}
