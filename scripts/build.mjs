import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DR_API_URL, fetchJson, fetchWithRetry, loadSeriesIndex } from "./lib/dr.mjs";

const DEFAULT_PLAYLIST_LIMIT = 5;
// Alarm (fejlet workflow = mail fra GitHub), når et problem har varet så længe.
const STALE_ALERT_HOURS = Number(process.env.STALE_ALERT_HOURS || 24);
// Samme problem giver højst én mail pr. så mange timer.
const ALERT_REPEAT_HOURS = Number(process.env.ALERT_REPEAT_HOURS || 24);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");
const configPath = join(root, "podcasts.json");

const config = JSON.parse(await readFile(configPath, "utf8"));
const siteTitle = config.siteTitle || "Mine Podcasts";
const baseUrl = (process.env.SITE_BASE_URL || config.baseUrl || "").replace(/\/$/, "");
const podcasts = Array.isArray(config.podcasts) ? config.podcasts : [];

if (!baseUrl || baseUrl.includes("DIT-BRUGERNAVN")) {
  console.warn("Husk at rette baseUrl i podcasts.json eller SITE_BASE_URL på GitHub.");
}

await mkdir(publicDir, { recursive: true });
await mkdir(join(publicDir, "assets"), { recursive: true });
await writeFile(join(publicDir, "assets", "style.css"), css(), "utf8");

// Tidligere udgivet tilstand: bruges som reserve, hvis en podcast fejler,
// og som cache for playlister, så ældre afsnit beholder deres spilleliste.
let previousManifest;
let previousPlaylists;
try {
  previousManifest = await fetchPublishedJson("manifest.json", { podcasts: [] });
  previousPlaylists = await fetchPublishedJson("playlists.json", {});
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const nextPlaylists = {};

let seriesIndex = null;
let seriesIndexError = null;
console.log("Henter serieliste");
try {
  seriesIndex = await loadSeriesIndex();
} catch (error) {
  seriesIndexError = error;
  console.warn(`Kunne ikke hente serielisten: ${error.message}`);
}

const rendered = [];
const report = { built: [], reused: [], failed: [], playlistProblems: [] };

for (const podcast of podcasts) {
  const slug = podcast.slug || slugFromFeedUrl(podcast.feedUrl);
  try {
    rendered.push(await buildPodcast(podcast, slug));
    report.built.push(slug);
  } catch (error) {
    console.warn(`Fejl i ${slug}: ${error.message}`);
    const reused = await reusePreviousFeed(podcast, slug);
    if (reused) {
      rendered.push(reused);
      report.reused.push({ slug, reason: error.message });
    } else {
      report.failed.push({ slug, reason: error.message });
    }
  }
}

const alertState = evaluateAlerts(report, rendered);

await writeFile(join(publicDir, "index.html"), renderIndex(rendered), "utf8");
await writeFile(
  join(publicDir, "manifest.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), podcasts: rendered, alerts: alertState.alerts }, null, 2),
  "utf8"
);
await writeFile(join(publicDir, "playlists.json"), JSON.stringify(nextPlaylists), "utf8");

await printReport(report);
await writeAlertOutput(alertState);

if (!report.built.length) {
  // Intet er bygget friskt: lad være med at udgive, så den nuværende side bliver stående.
  console.error("Ingen podcasts blev bygget. Udgiver ikke.");
  process.exit(1);
}

async function buildPodcast(podcast, slug) {
  if (!seriesIndex && !podcast.urn && !podcast.urns?.length) {
    throw new Error(`serielisten mangler (${seriesIndexError?.message || "ukendt fejl"}), og der er ingen urn`);
  }

  const resolved = resolvePodcast(seriesIndex, podcast, slug);
  // Samleserier (flere urns) skal blive på slug, så nye sæsoner kommer med automatisk.
  if (!podcast.urn && !podcast.urns?.length && resolved.urns.length === 1) {
    console.log(`  Tip: tilføj "urn": "${resolved.urns[0]}" til ${slug} i podcasts.json`);
  }

  console.log(`Bygger ${podcast.title || resolved.primary.title} (${slug})`);
  const showInfos = await Promise.all(resolved.urns.map((urn) => fetchJson(`${DR_API_URL}/series/${encodeURIComponent(urn)}`)));
  const primaryShow = showInfos.find((show) => show.id === resolved.primaryUrn) || showInfos[0];
  const episodeGroups = await Promise.all(resolved.urns.map((urn) => fetchEpisodes(urn)));
  const episodes = uniqueByProductionNumber(episodeGroups.flat())
    .sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));

  if (!episodes.length) {
    throw new Error("ingen episoder fundet");
  }

  const title = podcast.title || primaryShow.title || slug;
  const imageUrl =
    (await findPodcastImageUrl(slug).catch(() => "")) ||
    findRadioImageUrl(primaryShow);
  const feedUrl = `${baseUrl}/${slug}/feed.xml`;
  const targetDir = join(publicDir, slug);
  const playlists = podcast.includePlaylist
    ? await loadPlaylists(episodes, podcast.playlistEpisodeLimit ?? DEFAULT_PLAYLIST_LIMIT, title, slug)
    : new Map();

  await mkdir(targetDir, { recursive: true });
  await writeFile(
    join(targetDir, "feed.xml"),
    renderFeed({
      feedUrl,
      title,
      link: primaryShow.presentationUrl,
      description: `${primaryShow.description || ""}\nGenudgivet privat RSS-feed.`,
      imageUrl,
      imageLink: primaryShow.presentationUrl,
      category: primaryShow.categories?.[0] || "News",
      lastBuildDate: formatRssDate(new Date(episodes[0].publishTime)),
      items: episodes.map((episode) => toFeedItem(episode, primaryShow.presentationUrl, playlists.get(String(episodeKey(episode)))))
    }),
    "utf8"
  );

  return {
    slug,
    title,
    imageUrl,
    feedPath: `${slug}/feed.xml`,
    urns: resolved.urns
  };
}

