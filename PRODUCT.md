# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Parkdex internal testers use the Android app to choose a Vancouver Island park, travel there, check in, take a photo, and collect a badge. The operator reviews their feedback privately.

## Product Purpose

Keep exploring and collecting usable offline, while giving testers a short in-app way to report bugs, suggest features, and share general feedback when online.

## Capabilities and Constraints

Accounts are optional, and feedback works without one. Feedback is saved durably before email delivery. Screenshots are included only when intentionally selected. Precise location, photos, and sensitive logs are not automatically collected. The user confirmed that a receipt email address remains optional, with separate permission for follow-up. Reports and attachments are private to the operator. New, Reviewing, Planned, and Closed are the review statuses. Failed email delivery has a manual recovery action, without a scheduled retry service.

## Brand Commitments

Use Kip, the existing oystercatcher mascot, and Parkdex's established visual identity. The operator explicitly requested beautiful branded notification and receipt emails. Preserve the existing form's visual and interaction substrate.

## Evidence on Hand

The form in `src/screens/FeedbackSheet.tsx`, style tokens in `src/styles.css`, and supplied mascot artwork in `public/art/kip` establish the product language. GitHub issue 1 specifies the required feedback journey and privacy boundaries.
