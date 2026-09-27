# Feedback extension

Mode: Read for email, Operate for the form and private inbox.

## Direction contract

THESIS: Kip delivers a warm, concise acknowledgement to the tester and a useful private report to the operator. The message and next action lead.

OWN-WORLD: Preserve the app's cream paper, dark green ink, orange beak accents, rounded controls, Bricolage/Figtree UI type, and original Kip illustrations. Email uses reliable font fallbacks and table layout.

STORY: The tester knows the report is saved. Receipt and follow-up consent remain separate. The operator reads the report, opens the protected detail, changes its status, and can recover failed email delivery manually.

FIRST VIEWPORT: Email shows the Parkdex name, an illustrated Kip, a clear acknowledgement or new-report title, and one primary action. The private inbox pairs a compact list with legible report details and keeps status controls near the report title.

FORM: Narrow extension of the established system. The merged feedback sheet remains the visual authority; no new visual-world selection is needed. Build directly for email-client compatibility and the confirmed feedback journey.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Incumbent system applied here

The app's shared visual source is `src/styles.css`: dark green ink (`--ink: #14231c`), cream paper (`--paper: #fff8ec`), warm paper (`--paper-2: #fbecd4`), Kip orange (`--kip: #ff5a1f`), Bricolage Grotesque Variable display type, and Figtree Variable body type. Its rounded surface sizes are 28px and 20px, and its common raised control uses a 4px ink shadow. The feedback sheet keeps the established bottom-sheet layout, dark outlined fields, rounded controls, and tactile buttons in `src/screens.css`.

Kip continuity comes from the existing mascot component and artwork. The form uses the avatar pose at 52px and the cheer pose at 150px after save. The private review uses the think pose at 62px on its sign-in screen and the avatar pose at 43px in its header. Both email templates use the supplied `public/email/kip-wave.png` illustration in a 176px hero area.

The review inbox carries the app's ink, paper, orange, pine, and typography into a full-screen private workspace with a report list beside its detail pane. The email templates adapt that palette to a table-based, 600px email frame with a Parkdex header, Kip-led title, report or receipt content, and one primary action. They use `Trebuchet MS` and `Arial, Helvetica, sans-serif` fallbacks instead of the app's variable fonts for email-client compatibility.

## Source-level color variations

The current extension contains local color values alongside the shared tokens. The review stylesheet uses `#526258` for soft ink and `#b73309` for action orange; the email templates use `#526359` for soft ink, plus coral (`#ffb4a5`) and a warm rule (`#ead6b6`). The shared app values are `--ink-soft: #5b6b62` and `--kip-dark: #d9400c`. In the existing form, invalid input borders use the shared berry token (`#ff5c8a`), while error text uses literal `#c2185b`. These are recorded as local variations, not promoted to new app-wide tokens.

## Review status

This note is based on source inspection. Browser visual review remains pending because the Chrome workflow is unavailable and its permission is pending. No visual approval is recorded.
