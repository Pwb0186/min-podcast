// Fælles kode for build, search og add: netværkskald og slug-logik.

export const DR_API_KEY = process.env.DR_API_KEY || "6Wkh8s98Afx1ZAaTT4FuWODTmvWGDPpR";
export const DR_API_URL = process.env.DR_API_URL || "https://api.dr.dk/radio/v2";

const REQUEST_TIMEOUT_MS = 20000;
const RETRY_ATTEMPTS = 3;
const USER_AGENT = "privat-podcast-manager/2.0";

// Henter en adresse med timeout og genforsøg. `read` læser svaret (fx JSON)
// inde i genforsøgene, så et ugyldigt svar med status 200 også prøves igen.
// Fejl har `status` (HTTP-status), når serveren svarede.
export async function fetchWithRetry(url, options = {}, { attempts = RETRY_ATTEMPTS, read } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "user-agent": USER_AGENT, ...options.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.ok) {
        return read ? await read(response) : response;
      }

      if (response.status === 401 || response.status === 403) {
        // Giver ikke mening at prøve igen – typisk er nøglen udskiftet.
        throw httpError(
          `adgang nægtet (${response.status}) for ${shortUrl(url)}. API-nøglen er muligvis udskiftet – opdater variablen DR_API_KEY.`,
          response.status
        );
      }
      if (response.status === 404) {
        throw httpError(`ikke fundet (404): ${shortUrl(url)}`, 404);
      }
      lastError = Object.assign(new Error(`svarede ${response.status} for ${shortUrl(url)}`), { status: response.status });
    } catch (error) {
      if (error.fatal) throw error;
      if (error.name === "TimeoutError") {
        lastError = new Error(`timeout efter ${REQUEST_TIMEOUT_MS / 1000}s for ${shortUrl(url)}`);
      } else if (error instanceof SyntaxError) {
        lastError = new Error(`ugyldigt svar fra ${shortUrl(url)}: ${error.message}`);
      } else {
        lastError = error;
      }
    }
    if (attempt < attempts) {
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export function fetchJson(url) {
  return fetchWithRetry(url, {
    headers: {
      "accept": "application/json",
      "referer": "https://www.dr.dk/",
      "x-apikey": DR_API_KEY
    }
  }, { read: (response) => response.json() });
}

export async function loadSeriesIndex() {
  const data = await fetchJson(`${DR_API_URL}/series?limit=10000`);
  const items = (data.items || []).filter((item) => item.type === "Series");
  if (!items.length) {
    throw new Error("serielisten var tom");
  }

  const bySlug = new Map();
  const umbrellaGroups = new Map();

  for (const item of items) {
    const derivedSlug = deriveSlug(item);
    const presentationSlug = derivePresentationSlug(item);
    const umbrellaSlug = deriveUmbrellaSlug(item.umbrella);
    if (derivedSlug) bySlug.set(derivedSlug, item);
    if (presentationSlug) bySlug.set(presentationSlug, item);
    if (umbrellaSlug && item.id) {
      const group = umbrellaGroups.get(umbrellaSlug) || [];
      group.push(item);
      umbrellaGroups.set(umbrellaSlug, group);
    }
  }

  return { items, bySlug, umbrellaGroups };
}

export function deriveSlug(item) {
  return normalizeSlug(lastPathPart(item.podcastUrl) || item.psdbSlug || item.slug || "");
}

export function derivePresentationSlug(item) {
  return normalizeSlug(lastPathPart(item.presentationUrl) || item.slug || "");
}

export function deriveUmbrellaSlug(umbrella) {
  if (!umbrella) return "";
  return normalizeSlug(lastPathPart(umbrella.presentationUrl) || umbrella.slug || "");
}

export function normalizeSlug(value) {
  return String(value)
    .replace(/\.xml.*$/, "")
    .replace(/-\d+$/, "")
    .replace(/^sara-og-monopolet-podcast$/, "sara-og-monopolet")
    .replace(/^mads-monopolet-podcast$/, "sara-og-monopolet")
    .replace(/^hjernekassen-paa-p1$/, "hjernekassen")
    .replace(/^hjernekassen-pa-p1$/, "hjernekassen")
    .replace(/^moerklagt-agent-samsam$/, "moerklagt");
}

function lastPathPart(url) {
  return url ? String(url).split("/").filter(Boolean).at(-1) : "";
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status, fatal: true });
}

function shortUrl(url) {
  return String(url).replace(/\?.*$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
