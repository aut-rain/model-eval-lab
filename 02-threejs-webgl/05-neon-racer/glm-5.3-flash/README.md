# NEON RACER

Fullscreen synthwave racer built with Three.js (WebGL) — endless neon grid, bloom glow,
and GPU point-sprite **vapor trails** streaming off the ship's twin engines (plus wingtip
vapor when you carve hard).

## Run it

No build step — it's a single self-contained `index.html` (Three.js loads from CDN):

```bash
# either just open the file…
open index.html

# …or serve it (recommended)
npx serve .
# or: python3 -m http.server 8000
```

Then visit the printed URL. Click / press **Space** to start.

## Controls

| Input | Action |
| --- | --- |
| `←` `→` / `A` `D` | Steer |
| `↑` / `W` | Boost (with FOV kick) |
| `↓` / `S` | Brake |
| `Space` / `Enter` | Start / retry |
| `P` | Pause |
| `M` | Toggle sound |
| Touch / mouse drag | Steer on touch devices |

## Gameplay

- Dodge the red neon walls — the gap tightens as your speed ramps up.
- Fly through cyan **energy cores** for +25 score and an instant boost charge.
- +1 point per wall passed. Best score persists in `localStorage`.

## Tech notes

- **Vapor trails**: ring-buffer `THREE.Points` (~1100 sprites, per-particle velocity /
  age / color in vertex attributes, custom additive ShaderMaterial, soft-disc falloff).
- **Neon look**: `UnrealBloomPass` + `OutputPass` (ACES tone mapping), emissive/basic
  materials pushed past the bloom threshold.
- **World**: shader-drawn grid road (fwidth-based anti-aliased lines, hand-rolled fog),
  outrun sun with scanline gaps, parallax ridge silhouettes, streamed pylons,
  line-segment speed streaks — everything recycled, zero per-frame allocation.
- **Audio**: pure WebAudio synthesis — detuned saw engine tracking speed, filtered-noise
  crash, blip pickups. No audio assets, starts on first user gesture.
