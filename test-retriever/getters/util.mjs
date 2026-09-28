/** Helpers shared by source discovery. */

/** Extract all `href="…"` targets from an HTML string. */
export function scrapeHrefs(html) {
  const out= [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m                        ;
  while ((m = re.exec(html)) !== null) out.push(m[1] );
  return out;
}

/** Extract all `<option value="…">` values from an HTML string. */
export function scrapeOptionValues(html) {
  const out= [];
  const re = /<option[^>]*\bvalue\s*=\s*["']([^"']+)["']/gi;
  let m                        ;
  while ((m = re.exec(html)) !== null) out.push(m[1] );
  return out;
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

/** Current GPS week number (full weeks since 1980-01-06). */
export function gpsWeek(at= new Date()) {
  return Math.floor((at.getTime() - GPS_EPOCH_MS) / (7 * 86_400_000));
}

/**
 * From a directory-listing HTML, pick the newest file matching `prefix` and
 * ending in `suffix`. The IGS long filename embeds a sortable timestamp, so the
 * lexicographic maximum is the most recent epoch.
 */
export function newestMatching(html, prefix, suffix) {
  const names = scrapeHrefs(html)
    .map((h) => h.replace(/^.*\//, ''))
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix));
  if (names.length === 0) return null;
  names.sort();
  return names[names.length - 1] ;
}
