# Minigames design system

## Attribution

- The license quiz uses the official Korea Road Traffic Authority question bank and Wikimedia Commons road sign SVGs. See [the license quiz attribution record](games/license-quiz/ATTRIBUTION.md) for source and license details.

- Use PLY colors from `shared/ply.css`: ink and muted text for labels, `--ply-common` for common items, `--ply-specialized` for specialized items, and the game accent (`--ply-rain`, `--ply-pole`, or `--ply-license`) for play feedback.
- Use system UI for labels and tabular numerals for scores. Keep canvas labels legible over the background.
- Render catalog items with `itemBadge(item, { size: 'sm' | 'md' | 'lg' })`. IDs and names come from `data/items.json`; rarity changes the border treatment.
- Common badges are rounded squares; specialized badges are circles. Keep SVG icons inside a 24 by 24 viewBox with rounded 1.75px strokes and no fill.
- Game canvases keep scenery low contrast, reserve glow for key objects, and use the game accent for interaction. Keep motion smooth and honor reduced-motion preferences for screen shake and repeated flashes.

## Scenic game canvases

- `shared/scenery.js` owns the shared landscape palette and its day, dusk, and night colors. Keep the sky, distant ridges, near terrain, biome, and foreground readable as filled silhouettes with soft curves.
- Use `shared/window-frame.js` for the in-car view. Keep the roof line in the top 4–9% of the view, the glass above the beltline, and the dark door trim below it.
- Render rain on clipped glass only. Large drops may refract the scene, with a soft dark rim and one small highlight; avoid sketch strokes, tails, crosses, and glyph marks. Wet trails should read as translucent ribbons with soft residual beads.
- UI chrome stays in the PLY dark tones. Game scenes use the current time-of-day palette.

## Adding a game or item

1. Add item metadata and a unique catalog ID to `data/items.json`.
2. Use the shared badge and loot notification instead of hand-built item labels.
3. Export and check item SVGs with the scripts in `scripts/`.
4. Use PLY tokens, canvas contrast, restrained glow, and reduced-motion handling.
5. Keep gameplay logic independent from DOM rendering where simulation or deterministic testing matters.

## Shared door HUD

- Scenic games use shared/door-hud.js to mount one instrument strip below the beltline. Keep the glass and its rain or scenery unobstructed; do not put HUD chips on the glass.
- Treat the lower area as a sculpted generic door panel: dark soft gradient, one continuous armrest highlight, recessed handle pocket, stitched seam, and a slim water level at the belt seal when the game has overflow.
- The instrument strip has a large tabular score with the Korean label 점수, an optional combo pill above one, a centered Korean status and mode, and a round speed readout with its limit. Tint speed coral when it exceeds the limit.
- Use three circular item badge slots from the shared itemBadge component. Put thumb controls in one equal-height row directly under the strip; reserve the primary pill for the main action. Mute and settings remain icon buttons in the header.
- Start and result copy uses Korean. Present these states as compact frosted panels with PLY colors, one primary action, and two-column result statistics. License quiz screens use the same typography, tokens, badges, and frosted surfaces without the car-door background.
- Keep window.__layoutCheck() free of HUD collisions at 360×640, 390×844, and 430×932. The window frame has a narrow curved front A-pillar that meets the mirror housing; the rear glass edge reaches the viewport edge.
