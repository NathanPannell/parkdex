# Every Park

Every Park is a mobile-first field guide and collection game for Vancouver Island parks and nearby islands. Explore a clustered interactive map, search or filter the catalogue, open a place card, and check off visits with immediate progress feedback.

The official-source v0 catalogue contains 216 places: 2 national park reserves, 136 provincial parks, 53 regional parks, and 25 curated major or commonly visited islands. Regional coverage is strongest for CRD, RDN, and CVRD; the in-app info panel explains known gaps, and every place card links to its source. Map pins are representative centres rather than entrances or trailheads.

The application uses Next.js and MapLibre on Vercel, a FastAPI API and worker on Railway, and Neon Postgres. Database migrations and production or pull-request environments are managed through GitHub Actions.

## Anonymous collections

There are no accounts. On first use, the browser creates a random collection key and stores it locally. The API stores only a hash of that key, which keeps different browsers' check-offs isolated. Progress, catalogue data, and pending changes are cached locally so check-offs remain responsive offline and sync when connectivity returns. Clearing browser storage starts a new collection and cannot recover the previous one.

## Local development

Requirements: Docker, Python 3.13+, and Node 22+.

```bash
docker compose up -d postgres
cp .env.example .env.local
cp frontend/.env.example frontend/.env.local
python -m venv .venv
# Activate .venv, then:
python -m pip install -r backend/requirements-dev.txt
python -m backend.app.migrate
cd frontend && npm install
```

Run these in separate terminals:

```bash
python -m uvicorn backend.app.main:app --reload --port 8000
python -m backend.worker.main
cd frontend && npm run dev
```

Open `http://localhost:3000`. The frontend expects the API at `http://localhost:8000` through `frontend/.env.local`. `/health` checks process liveness; `/ready` checks database access and reports the migration count and deployed commit.

## Tests

```bash
python -m pytest backend/tests
cd frontend
npm test
npm run lint
npm run typecheck
npm run build
```

## Rebuild the catalogue seed

The reviewed catalogue lives in `data/places.json`. After the first deployment, rebuild it from the official sources, validate its contract and scope guards, then create the next append-only SQL migration:

```bash
node scripts/data-build.mjs
node scripts/data-validate.mjs
python scripts/build_seed_migration.py --new 0005_refresh_places.sql
python scripts/build_seed_migration.py --check
python -m pytest backend/tests/test_seed.py
```

Increase the migration number on later refreshes. Never edit an applied migration; `--replace-unreleased` is reserved for correcting the initial seed before its first deployment. Removed places are retired from the active catalogue while their visit history is preserved. Review `data/coverage-audit.json` after each rebuild. Detailed source coverage and coordinate rules are documented in [data/README.md](data/README.md).

## Deployment contract

Production deploys run after CI on `main`: migrations apply to Neon, the API and catalogue worker deploy to Railway, and the mobile frontend deploys to Vercel. `/health` proves process liveness; `/ready` must report `ready`, the exact Git commit, and readable migrations before the workflow advances.

Runtime connections are pooled. Migrations use the direct Neon URL because advisory locks and other session behavior must not pass through transaction pooling. Railway receives the exact Vercel deployment and production origins for CORS after each frontend deploy.

Same-repository pull requests from the trusted bootstrap actor receive one isolated Neon branch, one Railway `pr-N` environment with API and worker services, and one Vercel preview. Closing the pull request removes all three preview resources. Preview readiness also checks the exact commit and readable migrations so a restarted stale container cannot pass.

Production smoke verifies a non-empty place catalogue, then uses a generated collection key to mark one place visited, confirms anonymous and second-key isolation, resets it, and verifies the cleanup read. Collection keys are sent only in `X-Collection-Key`; they are never stored in the repository or deployment logs. Worker verification requires a positive catalogue database read logged by the exact deployed commit.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the lifecycle and recovery rules.
