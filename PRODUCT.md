# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Dog walkers on Vancouver Island (and in Nova Scotia) who walk the same local parks every day. They play Parkdex on the Android app, or the web app at `web.parkdex.app`, to take those parks from each other: walk in, plant your flag, and hold the park until another walker takes it back. The operator reviews their feedback privately.

## Product Purpose

One loop, played on the walk you were going to take anyway:

- **Take your local parks.** Walk into a park and plant your flag. If another walker holds it, take it from them. Your flag earns a point for every hour it flies.
- **Hold them.** A new flag is protected for its first hour, so two walkers can't trade a park back and forth on the spot. After that, anyone can take it.
- **Found new ones.** The one photo anyone takes in Parkdex is a photo of the park itself, which makes you its founder. It becomes the park's official photo for everyone.
- **Keep a log.** My Dex lists every park you've visited, each shown with its official photo.

Feedback stays a short in-app form for reporting bugs and suggesting features.

## Capabilities and Constraints

- Players are individual walkers. Crews, where friends held a park together, are retired ([docs/crews.md](docs/crews.md)): the app has no crew UI and the server refuses new crew joins. Parks already held with someone else stay held until they're taken or the flag falls.
- No personal photos. The only camera in the app is the founder's photo of the park ([docs/park-founders.md](docs/park-founders.md)). My Dex and the park page show only that official photo, or the park's badge where there is none. Photos taken before this change stay on the player's device and in their backup, but they aren't shown.
- Feedback has no attachments: nothing new can be attached. Reports are saved durably before email delivery, and precise location, photos and sensitive logs are never collected automatically. A receipt email address is optional, with separate permission for follow-up. Reports are private to the operator, with the review statuses New, Reviewing, Planned and Closed.
- The app is offline first. Android builds take web-layer changes over the air ([docs/ota-updates.md](docs/ota-updates.md)). Anything native (plugins, permissions) needs a Play release.

## Brand Commitments

Use Kip, the existing oystercatcher mascot, and Parkdex's established visual identity. Copy talks to walkers taking parks from each other: short, plain and playful ("Take it from @sam", "Your park", "Get directions"). The operator explicitly asked for beautiful branded notification and receipt emails.

## Evidence on Hand

The park page in `src/screens/map/ParkSheet.tsx`, style tokens in `src/styles.css`, the design rules in [DESIGN.md](DESIGN.md) and the mascot artwork in `public/art/kip` set the product language. GitHub issue 1 set the feedback journey and its privacy boundaries.
