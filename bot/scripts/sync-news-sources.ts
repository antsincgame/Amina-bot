import { settingsRepo } from '../src/db/supabase.js';
import {
  getConfiguredSites,
  getPresetSources,
  mergeNewsSites,
  saveConfiguredSites,
  type NewsPresetGroup,
} from '../src/features/news-parser.js';

const arg = process.argv[2]?.trim().toLowerCase();
const group: NewsPresetGroup = arg === 'asia' || arg === 'global' ? arg : 'all';

async function main(): Promise<void> {
  const existing = await getConfiguredSites();
  const presets = getPresetSources(group);
  const existingUrls = new Set(existing.map(site => site.url.trim().replace(/\/+$/, '').toLowerCase()));
  const added = presets.filter(site => !existingUrls.has(site.url.trim().replace(/\/+$/, '').toLowerCase())).length;
  const merged = mergeNewsSites(existing, presets);

  await saveConfiguredSites(merged);
  settingsRepo.invalidateCache?.();

  console.log(
    JSON.stringify(
      {
        group,
        existing: existing.length,
        presetCount: presets.length,
        added,
        total: merged.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
