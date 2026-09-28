import { unzipSync } from 'fflate';
// Container decompression only; names and OEM magic are routing metadata.
// No extracted member ever touches a filesystem, and no orbit/time/frame is parsed here.
export function firstOemInZip(bytes) {
  let total = 0;
  const files = unzipSync(bytes, { filter: entry => {
    if (entry.name.endsWith('/')) return false;
    total += entry.originalSize;
    if (total > 128 * 1024 * 1024) throw new Error('ZIP exceeds the 128 MiB in-memory expansion limit');
    return true;
  } });
  let selected;
  for (const name of Object.keys(files).sort()) {
    const bytes = files[name];
    if (!selected && Buffer.from(bytes.subarray(0, 4096)).toString('utf8').includes('CCSDS_OEM_VERS')) selected = bytes;
    else bytes.fill(0);
  }
  if (!selected) throw new Error('ZIP contains no OEM KVN member');
  return selected;
}
