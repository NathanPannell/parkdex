# Sealed Impressions

The park visit becomes a personal print. Photography carries the experience; cream paper, a park outline seal, and restrained motion make the saved visit feel tangible.

## Journey

1. A foreground boundary match introduces the park with catalogue photography and a rounded cream sheet. Exact and near-boundary matches use different language. Dismissal lasts until a confirmed departure or a different park.
2. **Claim + photo** opens the native Android camera. The camera app may supply its own confirmation, but that varies by device.
3. Parkdex saves a private recovery copy and presents **Keep this one?** with Retake and **Save my visit**. The latter starts a fresh location check, then the server claim and photo upload. A no-photo claim remains available.
4. The print appears while saving. The seal lands only after a successful save. An interrupted upload says that the visit is already saved and offers photo retry.
5. **Back to map** preserves the map view and shows a small print at close zoom. **Open your postcard** leads to Account.

## A growing collection

Account puts postcards before the existing badge and place shelves. The newest visit is featured; the remaining prints form a two-column phone grid and expand with available space. Twelve additional prints load per request. Private photographs load near the viewport, not all at once.

The current data model has one postcard per claimed park. Visits without photos use an outline print. Catalogue images never masquerade as personal photographs. Opening a print exposes its full view and photo controls.

## Shared visual language

- Retain Parkdex forest green and the existing font assets. Use rounded, bold Nunito for interface headings and Fraunces for the park name on paper.
- Paper remains cream in every state. Mint belongs behind it. Yellow is a small arrival accent.
- Prefer one prominent image, one short heading, and one main action. Keep operational detail in recovery messages and diagnostics.
- Use generous rounded sheets and pill actions. A short seal animation carries success; badges remain in the collection without a competing modal.
- Restrict elevation on hover to devices with a fine pointer. Reduced motion shows the final composition immediately.
- Use actual park geometry where available, with an honest non-geographic fallback.

The implementation lives in claim/postcard components and `frontend/app/sealed-impressions.css`. The separate staging audit task owns broader navigation, responsive layout, and usability fixes. Both changes preserve the existing location, account, and storage contracts.
