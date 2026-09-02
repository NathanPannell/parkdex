# __APP_NAME__

A reusable full-stack starter: Next.js on Vercel, FastAPI API and worker on Railway, Neon Postgres, and GitHub Actions-managed production and per-PR environments.

The included uptime monitor is a small vertical slice to prove browser → API → database → worker behavior. Replace that feature while keeping the deployment contract.

## First-time bootstrap

This repository is designed to be created by the `full-stack-bootstrap` Codex skill. Until the bootstrap sets the GitHub variable `BOOTSTRAP_COMPLETE=true`, CI runs but no cloud deployment occurs.

The bootstrap creates a separate GitHub repository, Neon project, Railway project, and Vercel project; installs provider IDs as GitHub variables; installs automation tokens as GitHub secrets; configures production database URLs directly in Railway; and performs the first deploy.

Never commit provider tokens, `.env`, `.env.local`, `.neon`, or `.vercel`. Application database URLs belong in Railway, not GitHub.

## Run locally

Requirements: Docker, Python 3.13+, and Node 22+.

```bash
docker compose up -d postgres
cp .env.example .env.local
python -m venv .venv
# Activate .venv, then:
python -m pip install -r backend/requirements-dev.txt
python -m backend.app.migrate
```

Run these in separate terminals:

```bash
python -m uvicorn backend.app.main:app --reload --port 8000
python -m backend.worker.main
cd frontend && npm install && npm run dev
```

Open `http://localhost:3000`. `/health` is liveness-only; `/ready` proves the database schema is readable and reports the deployed commit.

## Test

```bash
python -m pytest backend/tests
cd frontend
npm run lint
npm run typecheck
npm run build
```

## Deployment contract

Production deploys run after CI on `main`. PRs from branches in this repository receive one Neon branch, one duplicated Railway environment containing API and worker services, and one Vercel deployment. Closing the PR removes all three preview resources.

Runtime connections are pooled. Migrations use direct Neon URLs because advisory locks and other session behavior must not pass through transaction pooling. Preview readiness waits for the exact Git commit and a readable migrated database, preventing an old restarted Railway container from being mistaken for the new deployment.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the lifecycle and recovery rules.
