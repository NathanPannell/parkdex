# Every Park Design

## Direction

A pocket ranger field guide crossed with a tactile creature-collection game. Cream paper and deep forest ink frame a teal ocean map; chartreuse and sunny yellow signal discovery and completion. Crisp contour geometry, stamped type, and physical press depth make the interface playful without turning place data into decoration.

## First viewport

The map owns the screen. A compact expedition header floats above it with collection progress; clustered markers read as numbered enamel badges. A thumb-height dock switches Map, Collection, and filters. Selecting a marker raises a place sheet from the bottom without losing map context.

## Signature interaction

Checking a place presses a tactile lime control, sends a short radial burst around its marker, and converts the marker into a crowned check badge while the progress strip advances. Undo uses the same control and never hides the consequence.

## System

- Palette: paper `#f6f0dc`, forest `#173d32`, ocean `#78cad0`, deep water `#2b7a78`, chartreuse `#b9ea55`, sun `#ffd862`, coral `#ef755f`.
- Typography: Fraunces for display and Nunito Sans for interface copy, self-hosted through the framework font loader.
- Shapes: 12–16px panels, compact pills only for filters and counts, irregular map coastline treatment through real map geometry rather than fake organic masks.
- Depth: forest-tinted soft shadows with a small downward offset; selected controls compress toward the surface.
- Motion: one springy collection moment, restrained sheet and camera transitions, and a motion-reduced equivalent.
- Responsive: edge-to-edge map on phones; on wide screens, a persistent collection rail shares the viewport with the map.

## Interaction rules

Map and list always reflect the same search and category filters. Clusters show counts and expand on tap. A selected place stays selected across layout changes. Loading, empty results, offline progress, sync failure, and retry states use direct recovery copy.
