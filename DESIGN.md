# Design

How Parkdex screens look and read. Tokens live in `src/styles.css` (`:root`): ink `#14231C`, paper `#FFF8EC`, Kip orange `#FF5A1F`, sun `#FFC93C`, moss, pine and sea, with Bricolage Grotesque for display type and Figtree for body text. [PRODUCT.md](PRODUCT.md) says who the screens are for.

## Principles

- **Buttons, not paragraphs.** Each screen leads with the thing to do, as a button you can't miss. Explanations are one short line at most, or nothing. If a button's label says it, the screen doesn't repeat it.
- **Write for a walker with a leash in one hand.** Big tap targets, short labels, and verbs from the game: plant, take, visit, log. Name the rival ("Take it from @sam"). Avoid crew, collect and found-as-a-verb ([docs/park-founders.md](docs/park-founders.md#player-copy)).
- **One photo per park.** The founder's photo is the park's face everywhere: the park page, My Dex and the full-screen viewer. Without one, the park's badge frame stands in. Players never see a camera except to become a park's founder.

## Buttons

| Class | Use |
| --- | --- |
| `.btn` | The app's chunky pill: 58 px tall, a 2.5 px ink edge and a 5 px drop that presses down on tap. |
| `.btn--xl` | The big button: 68 px tall, 21 px label, 26 px icon. The park page's main action, "Become the founder" and My Dex's "Show on the map" use it. |
| `.btn--glow` | Pulses for the action that matters now: plant, take, or log your visit. |
| `.btn--sun` | Gold, for the founder photo and its points. |
| `.btn--rest` | Clearly unavailable ("Visited today, back tomorrow"): no colour, no pulse; a tap only nudges it. |
| `.btn--sm` | Secondary actions in result screens and sheets. |

## The park page

`src/screens/map/ParkSheet.tsx`, top to bottom:

1. **The photo.** The founder's photo, or the park's badge on its landscape gradient.
2. **Name**, its kind and region, and two chips: how far away it is and its landscape.
3. **Whose park it is.** One card: the holder's flag, "@sam" with "Has held it for 3 days" (or "Your park", or "Nobody's park yet"), and a gold `+7` for what taking it is worth. During someone's protected hour it reads "New flag · free at 3:42 pm".
4. **Become the founder** (`.btn--xl .btn--sun`, with `+24`), only while you stand in a park nobody has founded. A photo waiting for review shows as a dashed note instead.
5. **One quiet line of facts**: the founder and the visit counts.
6. **"Report a problem"**, a text link.

The main button is pinned to the bottom of the sheet, always `.btn--xl`, and is always the next thing to do:

| Where you are | Main button |
| --- | --- |
| Outside the park | Get directions (Google Maps), or "Find it on the map" when there's no road route |
| Inside, nobody holds it | Plant your flag |
| Inside, someone else holds it | Take it from @sam |
| Inside, it's yours | Visit your flag |
| Inside, during someone's protected hour | Log your visit · +1, then "Logged, take it after 3:42 pm" |
| Inside, already visited today | Visited today, back tomorrow (resting) |

## My Dex

The visit log. Tiles are 3:4 and show the park's official photo (`src/components/ParkCover.tsx`), cropped to fill, or its badge. Unvisited parks are greyed out. A park's sheet shows the photo wide (16:9), your visit count with first and last visit, and one big "Show on the map" button.
