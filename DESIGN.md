# Parkdex Design

## Direction

A pocket ranger field guide crossed with a tactile creature-collection game. Cream paper and deep forest ink frame a teal ocean map; chartreuse and sunny yellow signal discovery and completion. Crisp contour geometry, stamped type, and physical press depth make the interface playful without turning place data into decoration.

## First viewport

On desktop, a narrow navigation rail and a searchable place panel occupy the left edge. The map fills the remaining viewport, with map and list controls on the map. Selecting a place replaces the list with a photo-led detail panel while its boundary stays in view. On phones, the map fills the screen and place details rise from the bottom. The responsive change happens at 860px.

## Signature interaction

Checking a place presses a tactile lime control and converts the marker into a crowned check badge while the progress strip advances. A newly earned badge fills the screen with a burst of crisp forest flora and fauna before the visitor claims it. Undo uses the same control and never hides the consequence.

## System

- Palette: paper `#f6f0dc`, forest `#173d32`, ocean `#78cad0`, deep water `#2b7a78`, chartreuse `#b9ea55`, sun `#ffd862`, coral `#ef755f`.
- Typography: Fraunces for display and Nunito Sans for interface copy, self-hosted through the framework font loader.
- Shapes: 12–16px panels, compact pills only for filters and counts, irregular map coastline treatment through real map geometry rather than fake organic masks.
- Depth: forest-tinted soft shadows with a small downward offset; selected controls compress toward the surface.
- Motion: one springy collection moment, restrained sheet and camera transitions, and a motion-reduced equivalent.
- Responsive: edge-to-edge map and bottom place sheet below 860px; a 72px navigation rail, 400px content panel, and remaining map width at 860px and above.

## Interaction rules

Map and list always reflect the same search and category filters. Clusters show counts and expand on tap. A selected place stays selected across layout changes. Loading, empty results, offline progress, sync failure, and retry states use direct recovery copy.

Place details lead with a verified photo, name, one short origin, one approximate mapped area, and official visitor information when verified. Actions remain beside the visitor content. Boundary provenance, coordinates, and photo credits live in an expandable disclosure at the end of the panel.
