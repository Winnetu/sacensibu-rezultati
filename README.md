# Sacensibu rezultati

This project polls two local RACE RESULT pages every minute and publishes the raw HTML results to GitHub:

- `vecuma-grupas.html` — age-group results
- `kopvertejums.html` — overall results

The script commits and pushes only when a result page changes. It keeps the original HTML unchanged so the saved files can be opened directly or served with GitHub Pages.

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

The first cycle runs immediately. The next cycle starts 60 seconds after the previous cycle finishes. Press `Ctrl+C` to stop it.

Edit `config.json` to change the polling interval, API URLs, output filenames, remote, or branch.

## GitHub

The script uses the existing `origin` remote and pushes to `main`. Because the repository starts empty, the first successful cycle creates the initial commit and pushes it. If the remote branch has been created independently, synchronize it manually before running the script.

If GitHub Pages is enabled for this repository, configure it to publish from the branch and folder containing these files. The result pages may generate a commit approximately once per minute while participants' results are changing.

If a fetch fails, returns a non-OK response, or does not look like a result-list page, that cycle is skipped and the last good files are preserved. If a push fails, the commit remains local and the next changed cycle can retry after the Git issue is fixed.
