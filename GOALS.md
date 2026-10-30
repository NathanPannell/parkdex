# Goals

What Parkdex is working towards right now. A daily status routine reads this file from `origin/staging`, so keep it current: tick a goal off in the same PR as the work that finishes it, and add new goals here.

- Code features live in GitHub issues. Each goal links its issues instead of copying them.
- Non-code goals (accounts, store listings, outreach) are tracked here as checklists.
- Each goal says who it's waiting on: **Nathan** (needs his accounts, money or a decision) or **agent**.

_Last reviewed: 2026-10-30._

## 1. Parkdex on the iOS App Store

Android has been live on Google Play (Canada) since 2026-10-28. iOS code is on `staging`; no TestFlight build yet.

- The full checklist is [`docs/app-store-launch.md`](docs/app-store-launch.md). Tick items off there, not here.
- [ ] Apple Developer Program enrollment (A1). **Nathan.** Everything else on the list waits on it.
- [ ] Refresh the local `VERCEL_TOKEN` (R1). **Nathan.**
- [ ] First TestFlight build, then App Review.

## 2. Polish the App Store and Play Store pages

- [ ] Play listing: new screenshots from the current app, short and full description reviewed, feature graphic. **Agent** drafts, **Nathan** enters it in Play Console (managed publishing: someone clicks Publish).
- [ ] App Store Connect metadata (section M of `docs/app-store-launch.md`): name, subtitle, description, keywords, screenshots for each required device size. Blocked by the App Store Connect app record (A6).
- [ ] Same screenshots and copy on parkdex.app (`parkdex-landing`).

## 3. A photo at every park

- [ ] UX that gets players to take a photo at each park they check in at: #243.

## 4. Golden Kip ($100 prize)

A golden Kip hides in a park in BC. Anyone taking a check-in photo has a chance to see it overlaid on their camera; whoever sees it wins $100. (Junaid's idea, to attract users.)

- [ ] Backend: campaign, server-side roll on check-in, claims and payout tracking: #242.
- [ ] Camera overlay and reveal (client): issue to open after #242.
- [ ] Official contest rules on parkdex.app (no purchase necessary, skill-testing question, Quebec). **Nathan** approves the wording.
- [ ] Launch announcement. **Nathan.**

## Done

- 2026-10-28: Live on Google Play, Canada (vc19, 1.6.0).
