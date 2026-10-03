/**
 * Which movie/show a sighting belongs to. Moderators use this to fix a sighting
 * that was filed under the wrong title: the IMDb ID decides the catalog entry
 * (a new community entry is created on approval if it isn't in the catalog yet).
 */
export function MovieIdentityFields({
  movieTitle,
  imdbId,
}: {
  movieTitle: string;
  imdbId?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
        Movie or show title
        <input name="movieTitle" required defaultValue={movieTitle} className="wr-input" />
      </label>
      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
        IMDb ID
        <input
          name="imdbId"
          required
          defaultValue={imdbId ?? ""}
          placeholder="tt1234567"
          pattern=".*[tT][tT][0-9]{7,9}.*"
          title="An IMDb title ID like tt1234567"
          spellCheck={false}
          className="wr-input font-mono"
        />
      </label>
      <p className="text-xs font-medium text-stone-500 dark:text-stone-400 sm:col-span-2">
        Change the IMDb ID to move this sighting to a different title.
      </p>
    </div>
  );
}
