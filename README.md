# Min Podcast RSS

Privat RSS-side, hvor du selv bestemmer hvilke podcasts der skal med.

Projektet bygger en lille oversigtsside og et RSS-feed pr. podcast. Listen styres fra `podcasts.json`, og GitHub Actions kan opdatere feeds automatisk.

## Styr Podcastlisten

Ret `podcasts.json`.

Eksempel:

```json
{
  "siteTitle": "Mine Podcasts",
  "baseUrl": "https://pwb0186.github.io/min-podcast",
  "podcasts": [
    {
      "slug": "genstart",
      "title": "Genstart"
    }
  ]
}
```

Naar du vil tilfoeje en podcast, tilfoejer du et nyt punkt i listen:

```json
{
  "slug": "stjerner-og-striber",
  "urn": "urn:...",
  "title": "Stjerner og striber"
}
```

`slug` bestemmer feed-adressen. `urn` er et internt serie-id, som goer opslaget mere stabilt, hvis et navn aendrer sig.

## Playlister I Musikprogrammer

For et musikprogram kan playlisten tilfoejes til beskrivelsen af de nyeste afsnit:

```json
{
  "slug": "flex",
  "title": "Flex",
  "includePlaylist": true
}
```

Som standard hentes playlisten til de nyeste 5 afsnit. Du kan aendre antallet:

```json
{
  "slug": "flex",
  "title": "Flex",
  "includePlaylist": true,
  "playlistEpisodeLimit": 10
}
```

Hold gerne tallet moderat, fordi hver playliste kraever et ekstra opslag, hver gang feeds opdateres.

Hentede playlister gemmes i `playlists.json` paa den udgivne side. Naeste gang genbruges de, saa aeldre afsnit beholder deres spilleliste, ogsaa efter de er faldet ud af de nyeste.

Spillelisten skrives baade som tekst i beskrivelsen og som HTML-liste (`content:encoded`), saa podcast-apps der viser HTML faar et linjeskift pr. nummer.

## Find Korrekt Slug

Hvis du har Node.js installeret lokalt, kan du soege saadan:

```bash
npm run search -- stjerner
```

eller:

```bash
npm run search -- "p6 elsker"
```

Soegningen viser en JSON-blok, som kan kopieres direkte ind i `podcasts.json`.

Du kan ogsaa redigere listen manuelt uden at bruge `npm`.

## Byg Lokalt

Hvis du har Node.js installeret:

```bash
npm run build
```

Det laver en `public`-mappe med:

- `index.html`
- et RSS-feed pr. valgt podcast

## GitHub Pages

1. Gaa til repositoryets `Settings`.
2. Gaa til `Pages`.
3. Vaelg `GitHub Actions` som source.
4. Gaa til `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`.
5. Opret variablen `SITE_BASE_URL`.

For dette repository er vaerdien:

```text
https://pwb0186.github.io/min-podcast
```

`SITE_BASE_URL` bruges til at skrive de rigtige feed-adresser.

## Automatisk Opdatering

Workflowet ligger her:

```text
.github/workflows/update-feeds.yml
```

GitHubs egen tidsplan var ustabil og sprang koersler over. Koerslerne startes derfor udefra via cron-job.org:

```text
https://cron-job.org/
```

cron-job.org kalder GitHub API'et med `workflow_dispatch`. Tidspunkterne styres derinde.

GitHubs egen schedule i workflow-filen (en gang i doegnet kl. 03:23 UTC) ligger kun som backup. Workflowet kan ogsaa koeres manuelt under fanen `Actions`.

## Brug I Podcast-App

Naar siden er bygget og udgivet, kan et feed bruges saadan:

```text
https://pwb0186.github.io/min-podcast/genstart/feed.xml
```

Du kan ogsaa aabne forsiden:

```text
https://pwb0186.github.io/min-podcast
```

og vaelge feedet derfra.

## Fejlfinding

Hvis buildet fejler med `Kunne ikke finde serien`, er sluggen sandsynligvis ikke den rigtige. Brug soegekommandoen:

```bash
npm run search -- soegeord
```

og kopier JSON-blokken med `slug`, `urn` og `title`.

Hvis buildet fejler med `SyntaxError` i `podcasts.json`, mangler der typisk et komma mellem to podcasts, eller der er et ekstra komma efter den sidste.

Hvis en enkelt podcast fejler, fortsaetter buildet. Det sidst udgivne feed for den podcast genbruges, saa den ikke forsvinder fra siden. Oversigten nederst i build-loggen (og i `Summary` paa GitHub Actions-koerslen) viser hvilke podcasts der blev bygget, genbrugt eller fejlede. Kun hvis ingen podcasts kan bygges, stopper workflowet uden at udgive.

Hvis loggen siger `adgang naegtet (401/403)`, er API-noeglen sandsynligvis udskiftet. Opret eller ret variablen `DR_API_KEY` under `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`. Den bruges i stedet for den indbyggede noegle.
