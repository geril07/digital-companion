# Digital Companion

A draggable, animated 3D companion for a web page. It lives in a fixed corner of the viewport, plays a few idle and reaction animations by itself, and can be picked up and sent somewhere else on screen.

The repo ships the widget (`src/companion.js`, `src/companion.css`, `src/mascot.glb`) and a throwaway demo page (`index.html`, `src/main.js`, `src/demo.css`).

## Use it

The widget is an ES module for a Vite project. It imports its own CSS and bundles its model, so you need a bundler that handles `import './x.css'` and `new URL('./x.glb', import.meta.url)`. `three` is a peer dependency.

```js
import { createCompanion } from './companion.js';

const companion = createCompanion({
  parent: document.body,                 // where the widget is mounted
  modelUrl: '/my-model.glb',             // default: the bundled mascot.glb
  size: 290,                             // widget width in px
  mobileSize: 240,                       // width at 700 px viewport width or less
  theme: 'auto',                         // 'light', 'dark', or 'auto' (follow the OS)
  debug: import.meta.env.DEV || new URLSearchParams(location.search).has('debug'),
});

companion.setTheme('dark'); // e.g. from your site's theme toggle
companion.destroy();        // removes the DOM, listeners, timers and the WebGL renderer
```

The widget is `position: fixed`. All class names start with `dm-`, so the stylesheet should not collide with the host page. The widget needs WebGL; without it the widget shows a short message.

## Theming

The widget sets `data-theme="light"` or `"dark"` on its own `.dm-root` element only. It never reads or changes `<html>` or `<body>`. An explicit `theme` always wins; `'auto'` follows `prefers-color-scheme` and updates when the OS setting changes.

Every colour is a `--dm-*` custom property. The defaults come from the model's cloak texture. To match your site, override them from your own stylesheet:

```css
.dm-root { --dm-trim: #3b6; }
.dm-root[data-theme="dark"] { --dm-trim: #6d9; }
```

The tokens are `ink`, `cloak`, `trim`, `paper`, `edge`, `hover`, `surface`, `surface-active`, `muted`, `glow-1`, `glow-2`, `ground`, `shadow-soft` and `shadow`.

## Run the demo

```sh
npm install
npm run dev
```

The dev server shows the debug menu. A production build shows it only with `?debug` in the URL.

## Behaviour

- **Drag to send.** Grab the character anywhere, drag, and release. A small reticle follows the cursor and marks where the feet will land; the character then walks there in a straight line. The cursor stays in the middle of the reticle wherever you grabbed. Because the whole body must stay on screen, the feet cannot go closer to the top edge than the character's height; near that limit the reticle stops at the nearest reachable point. Keyboard: focus the character, press Space, move the reticle with the arrow keys, then press Enter (Escape cancels). The position is saved in `localStorage`.
- **Resize.** A small grip appears in the top-left corner of the character while you hover over it (or focus it with the keyboard); it is always faintly visible on touch screens. Drag up-left to grow or down-right to shrink; the bottom-right corner stays fixed. The minimum is 50 px wide. The maximum is the space up to the top or left edge of the viewport, with an 8 px margin. Keyboard: arrow keys change the size in 20 px steps, Home or a double-click resets it. The size is saved in `localStorage` and is temporarily reduced on small screens. `size` and `mobileSize` set the default.
- **First visit hint.** A small "[ drag to move me ]" label appears under the character once, for seven seconds, and never again in that browser. It disappears on the first drag.
- **Greeting.** Bow once per tab session when the model is ready.
- **Resting.** The default pose is Relax, a six-second breathing loop.
- **Idle poses.** After 30–60 quiet seconds it sometimes crosses its arms or sits, and holds the pose for 10–60 seconds.
- **Dance.** Once after 2–4 minutes without interaction.
- **Surprise.** Hovering over the character with a mouse for 1.5 seconds while it rests, at most once every two minutes.
- **Applause.** Staying at the page bottom for about two seconds, once per tab session. It can interrupt an idle pose, but waits for other actions to finish.
- Moving the character, using the keyboard on it, or opening the debug menu interrupts all automatic behaviour and restarts the timers.
- Hidden tabs stop rendering and cancel automatic actions. With `prefers-reduced-motion` there are no automatic actions, no walking animation, and the still Relax pose is used.

The source clips are sampled at 24 fps. Three.js interpolates them and renders at the display refresh rate. While the character holds a still pose, rendering stops. The drawing buffer is limited to about one megapixel.

## Debug menu

With `debug: true` the character shows a small star button. It opens a menu that plays any single action on demand and sends the character back to its corner. It is meant for tuning animations, not for visitors. At very small sizes the star button covers the character.

## Model

`src/mascot.glb` is the web-ready export of the character with its seven actions. The character was generated with [Tripo](https://www.tripo3d.ai/) on a paid plan and corrected in Blender. The route marker and debug menu use colours sampled from the cloak texture (`#4E3F37`, `#755F51`).

To rebuild it you need the source Blender file (`studies/cloak-sit-corrective.blend`), which is not part of this repository:

```sh
blender -b studies/cloak-sit-corrective.blend --python scripts/export-model.py
```

In that file two shape keys clear the bent leg of the cloak only during Sit. In Blender they follow the Sit action even if you change only the armature's action. When you preview another action, clear the shape keys' action and set both values to zero. The web widget switches this automatically. The last Sit frame keeps its cloak correction.

## Known issues

- The cloak and the hands can still clip through the armor in some poses.
- The model file is about 6 MB.