async function reusePreviousFeed(podcast, slug) {
  if (!baseUrl) return null;
  try {
    const feed = await fetchWithRetry(`${baseUrl}/${slug}/feed.xml?t=${Date.now()}`, {}, { attempts: 2, read: (response) => response.text() });
    if (!feed.includes("<rss")) return null;

    await mkdir(join(publicDir, slug), { recursive: true });
    await writeFile(join(publicDir, slug, "feed.xml"), feed, "utf8");

    // Behold tidligere hentede playlister for denne podcast.
    for (const guid of feed.matchAll(/<guid[^>]*>([^<]+)<\/guid>/g)) {
      const key = unxml(guid[1]);
      if (previousPlaylists[key]) nextPlaylists[key] = previousPlaylists[key];
    }

    const previous = previousManifest.podcasts?.find((item) => item.slug === slug);
    console.warn(`Genbruger sidst udgivne feed for ${slug}.`);
    const imageMatch = /<itunes:image href="([^"]+)"/.exec(feed);
    return {
      slug,
      title: previous?.title || podcast.title || slug,
      imageUrl: previous?.imageUrl ?? (imageMatch ? unxml(imageMatch[1]) : ""),
      feedPath: `${slug}/feed.xml`,
      urns: previous?.urns || [],
      // Tidspunktet hvor podcasten første gang ikke kunne bygges.
      staleSince: previous?.staleSince || new Date().toISOString()
    };
  } catch (error) {
    console.warn(`Kunne heller ikke hente tidligere feed for ${slug}: ${error.message}`);
    return null;
  }
}

async function fetchPublishedJson(path, fallback) {
  if (!baseUrl) return fallback;
  try {
    return await fetchWithRetry(`${baseUrl}/${path}?t=${Date.now()}`, {}, { read: (response) => response.json() });
  } catch (error) {
    if (error.status === 404) {
      console.log(`Ingen tidligere ${path} fundet (det er normalt første gang).`);
      return fallback;
    }
    // Udgiver vi uden den gemte fil, mistes spillelister og alarm-tilstand.
    throw new Error(`Kunne ikke hente ${path} fra den udgivne side (${error.message}). Stopper uden at udgive, så intet gemt går tabt.`);
  }
}

