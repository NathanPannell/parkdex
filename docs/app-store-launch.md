# App Store launch checklist

Everything still left to get Parkdex onto the iOS App Store. Tick items off here as they land, in the same PR as the work where there is one.

This is a checklist only. The how-to for each step is in `docs/ios.md`; follow the links rather than copying detail here.

Where things stand (2026-10-30):

- Android has been live on Google Play since 2026-10-28 (versionCode 19, 1.6.0, Canada).
- iOS parity is merged to `staging` but not yet on `main`. That covers the server side (#239: Sign in with Apple, Apple token revocation, `GOOGLE_IOS_CLIENT_ID`, `platform=ios` app config with the `ios/0` row, `apple-app-site-association`) and the client (#240: Swift plugins, entitlements, privacy manifest, TestFlight signing, `docs/ios.md`).
- The iOS simulator check passed, and the staging API serves the iOS paths.
- No TestFlight build exists yet.

Each item names **who** does it and what it is **blocked by**. IDs (A1, R2, ...) are only for those cross-references.

## A. Apple account and console

All of these are **Nathan**'s: they need his Apple and Google accounts. Steps refer to `docs/ios.md` > "Apple-side setup".

- [ ] **A1. Enroll** in the Apple Developer Program (step 1). **Nathan.** Not blocked.
- [ ] **A2. Note the team ID** (step 2). **Nathan.** Blocked by A1.
- [ ] **A3. Register the App ID** `app.parkdex` with Sign in with Apple and Associated Domains (step 3). **Nathan.** Blocked by A1.
- [ ] **A4. Create the Sign in with Apple key** (`.p8` and key ID; step 4). **Nathan.** Blocked by A3.
- [ ] **A5. Register the `AUTH_EMAIL_FROM` domain** with Apple's private email relay (step 5). **Nathan.** Blocked by A1.
- [ ] **A6. Create the App Store Connect app record** (step 6). **Nathan.** Blocked by A3.
- [ ] **A7. Create the Admin App Store Connect API key** (step 7). **Nathan.** Blocked by A1.
- [ ] **A8. Add the four repository secrets** (step 8). **Nathan.** Blocked by A2 and A7.
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_API_KEY_P8`
  - `APPLE_TEAM_ID`
- [ ] **A9. Add the four runtime keys** to both `KIP_STAGING_EXTRA_RUNTIME_JSON` and `KIP_PRODUCTION_EXTRA_RUNTIME_JSON` (step 9). **Nathan.** Blocked by A2, A4 and A10. Add the Sign in with Apple key before App Review: accounts deleted before it exists can't have their Apple tokens revoked later.
  - `APPLE_TEAM_ID`
  - `APPLE_SIGN_IN_KEY_ID`
  - `APPLE_SIGN_IN_PRIVATE_KEY`
  - `GOOGLE_IOS_CLIENT_ID`
- [ ] **A10. Create the iOS Google OAuth client** (type iOS, bundle `app.parkdex`, in the project that holds the web client; step 10). **Nathan.** Not blocked: it needs no Apple account and can be done today.
- [ ] **A11. Create the internal TestFlight group** and add your Apple ID (step 11). **Nathan.** Blocked by A6.

## R. Releases

- [ ] **R1. Refresh the local Vercel token** in the delivery loader. **Nathan** (it is a credential), then **agent** checks it. Not blocked. It returned 403 during the #240 delivery, so `assign-staging` and `assign-main` fail until it is replaced.
- [ ] **R2. First staging TestFlight build:** tag `ios-testflight/staging/1` at `origin/staging` and push it (`docs/ios.md` > "First TestFlight build"). **Agent.** Blocked by A8, A9 (staging) and A11. Before tagging, check that `https://staging.web.parkdex.app/.well-known/apple-app-site-association` names `<team id>.app.parkdex`.
- [ ] **R3. Promote #239 and #240 to `main`** in a `staging` → `main` PR. **Agent**, and it **needs Nathan's yes** to open and to merge. Blocked by R1 (for `assign-main`). The release seeds the production `ios/0` app config row through `app_config_004_ios.sql`, which a production build needs.
- [ ] **R4. Production TestFlight build** (`ios-testflight/production/<label>`). **Agent.** Blocked by R3 and A9 (production). This is the build that goes to App Review.

## P. Privacy policy

- [ ] **P1. Add Sign in with Apple** next to Google sign-in at `https://parkdex.app/privacy/`. **Nathan or agent**, in the `parkdex-landing` repository, as its own PR there. Do not edit that repository from here. Not blocked. Must be live before S1.

## D. On-device verification

- [ ] **D1. Run the "On a real iPhone only" list** in `docs/ios.md` on a TestFlight build. **Nathan.** Blocked by R2 for staging, and repeat the sign-in items on R4 for production. Apple token revocation on deletion also needs A9.
- [ ] **D2. Check content-CDN art on the device.** The simulator log showed three WebKit `WEBP initImage failed err=-50` lines. Kip art rendered fine there, so look for missing or broken badge and park art from `kip-assets.parkdex.app`. **Nathan** spots it; **agent** fixes it if something is broken. Blocked by R2.

## M. App Store Connect metadata

All in App Store Connect > the app, blocked by A6. **Nathan** enters them; an **agent** can draft any of the copy on request.

- [ ] **M1. Name and subtitle.** Name `Parkdex`.
- [ ] **M2. Description and keywords.**
- [ ] **M3. Category.** Pick the primary and an optional secondary category.
- [ ] **M4. Age rating questionnaire.** Answer it. User-generated content (handles, flags, photos, feedback) and location are the parts to answer carefully.
- [ ] **M5. Price and availability.** Free. Canada only, matching Play.
- [ ] **M6. App Privacy answers.** Enter the table from `docs/ios.md` > "App Privacy answers". It must match `ios/App/App/PrivacyInfo.xcprivacy`.
- [ ] **M7. 6.9" screenshots.** Upload the five 1320 × 2868 PNGs from `npm run ios:screenshots` (`docs/ios.md` > "Screenshots"). A copy is in `C:\repo\parkdex-workspace\output\app-store-6.9-20261029\`. Regenerate them if the UI changes first (see section C).
- [ ] **M8. URLs.**
  - Support: `https://parkdex.app/support/`
  - Privacy policy: `https://parkdex.app/privacy/` (blocked by P1 for the content)
- [ ] **M9. Review notes.** Use the text in `docs/ios.md` > "Review notes", plus the recording or demo location from V1.
- [ ] **M10. App Review contact.** Name, phone and email for App Review Information.

## V. App Review risks

- [ ] **V1. Guideline 2.1 (app completeness).** Planting a flag needs a real visit inside a park on Vancouver Island, so a reviewer can't try the core action. **Nathan** decides which to prepare before S1:
  - a short screen recording of a real visit, attached to the review notes, or
  - a review-only demo location (would need an **agent** to build it; nothing like it exists today).
- [x] **V2. Guideline 4.8 (Sign in with Apple)** is covered: Sign in with Apple appears wherever Google does (`docs/ios.md` > "How iOS differs from Android at runtime").
- [x] **V3. Guideline 5.1.1(v) (account deletion)** is covered: Account & backup > Delete Parkdex account, in the app. Apple token revocation needs A9.

## C. Planned product changes that touch the listing

Nathan plans these. They are not designed or built yet, and this file does not design them. When each one ships, **update the listing, screenshots and privacy answers** (M2, M4, M6, M7, M9), on Play as well as the App Store.

- [ ] **C1. A photo on every park claim.** Today only founders' park photos are collected. When this ships, recheck the App Privacy "Photos or Videos" row and `PrivacyInfo.xcprivacy`, the screenshots and the description. **Agent** updates the docs and screenshots; **Nathan** updates App Store Connect and Play Console. Blocked by the feature shipping.
- [ ] **C2. "Golden Kip" promotion** (a random photo-taker gets a golden Kip avatar and wins $100). Blocked by the feature shipping, and by the rules below being written. **Nathan** owns the rules and the legal checks.
  - App Store guideline 5.3: Parkdex (the developer) is the sponsor, the official rules are presented in the app, and the rules state that Apple is not a sponsor or involved in any way.
  - Google Play's policy for contests and sweepstakes applies to the Play listing.
  - Canadian contest rules apply, for example a skill-testing question before a prize is awarded and no purchase necessary.
  - Update the description, screenshots and review notes to mention the promotion and where its rules are.

## S. Submit

- [ ] **S1. Submit for review.** Attach the production build from R4 to version 1.0.0 and submit. **Nathan.** Blocked by R4, D1, P1, all of M and V1.
- [ ] **S2. Release.** After approval, release manually or automatically. **Nathan.** Blocked by S1. Then raise `MARKETING_VERSION` for the next version (`docs/ios.md` > "First TestFlight build").
