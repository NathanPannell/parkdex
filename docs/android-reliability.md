# Android startup and claim reliability

This change keeps the existing Parkdex app, API, persistence and visual design. Its acceptance contract is a useful local map before remote content, ordered downloads, continuous claim presentation, and consistent protection of user data in transit. It does not migrate API hosting or rewrite local storage.

## Readiness contract

1. The installed overview map can render without opening a content database or completing a network request. A returning visitor reaches Explore without a mandatory repeat splash.
2. A validated catalogue supplies park metadata and coordinates before badge artwork downloads complete. Only released parks and appropriate retained claims become markers. Missing artwork uses the existing placeholder presentation.
3. Badge artwork is downloaded and verified before optional detailed-map downloads begin. Failed artwork must not discard an already valid catalogue or hide the overview.
4. Detailed map coverage improves the existing map instance without resetting its camera or removing the overview. Missing location permission must not prevent geographic orientation.
5. Arrival and claiming remain unavailable until complete validated boundaries, eligibility and the current owner's personal progress are ready. Informational map readiness is not claim authorization.
6. Personal claim metadata becomes available independently of expensive photo projection. Background hydration must preserve a current claim's visible photo and ignore stale owner results.

Content remains bound to its source environment and API origin. Immutable asset bytes retain size/hash validation. Snapshot rows and revision cursors retain transactional consistency. Every boundary region and hole is preserved.

## Claim continuity contract

The hold, charge, durable save, reveal and rank stages preserve the existing visual language. A successful ceremony follows the atomic local claim/photo/outbox commit. No background refresh may remove the completed badge or its photo, and one deliberate claim must produce one stored claim. An intentional replacement by the rank screen is distinct from an exposed underlying map or an unintended photo gap.

Evidence must use sequentially decoded video frames with actual encoded presentation timestamps. A capture gap does not establish an application frame drop. Software-rendered emulator timings must remain labelled separately from physical-device performance.

## Transport contract

Feedback text, optional email, screenshots, interaction identifiers, account credentials and private photos must use approved destinations with HTTPS in deployed builds. Redirects must not silently forward private request bodies or credentials. Valid same-origin web routes and explicit native staging/production configuration must continue to work. Isolated preview identities and credentials must stay separate from persistent environments.

## Verification before release

- Fresh offline installation: useful geographic overview before downloaded content.
- Fresh networked installation: catalogue/placeholder markers, badge art, then high-resolution map requests, with stage order observed rather than inferred from code.
- Delayed or blocked detail: overview remains visible offline and gains detail in place without a reload or camera reset.
- Cached process-cold relaunch: record native startup and visible geographic/art milestones separately.
- Ordinary claim and rank-up: capture critical transitions and verify layer continuity.
- Signed-in claim with backup active: completed photo survives refresh, exactly one claim is stored, and restore works.
- Content and backup: normal browser connectivity plus absence of the Network Information API; migrated photos and newly captured photos both supported.
- Destination and redirect rejection: adversarial URL tests plus valid deployed feedback/auth/photo journeys.
- Exact candidate preview and merged staging revision: local checks, independent review, browser evidence and Android APK provenance.

The delivery owner keeps an external resource journal, retains the isolated preview through staging verification, then proves every owned preview resource absent. Production promotion is separate.
