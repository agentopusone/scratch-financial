# scratch-financial

A small project that demonstrates a resilient scraper for a hostile, drift-prone invoice page.

## Docs
- Hostile site specification: `docs/hostile-website-features.md`
- Hostile scraper specification: `docs/hostile-scraper-features.md`

## Setup
1. Clone the repo
   - git clone git@github.com:agentopusone/scratch-financial.git
2. Enable and prepare Yarn if you do not have it
   - PowerShell: `corepack enable; corepack prepare yarn@stable --activate`
3. Install dependencies
   - PowerShell: `yarn install`
4. Install Playwright browser binaries (required to run the scraper)
   - PowerShell: `yarn dlx playwright install`

## Development server
The project includes a small dev server that serves the `src` directory so you can iterate without relying on compiled output.

- Start the dev server (serves `src` on http://localhost:3000)
  - PowerShell: `yarn serve:dev`

## Running the scraper (development)
The scraper runs with Playwright. During development we use `ts-node` so you can run TypeScript directly.

- Example (PowerShell):
  - `$env:HEADLESS='false'; $env:FRAME_TIMEOUT='10000'; yarn dlx ts-node ./src/scraper/scrape_hostile.ts`

Environment variables:
- `HEADLESS` (default `false`) set to `true` to run browsers headless.
- `FRAME_TIMEOUT` (milliseconds) default `8000` controls waits for frame and selectors.

## Build and run (production-like)
The project compiles TypeScript into `dist` and copies HTML assets. If you prefer to run the compiled files:

- Build
  - PowerShell: `yarn build`
- Run the compiled server
  - PowerShell: `yarn start`

Note: There is an intentional dev workflow using `ts-node` because compiled output may require verifying that non-TS assets are present in `dist`.

## Tests
Unit tests are implemented with Mocha and JSDOM to cover the extraction and normalization heuristics.

- Run tests
  - PowerShell: `yarn test`

## Debugging and artifacts
On error the scraper saves a screenshot and HTML into the `logs` folder. Check `logs/` after a failure for artifacts to help debugging.

## Contact
See the repository for more details and the `docs` folder for design notes and the hostile site specification.