// Samler problemer og afgør, hvilke der skal give mail nu.
// Tilstanden gemmes i manifest.json: hvornår hvert problem startede, og hvornår der sidst blev sendt mail.
function evaluateAlerts(report, rendered) {
  const now = Date.now();
  const previousAlerts = previousManifest.alerts || {};
  const problems = [];

  for (const item of report.reused) {
    const entry = rendered.find((podcast) => podcast.slug === item.slug);
    problems.push({
      key: item.slug,
      since: entry?.staleSince,
      minHours: STALE_ALERT_HOURS,
      message: (hours) => `${item.slug} er ikke opdateret i ${hours} timer: ${item.reason}`
    });
  }
  for (const item of report.failed) {
    problems.push({
      key: item.slug,
      minHours: 0,
      message: () => `${item.slug} mangler helt på siden: ${item.reason}`
    });
  }
  for (const item of report.playlistProblems) {
    problems.push({
      key: `${item.slug}:spilleliste`,
      minHours: STALE_ALERT_HOURS,
      message: (hours) => `${item.slug} har ikke fået spillelister i ${hours} timer: ${item.reason}`
    });
  }

  const alerts = {};
  const toMail = [];
  for (const problem of problems) {
    const previous = previousAlerts[problem.key] || {};
    const since = problem.since || previous.since || new Date(now).toISOString();
    const hours = Math.floor((now - new Date(since)) / 36e5);
    const message = problem.message(hours);
    let mailedAt = previous.mailedAt;

    if (hours < problem.minHours) {
      console.log(`::notice::${message} (mail sendes efter ${problem.minHours} timer)`);
    } else if (mailedAt && now - new Date(mailedAt) < ALERT_REPEAT_HOURS * 36e5) {
      console.log(`::warning::${message} (mail er allerede sendt inden for ${ALERT_REPEAT_HOURS} timer)`);
    } else {
      console.log(`::warning::${message}`);
      mailedAt = new Date(now).toISOString();
      toMail.push(message);
    }
    alerts[problem.key] = { since, ...(mailedAt ? { mailedAt } : {}) };
  }

  return { alerts, toMail };
}

async function writeAlertOutput({ toMail }) {
  if (!process.env.GITHUB_OUTPUT) return;
  const message = toMail.join(" | ").replace(/[\r\n]+/g, " ");
  await appendFile(process.env.GITHUB_OUTPUT, `alert=${toMail.length ? "true" : "false"}\nalert_message=${message}\n`);
}

