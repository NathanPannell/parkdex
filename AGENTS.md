# Parkdex workflow

- Create feature branches from `staging` and target feature pull requests to `staging`.
- Keep `staging` long-lived; it deploys to `staging.parkdex.app` with persistent, isolated Neon and Railway resources.
- Use `main` for production at `parkdex.app`. Promote to production only when explicitly requested.
- Preserve legacy browser storage keys and API compatibility when changing branding or progress data.
