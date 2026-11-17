import { derivePresentationSlug, deriveSlug, deriveUmbrellaSlug, loadSeriesIndex } from "./lib/dr.mjs";

const query = process.argv.slice(2).join(" ").trim().toLowerCase();
if (!query) {
  console.error("Brug: npm run search -- stjerner");
  console.error("eller: npm run search -- \"p6 elsker\"");
  process.exit(1);
}

const { items, umbrellaGroups } = await loadSeriesIndex();
const matches = items
  .map((item) => {
    const podcastSlug = deriveSlug(item);
    const pageSlug = derivePresentationSlug(item);
    const haystack = [
      item.title,
      item.slug,
      item.psdbSlug,
      podcastSlug,
      pageSlug,
      item.podcastUrl,
      item.presentationUrl
    ].join(" ").toLowerCase();

    return { item, podcastSlug, pageSlug, haystack };
  })
  .filter((entry) => entry.haystack.includes(query))
  .sort((a, b) => score(b, query) - score(a, query))
  .slice(0, 15);

if (!matches.length) {
  console.log(`Ingen resultater for "${query}".`);
  process.exit(0);
}

for (const [index, match] of matches.entries()) {
  const { item, podcastSlug, pageSlug } = match;
  const recommendedSlug = pageSlug || podcastSlug;

  console.log(`\n${index + 1}. ${item.title}`);
  console.log(`   Anbefalet slug: ${recommendedSlug}`);
  if (podcastSlug && podcastSlug !== recommendedSlug) {
    console.log(`   Podcast-slug:   ${podcastSlug}`);
  }
  console.log(`   DR-link:        ${item.presentationUrl || ""}`);
  console.log(`   URN:            ${item.id}`);

  // Del af en samleserie: brug samleseriens slug uden urn, så alle sæsoner kommer med.
  const umbrellaSlug = deriveUmbrellaSlug(item.umbrella);
  const isPartOfCollection = umbrellaSlug && (umbrellaGroups.get(umbrellaSlug)?.length || 0) > 1;
  const entry = isPartOfCollection
    ? { slug: umbrellaSlug, title: item.umbrella?.title || item.title }
    : { slug: recommendedSlug, urn: item.id, title: item.title };
  if (isPartOfCollection) {
    console.log(`   Del af samleserien "${umbrellaSlug}" – brug kun slug, så alle sæsoner kommer med.`);
  }

  console.log("   Kopier til podcasts.json:");
  console.log(JSON.stringify(entry, null, 2).split("\n").map((line) => `   ${line}`).join("\n"));
}

function score(entry, query) {
  const title = String(entry.item.title || "").toLowerCase();
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;
  if (entry.pageSlug === query || entry.podcastSlug === query) return 70;
  return 10;
}