function printReport({ built, reused, failed, playlistProblems }) {
  console.log("");
  console.log(`Bygget: ${built.length}  Genbrugt: ${reused.length}  Fejlet: ${failed.length}`);
  for (const item of reused) console.log(`  genbrugt  ${item.slug}: ${item.reason}`);
  for (const item of failed) console.log(`  fejlet    ${item.slug}: ${item.reason}`);
  for (const item of playlistProblems) console.log(`  spilleliste ${item.slug}: ${item.reason}`);

  if (process.env.GITHUB_STEP_SUMMARY && (reused.length || failed.length || playlistProblems.length)) {
    const lines = ["### Podcast-build", "", `Bygget: ${built.length} · Genbrugt: ${reused.length} · Fejlet: ${failed.length}`, ""];
    for (const item of reused) lines.push(`- ⚠️ genbrugt \`${item.slug}\`: ${item.reason}`);
    for (const item of failed) lines.push(`- ❌ fejlet \`${item.slug}\`: ${item.reason}`);
    for (const item of playlistProblems) lines.push(`- 🎵 spilleliste \`${item.slug}\`: ${item.reason}`);
    return appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`).catch(() => {});
  }
}

function resolvePodcast(index, podcast, slug) {
  index ||= { bySlug: new Map(), umbrellaGroups: new Map() };
  if (podcast.urns?.length) {
    return {
      urns: podcast.urns,
      primaryUrn: podcast.urns[0],
      primary: index.bySlug.get(slug) || { title: podcast.title || slug }
    };
  }

  if (podcast.urn) {
    return {
      urns: [podcast.urn],
      primaryUrn: podcast.urn,
      primary: index.bySlug.get(slug) || { title: podcast.title || slug }
    };
  }

  const umbrella = index.umbrellaGroups.get(slug);
  if (umbrella?.length > 1) {
    return {
      urns: umbrella.map((item) => item.id),
      primaryUrn: umbrella[0].id,
      primary: index.bySlug.get(slug) || umbrella[0]
    };
  }

  const show = index.bySlug.get(slug);
  if (!show) {
    throw new Error(`Kunne ikke finde serien "${slug}". Tjek slug i podcasts.json, eller tilføj urn.`);
  }

  return {
    urns: [show.id],
    primaryUrn: show.id,
    primary: show
  };
}

async function fetchEpisodes(urn) {
  const episodes = [];
  let url = `${DR_API_URL}/series/${encodeURIComponent(urn)}/episodes?limit=256`;

  while (url) {
    const data = await fetchJson(url);
    episodes.push(...(data.items || []));
    url = data.next ? String(data.next) : "";
  }

  return episodes;
}

async function findPodcastImageUrl(slug) {
  const xml = await fetchWithRetry(`https://api.dr.dk/podcasts/v1/feeds/${slug}.xml?format=podcast`, {}, {
    attempts: 2,
    read: (response) => response.text()
  });
  return (
    /<itunes:image[^>]+href="([^"]+)"/i.exec(xml)?.[1] ||
    /<image>\s*<url>(.*?)<\/url>/s.exec(xml)?.[1] ||
    ""
  );
}

function findRadioImageUrl(show) {
  const asset =
    show.imageAssets?.find((image) => image.target === "Podcast") ||
    show.imageAssets?.find((image) => image.target === "SquareImage") ||
    show.imageAssets?.find((image) => image.ratio === "1:1") ||
    show.imageAssets?.[0];

  return asset?.id ? `https://asset.dr.dk/drlyd/images/${asset.id}` : "";
}

async function loadPlaylists(episodes, limit, title, slug) {
  const fetchCount = Math.max(0, Number(limit) || 0);
  const playlists = new Map();
  let attempted = 0;
  let found = 0;
  let lastError = "";
  // Har podcasten haft spillelister før? Ellers er det ikke en fejl, at der ingen er.
  const hadPlaylists = episodes.some((episode) => previousPlaylists[String(episodeKey(episode))]?.length);

  console.log(`Henter playlister for de nyeste ${Math.min(fetchCount, episodes.length)} afsnit af ${title}`);

  for (const [index, episode] of episodes.entries()) {
    const key = String(episodeKey(episode));
    let tracks = null;

    // De nyeste afsnit hentes altid på ny (spillelisten kan blive udfyldt senere);
    // ældre afsnit bruger den gemte spilleliste fra sidste udgivelse.
    if (index < fetchCount) {
      attempted++;
      try {
        tracks = await fetchPlaylist(episode.presentationUrl);
        if (tracks.length) found++;
      } catch (error) {
        lastError = error.message;
        console.warn(`Kunne ikke hente playliste for ${episode.title}: ${error.message}`);
      }
    }

    if (!tracks?.length && previousPlaylists[key]?.length) {
      tracks = previousPlaylists[key];
    }

    if (tracks?.length) {
      playlists.set(key, tracks);
      nextPlaylists[key] = tracks;
    }
  }

  if (attempted > 0 && found === 0) {
    const reason = lastError
      ? `ingen af de ${attempted} nyeste afsnit gav en spilleliste (sidste fejl: ${lastError})`
      : `ingen af de ${attempted} nyeste afsnit havde en spilleliste – sidens opbygning kan være ændret`;
    if (hadPlaylists) {
      report.playlistProblems.push({ slug, reason });
    } else {
      console.warn(`Bemærk: ${title}: ${reason}.`);
    }
  }

  return playlists;
}

