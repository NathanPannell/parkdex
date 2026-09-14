.PHONY: install migrate api frontend test

install:
	python -m pip install -r backend/requirements-dev.txt
	cd frontend && npm install

migrate:
	python -m backend.app.migrate

api:
	python -m uvicorn backend.app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

test:
	python -m pytest backend/tests
	cd frontend && npm run lint && npm run typecheck

