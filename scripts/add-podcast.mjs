import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeriesIndex } from "./lib/dr.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(root, "podcasts.json");
const input = process.argv[2];
const titleArg = process.argv.slice(3).join(" ").trim();

if (!input) {
  console.error("Brug: npm run add -- genstart");
  console.error("eller: npm run add -- https://www.dr.dk/lyd/special-radio/genstart-2642056922000");
  process.exit(1);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
config.podcasts ||= [];

const slug = extractSlug(input);
if (config.podcasts.some((podcast) => podcast.slug === slug)) {
  console.log(`${slug} findes allerede i podcasts.json.`);
  process.exit(0);
}

const entry = { slug };
try {
  const index = await loadSeriesIndex();
  const collection = index.umbrellaGroups.get(slug);
  const show = index.bySlug.get(slug);

  if (collection?.length > 1) {
    // Samleserie: kun slug, så nye sæsoner kommer med automatisk.
    console.log(`${slug} er en samleserie med ${collection.length} under-serier. Tilføjer uden urn.`);
    entry.title = titleArg || collection[0].umbrella?.title || show?.title || slug;
  } else if (show) {
    entry.urn = show.id;
    entry.title = titleArg || show.title || slug;
  } else {
    console.warn(`Fandt ikke "${slug}" i serielisten. Tjek med: npm run search -- ${slug}`);
    entry.title = titleArg || slug;
  }
} catch (error) {
  console.warn(`Kunne ikke slå serien op (${error.message}). Tilføjer uden urn.`);
  entry.title = titleArg || slug;
}

// Tilføjes nederst, så den eksisterende rækkefølge bevares.
config.podcasts.push(entry);

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`Tilføjede ${entry.title} (${slug}) til podcasts.json:`);
console.log(JSON.stringify(entry, null, 2));

function extractSlug(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http")) return trimmed.replace(/\.xml.*$/, "");

  const url = new URL(trimmed);
  const lastPart = url.pathname.split("/").filter(Boolean).at(-1) || "";
  const feedMatch = /\/feeds\/([^/]+)\.xml/i.exec(url.pathname);
  if (feedMatch) return feedMatch[1];

  const pageMatch = /^(.+)-\d+$/.exec(lastPart);
  if (pageMatch) return pageMatch[1];

  return lastPart;
}