async function fetchPlaylist(pageUrl) {
  if (!pageUrl) return [];

  const page = await fetchWithRetry(pageUrl, {}, { attempts: 2, read: (response) => response.text() });
  const nextData = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(page)?.[1];
  if (!nextData) return [];

  const points = JSON.parse(nextData)?.props?.pageProps?.indexPoints || [];
  return points
    .filter((point) => point.type === "Track" && point.title)
    .map((point) => ({
      title: point.title,
      artist: point.description || point.roles?.map((role) => role.name).filter(Boolean).join(", ") || "",
      offsetMilliseconds: point.offsetMilliseconds || 0
    }));
}

function toFeedItem(episode, fallbackLink, playlist = []) {
  const audioAsset = (episode.audioAssets || [])
    .filter((asset) => asset.target === "Progressive" && asset.format === "mp3")
    .sort((a, b) => Math.abs((a.bitrate || 0) - 192) - Math.abs((b.bitrate || 0) - 192))[0];

  if (!audioAsset) return null;

  return {
    guid: episode.productionNumber || episode.id,
    link: episode.presentationUrl || fallbackLink,
    title: episode.title || "Uden titel",
    description: appendPlaylist(episode.description || "", playlist),
    contentHtml: renderDescriptionHtml(episode.description || "", playlist),
    pubDate: formatRssDate(new Date(episode.publishTime)),
    duration: formatDuration(episode.durationMilliseconds || 0),
    enclosureUrl: audioAsset.url,
    enclosureByteLength: audioAsset.fileSize || 0
  };
}

function appendPlaylist(description, playlist) {
  if (!playlist.length) return description;

  const tracks = playlist
    .map((track) => `${formatTrackTime(track.offsetMilliseconds)} ${track.artist ? `${track.artist} - ` : ""}${track.title}`)
    .join("\n");

  return `${description}\n\nSpilleliste:\n${tracks}`;
}

function renderDescriptionHtml(description, playlist) {
  const body = html(description).replace(/\n/g, "<br>");
  if (!playlist.length) return `<p>${body}</p>`;

  const tracks = playlist
    .map((track) => `<li>${formatTrackTime(track.offsetMilliseconds)} ${track.artist ? `${html(track.artist)} - ` : ""}${html(track.title)}</li>`)
    .join("");

  return `<p>${body}</p><p><strong>Spilleliste:</strong></p><ul>${tracks}</ul>`;
}

function episodeKey(episode) {
  return episode.productionNumber || episode.id;
}

function formatTrackTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

function renderFeed(feed) {
  const items = feed.items.filter(Boolean).map((item) => `
        <item>
            <guid isPermaLink="false">${xml(item.guid)}</guid>
            <link>${xml(item.link)}</link>
            <title>${xml(item.title)}</title>
            <description>${xml(item.description)}</description>
            <content:encoded><![CDATA[${cdata(item.contentHtml)}]]></content:encoded>
            <pubDate>${xml(item.pubDate)}</pubDate>
            <explicit>no</explicit>
            <itunes:author>DR</itunes:author>
            <itunes:duration>${xml(item.duration)}</itunes:duration>
            <media:restriction relationship="allow" type="country">dk</media:restriction>
            <enclosure length="${xml(item.enclosureByteLength)}" type="audio/mpeg" url="${xml(item.enclosureUrl)}"/>
        </item>`).join("");

  const image = feed.imageUrl ? `
        <image>
            <url>${xml(feed.imageUrl)}</url>
            <title>${xml(feed.title)}</title>
            <link>${xml(feed.imageLink)}</link>
        </image>
        <itunes:image href="${xml(feed.imageUrl)}"/>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/" version="2.0">
    <channel>
        <atom:link href="${xml(feed.feedUrl)}" rel="self" type="application/rss+xml"/>
        <title>${xml(feed.title)}</title>
        <link>${xml(feed.link)}</link>
        <description>${xml(feed.description)}</description>
        <language>da</language>
        <copyright>DR</copyright>
        <managingEditor>no-reply@example.invalid</managingEditor>
        <lastBuildDate>${xml(feed.lastBuildDate)}</lastBuildDate>
        <itunes:explicit>no</itunes:explicit>
        <itunes:author>DR</itunes:author>
        <itunes:owner>
            <itunes:email>no-reply@example.invalid</itunes:email>
            <itunes:name>DR</itunes:name>
        </itunes:owner>
        <itunes:new-feed-url>${xml(feed.feedUrl)}</itunes:new-feed-url>${image}
        <itunes:category text="${xml(feed.category)}"/>
        <media:restriction relationship="allow" type="country">dk</media:restriction>${items}
    </channel>
</rss>
`;
}

