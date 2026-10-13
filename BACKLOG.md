# Backlog

Ideas that were measured or discussed but are not scheduled. Measurements were taken on one machine
(Chromium, Radeon 780M, 68 Hz display, production build), so re-measure before acting.

## Smaller model file
`src/mascot.glb` is 5.97 MiB (3.0 MiB gzipped). About 3 MiB of the raw file is the two Sit-correction
shape keys, which store an offset for all 63k vertices although only the leg vertices change.
- Re-export the shape keys as sparse accessors (needs `studies/cloak-sit-corrective.blend`, which is not in the repo).
- Optionally compress the mesh (Draco or meshopt) and the 1024² texture (KTX2).
- Check the size is still correct after export; the target size (1–2 MiB) is a guess.

## Lower frame rate for the breathing idle
Breathing redraws at the display refresh rate and costs about 18% of one core (renderer + GPU process).
It stays at full rate on purpose: a switch between 60 fps and 30 fps was visible in an earlier try.
A lower rate is only acceptable if the switch is invisible, for example by rendering at full rate during
the 0.28 s fade into and out of the idle and dropping the rate only while the idle loop is steady.
Compare side by side before keeping it. Held poses and reduced motion already cost nothing.

## High-DPI quality
The drawing buffer is capped at pixel ratio 1.5 and about one megapixel (`src/companion.js`, the
`ResizeObserver` in `initScene`). On a 2× display the 290 px widget renders 56% of the native pixels,
and the 950 px widget only 25%. Options: a `maxPixels` / `maxPixelRatio` option on `createCompanion()`,
or a higher cap only while the widget is held still. Memory at 950 px was about 51 MiB; native 2× would be
roughly 4× the canvas memory and four times the pixels to shade each frame.
