# Sacensibu rezultati

This project polls three local RACE RESULT pages every minute and publishes a static website to the `live` branch on GitHub:

- `starta-saraksts.html` — Starta saraksts
- `vecuma-grupas.html` — Rezultāti vecuma grupās
- `kopvertejums.html` — Rezultāti
- `index.html` — homepage linking to all three result pages

The result tables and data are preserved from the local server; the publisher adds only a link to the shared `styles.css` file for presentation. A new commit is pushed to `live` only when result data or styling changes. The source code and configuration stay on `main`.

## Requirements

- Node.js 18 or newer
- Git
- The local results server available at the URLs in `config.json`
- Git authentication configured for the repository remote (Git Credential Manager works on Windows)

## Run

From this directory:

```text
npm start
```

On Windows, you can double-click `start-results.bat` instead. It starts the same long-running publisher from the repository directory.

The first cycle runs immediately. The next cycle starts 60 seconds after the previous cycle finishes. Press `Ctrl+C` to stop it.

Edit `config.json` to change the polling interval, API URLs, output filenames, remote, or publishing branch.

## Enable GitHub Pages

In the GitHub repository:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select branch **`live`** and folder **`/ (root)`**.
4. Click **Save**.

GitHub will show the published site URL in the Pages settings. The pages will be available at:

```text
https://winnetu.github.io/sacensibu-rezultati/
https://winnetu.github.io/sacensibu-rezultati/starta-saraksts.html
https://winnetu.github.io/sacensibu-rezultati/vecuma-grupas.html
https://winnetu.github.io/sacensibu-rezultati/kopvertejums.html
```

The Node.js process must remain running on the computer where the local results server is available. GitHub Pages only serves files that have already been pushed to `live`; it cannot access `localhost` directly.

## Repository privacy

You can make the GitHub repository private if your GitHub plan allows Pages for private repositories. However, the Pages website is **public on the internet by default**, even when the repository is private. Making the repository private does not make the published result pages private.

Private GitHub Pages sites require GitHub Enterprise Cloud organization access control. For a public results website, a private repository with a public Pages site is suitable; do not publish sensitive information in the generated HTML.

## Safety behavior

If a fetch fails, returns a non-OK response, or does not look like a result-list page, that cycle is skipped and the last good published files are preserved. If a push fails, the error is logged and the existing published files remain unchanged on GitHub; fix the Git issue before the next update.