function renderIndex(rendered) {
  const cards = rendered
    .sort((a, b) => a.title.localeCompare(b.title, "da"))
    .map((podcast) => `
      <a class="podcast" href="${html(podcast.feedPath)}" data-title="${html(podcast.title.toLowerCase())}">
        ${podcast.imageUrl ? `<img src="${html(podcast.imageUrl)}" alt="${html(podcast.title)}">` : `<span class="cover">${html(podcast.title.slice(0, 1))}</span>`}
        <strong>${html(podcast.title)}</strong>
        <small>RSS-feed</small>
      </a>`)
    .join("\n");

  return `<!doctype html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(siteTitle)}</title>
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  <header>
    <h1>${html(siteTitle)}</h1>
    <p>Private RSS-feeds bygget fra dine valgte podcasts.</p>
  </header>
  <main>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Søg i dine podcasts" aria-label="Søg i dine podcasts">
    </div>
    <section class="grid" id="podcasts">
${cards}
    </section>
  </main>
  <script>
    const input = document.querySelector("#search");
    const cards = [...document.querySelectorAll(".podcast")];
    input.addEventListener("input", () => {
      const value = input.value.trim().toLowerCase();
      for (const card of cards) {
        card.hidden = value && !card.dataset.title.includes(value);
      }
    });
  </script>
</body>
</html>
`;
}

function uniqueByProductionNumber(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.productionNumber || item.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slugFromFeedUrl(feedUrl) {
  const match = /\/feeds\/([^/?]+)(?:\.xml)?/i.exec(feedUrl || "");
  if (!match) throw new Error(`Kan ikke finde slug i feedUrl: ${feedUrl}`);
  return match[1];
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatRssDate(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, "0")} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")} +0000`;
}

// Tegn, der ikke er tilladt i XML (kontroltegn og enlige surrogat-tegn), fjernes, så feedet altid er gyldigt.
function stripInvalidXml(value = "") {
  return String(value).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ""
  );
}

function xml(value = "") {
  return stripInvalidXml(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function html(value = "") {
  return xml(value);
}

function cdata(value = "") {
  return stripInvalidXml(value).replaceAll("]]>", "]]]]><![CDATA[>");
}

function unxml(value = "") {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function css() {
  return `
:root {
  color-scheme: light;
  font-family: Arial, Helvetica, sans-serif;
  background: #f6f4ef;
  color: #17211f;
}

body { margin: 0; }

header, main {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 18px;
}

header { padding-top: 40px; }

h1 {
  margin: 0 0 8px;
  font-size: 34px;
}

p {
  margin: 0;
  color: #52605c;
}

.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin: 18px 0 24px;
}

input {
  width: 100%;
  max-width: 440px;
  padding: 12px 14px;
  border: 1px solid #ccd4cf;
  border-radius: 8px;
  font-size: 16px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
}

.podcast {
  display: block;
  color: inherit;
  text-decoration: none;
}

.podcast[hidden] { display: none; }

.podcast img, .cover {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 8px;
  background: #d8ded9;
}

.cover {
  display: grid;
  place-items: center;
  font-size: 54px;
  font-weight: 700;
}

.podcast strong {
  display: block;
  margin-top: 8px;
  line-height: 1.25;
}

.podcast small { color: #69736f; }
`.trimStart();
}
