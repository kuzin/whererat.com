import type { Sighting } from "@/lib/whererat";
import { getDbPool } from "@/lib/db";
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

export async function deleteSightingById(sightingId: string) {
  const pool = getDbPool();
  await pool.query(`delete from sighting_overrides where sighting_id = $1`, [sightingId]);
  await pool.query(
    `update sightings set is_deleted = true, updated_at = now() where id = $1`,
    [sightingId],
  );
  invalidateCatalogCache();
}
