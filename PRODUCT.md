# Parkdex

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: Next.js mobile web client, FastAPI service, and Neon PostgreSQL on the existing Vercel/Railway/Neon template.

## Users

People exploring British Columbia, often outdoors on a phone, who want a satisfying record of parks and selected major islands they have visited.

## Product Purpose

Parkdex turns reliable place data into a collectible field guide. Success means a visitor can discover a place, understand why it belongs in the collection, mark it visited, and see progress persist.

## Positioning

The map and collection are one game-like interface: each verified place is a discoverable specimen with provenance rather than a generic pin or user-created list item.

## Operating Context

The primary session is one-handed mobile use while planning or travelling. Connectivity may be weak, so previously loaded place data and progress should remain useful while sync recovers.

## Capabilities and Constraints

- Cover British Columbia's national and provincial park inventories, regional parks with verified public sources, and selected major islands with reviewed identities and outlines.
- Group dozens of local park authorities into a small set of understandable collection regions while retaining the managing authority on each place.
- Provide a clustered interactive map, searchable and filterable collection list, place details, source links, checkoff and undo, and total/category progress.
- Anonymous progress must be isolated by an unpredictable client identity and persist across reloads.
- The map must work without a paid or secret tile API key.
- Dataset coverage and limitations must be stated honestly; descriptions, photos, and attributions must come from sourced data with reviewed reuse terms.

## Brand Commitments

The product name is Parkdex and its domain is `parkdex.app`. Its voice is concise, encouraging, outdoorsy, and factual. The interface should feel like a playful Pokédex and a premium Pacific Northwest field guide.

## Evidence on Hand

Canonical records are stored in `data/places.json`; methodology and coverage limits are stored in `data/README.md`. No testimonials, usage claims, or invented place facts may be added.

## Product Principles

- Make every checkoff feel earned and immediately legible.
- Keep the map readable at phone scale through clustering and progressive detail.
- Let provenance travel with every place.
- Preserve progress through unreliable connections and explain sync state plainly.
- Make exploration rewarding without obscuring the core task.

## Accessibility & Inclusion

Touch targets must be comfortable, controls keyboard accessible, contrast readable outdoors, and meaningful state independent of color. Respect reduced-motion preferences.
