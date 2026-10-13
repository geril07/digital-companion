import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import './companion.css';

// Clip name -> [debug menu label, debug menu symbol]. Clips not listed here are ignored.
const clips = {
  afraid: ['Surprise', '✶'],
  bow: ['Take a bow', '↘'],
  clap: ['Applause', '✧'],
  dance_04: ['Dance', '♫'],
  fold_arms: ['Cross arms', '⌁'],
  idle_clear: ['Relax', '◌'],
  sit: ['Take a seat', '◡'],
  walk: ['Go for a walk', '→'],
};
const defaultModelUrl = new URL('./mascot.glb', import.meta.url).href;
const stageRatio = 318 / 290;
const minWidth = 50;
const mobileQuery = '(max-width: 700px)';
// The feet sit this far down the stage; the target marks where the feet will land.
const footRatio = 1 - 22 / 318;
const captions = { drag: 'release to send', walk: 'on my way', keyboard: 'enter to send' };

function recall(area, key) {
  try { return area.getItem(key); } catch { return null; }
}

function remember(area, key, value) {
  try { area.setItem(key, value); } catch { /* Storage is optional. */ }
}

function quietDelay() {
  return 30_000 + Math.random() * 30_000;
}

function danceDelay() {
  return 120_000 + Math.random() * 120_000;
}

export function createCompanion({
  parent = document.body,
  modelUrl = defaultModelUrl,
  size = 290,
  mobileSize = 240,
  theme = 'auto',
  debug = false,
} = {}) {
  const root = document.createElement('div');
  root.className = 'dm-root';
  root.innerHTML = `
    <div class="dm-guide" hidden aria-hidden="true">
      <div class="dm-target"><span class="dm-target-reticle"></span><span class="dm-target-caption"></span></div>
    </div>
    <div class="dm-sr-only" role="status" aria-live="polite"></div>
    <aside class="dm-widget" aria-label="Interactive 3D companion">
      <div class="dm-stage" tabindex="0" role="group" aria-label="Drag to choose a destination, or press Space then arrow keys and Enter to send the companion there">
        <div class="dm-glow"></div>
        <div class="dm-shadow"></div>
        <div class="dm-loading">waking up</div>
        <div class="dm-canvas"></div>
      </div>
      <span class="dm-hint" hidden>[ drag to move me ]</span>
      <button class="dm-resize" type="button" aria-label="Resize companion" title="Drag to resize; double-click to reset">
        <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1 13 13 1M1 7.5 7.5 1"/></svg>
      </button>
      <output class="dm-resize-readout" hidden></output>
    </aside>`;
  parent.append(root);

  const widget = root.querySelector('.dm-widget');
  const stage = root.querySelector('.dm-stage');
  const canvasHost = root.querySelector('.dm-canvas');
  const loading = root.querySelector('.dm-loading');
  const hint = root.querySelector('.dm-hint');
  const resizeHandle = root.querySelector('.dm-resize');
  const resizeReadout = root.querySelector('.dm-resize-readout');
  const guide = root.querySelector('.dm-guide');
  const travelTarget = guide.querySelector('.dm-target');
  const reticle = travelTarget.querySelector('.dm-target-reticle');
  const targetCaption = travelTarget.querySelector('.dm-target-caption');
  const moveStatus = root.querySelector('.dm-sr-only');

  const lifetime = new AbortController();
  const on = (target, type, handler, options) => target.addEventListener(type, handler, { ...options, signal: lifetime.signal });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const actions = new Map();

  let destroyed = false;
  let mixer;
  let currentAction;
  let idleAction;
  let breathingAction;
  let idleName = 'fold_arms';
  let facingGroup;
  let desiredYaw = 0;
  let loaded = false;
  let renderer;
  let resizeObserver;
  let pointer = null;
  let keyboardTarget = null;
  let trip = null;
  let walkMotion = null;
  let walkPixelsPerUnit = 0;
  let modelScale = 0;
  let position = null;
  let userPlaced = false;
  let preferredPosition = null;
  let hintTimer;
  let preferredWidth = null;
  let resizeState = null;
  let renderScene;
  let rendering = false;
  let idleSettled = false;
  let lastFrameTime = null;
  let automaticAction = null;
  let idleDue = performance.now() + quietDelay();
  let danceDue = performance.now() + danceDelay();
  let hoverSince = null;
  let surpriseDue = 0;
  let bottomSince = null;
  let applauded = recall(sessionStorage, 'digital-companion-applauded') === 'true';
  let greeted = recall(sessionStorage, 'digital-companion-greeted') === 'true';
  let debugMenu = null;

  // 'light' and 'dark' are fixed; anything else follows the operating system.
  function applyTheme() {
    root.dataset.theme = theme === 'dark' || (theme !== 'light' && prefersDark.matches) ? 'dark' : 'light';
  }

  function setTheme(next) {
    theme = next;
    applyTheme();
  }

  on(prefersDark, 'change', applyTheme);

  function finishAutomatic() {
    if (automaticAction) {
      automaticAction = null;
      if (loaded) play(idleName);
    }
    idleDue = performance.now() + quietDelay();
  }

  function interruptAutomatic() {
    finishAutomatic();
    danceDue = performance.now() + danceDelay();
    hoverSince = null;
    bottomSince = null;
  }

  function startAutomatic(name, hold = false) {
    automaticAction = { name, hold, until: null };
    play(name);
  }

  widget.addEventListener('pointerdown', interruptAutomatic, true);
  widget.addEventListener('keydown', interruptAutomatic, true);
  on(reducedMotion, 'change', () => {
    interruptAutomatic();
    if (loaded && currentAction === idleAction) play(idleName);
  });
  stage.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse' && !event.buttons) hoverSince = performance.now();
  });
  stage.addEventListener('pointerleave', () => { hoverSince = null; });
  stage.addEventListener('pointercancel', () => { hoverSince = null; });

  const tick = setInterval(() => {
    if (!loaded || document.hidden || reducedMotion.matches) {
      hoverSince = null;
      bottomSince = null;
      return;
    }
    const now = performance.now();
    const atBottom = document.documentElement.scrollHeight > window.innerHeight + 100
      && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 24;
    if (!atBottom) bottomSince = null;
    else bottomSince ??= now;
    if (debugMenu?.isOpen() || pointer || resizeState || keyboardTarget || trip) {
      idleDue = now + quietDelay();
      danceDue = now + danceDelay();
      hoverSince = null;
      bottomSince = null;
      return;
    }
    const canApplaud = automaticAction ? automaticAction.hold : currentAction === idleAction;
    if (!applauded && bottomSince !== null && now - bottomSince >= 2000 && canApplaud) {
      applauded = true;
      remember(sessionStorage, 'digital-companion-applauded', 'true');
      startAutomatic('clap');
      return;
    }
    if (hoverSince !== null && now - hoverSince >= 1500) {
      hoverSince = null;
      if (!automaticAction && idleSettled && now >= surpriseDue && actions.has('afraid')) {
        surpriseDue = now + 120_000;
        startAutomatic('afraid');
        return;
      }
    }
    if (automaticAction) {
      if (automaticAction.until !== null && now >= automaticAction.until) finishAutomatic();
      return;
    }
    if (!idleSettled) return;
    if (now >= danceDue && actions.has('dance_04')) {
      danceDue = now + danceDelay();
      startAutomatic('dance_04');
      return;
    }
    if (now >= idleDue) {
      const choices = ['fold_arms', 'sit'].filter(name => name !== idleName && actions.has(name));
      if (choices.length) startAutomatic(choices[Math.floor(Math.random() * choices.length)], true);
      idleDue = now + quietDelay();
    }
  }, 500);

  function startRendering() {
    if (rendering || !renderScene || document.hidden) return;
    lastFrameTime = null;
    rendering = true;
    renderer.setAnimationLoop(renderScene);
  }

  function stopRendering() {
    if (!rendering) return;
    renderer.setAnimationLoop(null);
    rendering = false;
    lastFrameTime = null;
  }

  on(document, 'visibilitychange', () => {
    if (document.hidden) {
      interruptAutomatic();
      stopRendering();
    }
    else if (loaded && (!idleSettled || currentAction === breathingAction)) startRendering();
    idleDue = performance.now() + quietDelay();
    danceDue = performance.now() + danceDelay();
    hoverSince = null;
    bottomSince = null;
  });

  function showHint() {
    if (recall(localStorage, 'digital-companion-hinted')) return;
    remember(localStorage, 'digital-companion-hinted', 'true');
    hint.hidden = false;
    hintTimer = setTimeout(hideHint, 7000);
  }

  function hideHint() {
    clearTimeout(hintTimer);
    hint.hidden = true;
  }

  function clampPosition(x, y) {
    const rect = widget.getBoundingClientRect();
    const maxY = Math.max(8, window.innerHeight - rect.height - 20);
    return {
      x: Math.max(8, Math.min(window.innerWidth - rect.width - 8, x)),
      y: Math.max(8, Math.min(maxY, y)),
    };
  }

  function setPosition(x, y, save = false) {
    position = clampPosition(x, y);
    widget.style.left = `${position.x}px`;
    widget.style.top = `${position.y}px`;
    if (save) {
      userPlaced = true;
      preferredPosition = { ...position };
      remember(localStorage, 'digital-companion-position', JSON.stringify(position));
    }
  }

  function defaultWidth() {
    return window.matchMedia(mobileQuery).matches ? mobileSize : size;
  }

  // The anchors are the bottom-right corner the widget grows from. The top and left
  // viewport edges (with an 8 px margin) set the maximum width.
  function applyWidth(
    width = preferredWidth ?? defaultWidth(),
    anchorBottom = window.innerHeight - (window.matchMedia(mobileQuery).matches ? 20 : 30),
    anchorRight = window.innerWidth - 8,
  ) {
    const available = Math.min(anchorRight - 8, window.innerWidth - 16, (anchorBottom - 8) / stageRatio);
    const actual = Math.max(minWidth, Math.min(width, available));
    widget.style.width = `${actual}px`;
    resizeReadout.textContent = `${Math.round(actual)} PX`;
    resizeHandle.setAttribute('aria-label', `Resize companion, ${Math.round(actual)} pixels. Use arrow keys to resize or Home to reset`);
    return actual;
  }

  function restoreSize() {
    const width = Number(recall(localStorage, 'digital-companion-size'));
    if (Number.isFinite(width) && width >= minWidth) preferredWidth = width;
    applyWidth();
  }

  function saveSize() {
    if (preferredWidth === null) try { localStorage.removeItem('digital-companion-size'); } catch { /* Storage is optional. */ }
    else remember(localStorage, 'digital-companion-size', String(preferredWidth));
  }

  function resizeTo(width, right, bottom) {
    preferredWidth = applyWidth(Math.round(width), bottom, right);
    const rect = stage.getBoundingClientRect();
    setPosition(right - rect.width, bottom - rect.height);
    debugMenu?.position();
  }

  function resetSize() {
    const rect = widget.getBoundingClientRect();
    preferredWidth = null;
    const actual = applyWidth(defaultWidth(), rect.bottom, rect.right);
    setPosition(rect.right - actual, rect.bottom - stage.getBoundingClientRect().height);
    saveSize();
    if (userPlaced) setPosition(position.x, position.y, true);
  }

  function cancelResize() {
    if (!resizeState) return;
    const { originalSize, origin } = resizeState;
    resizeState = null;
    preferredWidth = originalSize;
    applyWidth();
    setPosition(origin.x, origin.y);
    widget.classList.remove('resizing');
    resizeReadout.hidden = true;
  }

  function prepareResize() {
    debugMenu?.close();
    stopTravel();
  }

  function defaultDestination() {
    const rect = widget.getBoundingClientRect();
    if (window.matchMedia(mobileQuery).matches) {
      return clampPosition(window.innerWidth - rect.width - 8, window.innerHeight - rect.height - 16);
    }
    return clampPosition(window.innerWidth - rect.width - 28, window.innerHeight - rect.height - 30);
  }

  function defaultPosition() {
    const destination = defaultDestination();
    setPosition(destination.x, destination.y);
  }

  function restorePosition() {
    try {
      const saved = JSON.parse(recall(localStorage, 'digital-companion-position'));
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        userPlaced = true;
        preferredPosition = saved;
        setPosition(saved.x, saved.y);
        return;
      }
    } catch { /* Use the default position. */ }
    defaultPosition();
  }

  function footAt(point) {
    return { x: point.x + stage.offsetWidth / 2, y: point.y + stage.offsetHeight * footRatio };
  }

  function showTarget(destination, mode = 'drag') {
    const foot = footAt(destination);
    travelTarget.style.left = `${foot.x}px`;
    travelTarget.style.top = `${foot.y}px`;
    targetCaption.textContent = captions[mode];
    guide.dataset.mode = mode;
    guide.hidden = false;
    const roomBelow = reticle.offsetHeight / 2 + 8 + targetCaption.offsetHeight + 8;
    travelTarget.classList.toggle('caption-above', window.innerHeight - foot.y < roomBelow);
  }

  function cancelTravel(save = false) {
    if (trip && save) setPosition(position.x, position.y, true);
    trip = null;
    guide.hidden = true;
    desiredYaw = 0;
  }

  function stopTravel() {
    if (keyboardTarget) {
      keyboardTarget = null;
      cancelTravel();
    }
    if (trip) {
      cancelTravel(true);
      if (loaded) play(idleName);
    }
  }

  function finishTravel() {
    if (!trip) return;
    const destination = trip.end;
    setPosition(destination.x, destination.y, true);
    cancelTravel();
    play(idleName);
    moveStatus.textContent = 'Companion arrived.';
  }

  function travelTo(destination) {
    if (trip) cancelTravel();
    const start = { ...position };
    const end = clampPosition(destination.x, destination.y);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 8 || reducedMotion.matches || !loaded) {
      cancelTravel();
      setPosition(end.x, end.y, true);
      if (loaded) play(idleName);
      moveStatus.textContent = 'Companion arrived.';
      return;
    }
    if (!walkMotion || !walkPixelsPerUnit) {
      cancelTravel();
      moveStatus.textContent = 'Walk animation is unavailable.';
      return;
    }

    const repetitions = Math.max(1, Math.ceil(distance / (walkMotion.distance * walkPixelsPerUnit)));
    trip = { start, end, distance, startedAt: mixer.time };
    showTarget(end, 'walk');
    moveStatus.textContent = 'Companion is walking to the selected position.';
    desiredYaw = Math.atan2(end.x - start.x, end.y - start.y);
    play('walk', repetitions);
  }

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    prepareResize();
    const rect = widget.getBoundingClientRect();
    resizeState = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: rect.width,
      right: rect.right,
      bottom: rect.bottom,
      origin: { ...position },
      originalSize: preferredWidth,
    };
    widget.classList.add('resizing');
    resizeReadout.hidden = false;
    resizeHandle.setPointerCapture(event.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!resizeState || event.pointerId !== resizeState.id) return;
    const horizontal = resizeState.x - event.clientX;
    const vertical = (resizeState.y - event.clientY) / stageRatio;
    const change = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
    resizeTo(resizeState.width + change, resizeState.right, resizeState.bottom);
  });
  resizeHandle.addEventListener('pointerup', (event) => {
    if (!resizeState || event.pointerId !== resizeState.id) return;
    resizeState = null;
    widget.classList.remove('resizing');
    saveSize();
    if (userPlaced) setPosition(position.x, position.y, true);
    resizeReadout.hidden = true;
  });
  resizeHandle.addEventListener('pointercancel', (event) => {
    if (resizeState && event.pointerId === resizeState.id) cancelResize();
  });
  resizeHandle.addEventListener('pointerenter', () => { resizeReadout.hidden = false; });
  resizeHandle.addEventListener('pointerleave', () => {
    if (!resizeState && document.activeElement !== resizeHandle) resizeReadout.hidden = true;
  });
  resizeHandle.addEventListener('focus', () => { resizeReadout.hidden = false; });
  resizeHandle.addEventListener('blur', () => {
    if (!resizeState) resizeReadout.hidden = true;
  });
  resizeHandle.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && resizeState) {
      event.preventDefault();
      cancelResize();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      prepareResize();
      resetSize();
      resizeReadout.hidden = false;
      return;
    }
    const steps = { ArrowLeft: 20, ArrowUp: 20, ArrowRight: -20, ArrowDown: -20 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    prepareResize();
    const rect = widget.getBoundingClientRect();
    resizeTo(rect.width + steps[event.key], rect.right, rect.bottom);
    saveSize();
    if (userPlaced) setPosition(position.x, position.y, true);
    resizeReadout.hidden = false;
  });
  resizeHandle.addEventListener('dblclick', () => {
    prepareResize();
    resetSize();
  });

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    hideHint();
    debugMenu?.close();
    stopTravel();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, destination: null };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!pointer.destination && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 10) return;
    // The feet land under the cursor, whichever part of the character was grabbed.
    pointer.destination = clampPosition(event.clientX - stage.offsetWidth / 2, event.clientY - stage.offsetHeight * footRatio);
    showTarget(pointer.destination);
    stage.classList.add('choosing');
  });
  stage.addEventListener('pointerup', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const destination = pointer.destination;
    pointer = null;
    stage.classList.remove('choosing');
    if (destination) travelTo(destination);
  });
  stage.addEventListener('pointercancel', () => {
    pointer = null;
    stage.classList.remove('choosing');
    cancelTravel();
  });
  stage.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
      if (!keyboardTarget) {
        keyboardTarget = { ...position };
        showTarget(keyboardTarget, 'keyboard');
        moveStatus.textContent = 'Choose a destination with the arrow keys, then press Enter.';
      }
    } else if (keyboardTarget && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const directions = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
      const direction = directions[event.key];
      if (!direction) return;
      keyboardTarget = clampPosition(keyboardTarget.x + direction[0], keyboardTarget.y + direction[1]);
      showTarget(keyboardTarget, 'keyboard');
    } else if (keyboardTarget && event.key === 'Enter') {
      event.preventDefault();
      const destination = keyboardTarget;
      keyboardTarget = null;
      travelTo(destination);
    } else if (keyboardTarget && event.key === 'Escape') {
      keyboardTarget = null;
      cancelTravel();
      moveStatus.textContent = 'Move cancelled.';
    }
  });

  on(window, 'resize', () => {
    if (resizeState) cancelResize();
    if (trip) {
      cancelTravel(true);
      if (loaded) play(idleName);
    }
    applyWidth();
    if (userPlaced) setPosition(preferredPosition.x, preferredPosition.y);
    else defaultPosition();
    if (keyboardTarget) {
      keyboardTarget = clampPosition(keyboardTarget.x, keyboardTarget.y);
      showTarget(keyboardTarget, 'keyboard');
    }
    debugMenu?.position();
  });

  function play(name, repetitions = 1) {
    if (name === idleName) idleAction = !reducedMotion.matches && breathingAction ? breathingAction : actions.get(name);
    const next = name === idleName ? idleAction : actions.get(name);
    if (!next) return;
    const firstAction = !currentAction;
    if (currentAction === next) next.stop();
    else if (currentAction) currentAction.fadeOut(.28);
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(name === 'fold_arms' ? 2 : 1);
    next.setEffectiveWeight(1);
    const breathing = next === breathingAction;
    next.setLoop(breathing || repetitions > 1 ? THREE.LoopRepeat : THREE.LoopOnce, breathing ? Infinity : repetitions);
    next.clampWhenFinished = true;
    if (!firstAction) next.fadeIn(.28);
    next.play();
    currentAction = next;
    if (firstAction) mixer.update(0);
    idleSettled = breathing;
    if (name === idleName) idleDue = performance.now() + quietDelay();
    startRendering();
    debugMenu?.markActive(name);
  }

  function breathingClip(clip) {
    const breathing = clip.clone();
    breathing.name = `${clip.name}-breathing`;
    breathing.duration = 6;
    const angles = { mixamorigSpine: .6, mixamorigSpine1: .4, mixamorigHead: -.3 };
    const axis = new THREE.Vector3(1, 0, 0);
    breathing.tracks = breathing.tracks.map(track => {
      const angle = angles[track.name.replace(/\.quaternion$/, '')];
      if (track.ValueTypeName !== 'quaternion' || angle === undefined) return track;
      const base = new THREE.Quaternion().fromArray(track.values);
      const times = [];
      const values = [];
      for (let frame = 0; frame <= 48; frame++) {
        const phase = (1 - Math.cos(frame / 48 * Math.PI * 2)) / 2;
        const turn = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(angle) * phase);
        times.push(frame / 48 * breathing.duration);
        base.clone().multiply(turn).toArray(values, values.length);
      }
      return new THREE.QuaternionKeyframeTrack(track.name, times, values);
    });
    return breathing;
  }

  function walkInPlace(clip, model) {
    const hipName = THREE.PropertyBinding.sanitizeNodeName('mixamorig:Hips');
    const hips = model.getObjectByName(hipName);
    const rootTrack = hips && clip.tracks.find((item) => item.name === `${hips.name}.position`);
    if (!rootTrack) return null;

    const forward = rootTrack.values[2];
    const distance = rootTrack.values[rootTrack.values.length - 1] - forward;
    if (distance <= 0) return null;

    const rootPosition = rootTrack.createInterpolant();
    walkMotion = {
      distance,
      duration: clip.duration,
      distanceAt: (time) => rootPosition.evaluate(time)[2] - forward,
    };

    const copy = clip.clone();
    const inPlaceTrack = copy.tracks.find((item) => item.name === rootTrack.name);
    for (let index = 2; index < inPlaceTrack.values.length; index += 3) inPlaceTrack.values[index] = forward;
    return copy;
  }

  function initScene() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 1, 10);
    camera.position.set(0, 1.18, 4.25);
    camera.lookAt(0, 1.18, 0);

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.9;
    canvasHost.append(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd6c7aa, 2.6));
    const key = new THREE.DirectionalLight(0xffe9d2, 3.3);
    key.position.set(-2, 4, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 2.6);
    rim.position.set(3, 2, -3);
    scene.add(rim);
    const viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

    renderScene = (timestamp) => {
      const delta = lastFrameTime === null ? 0 : (timestamp - lastFrameTime) / 1000;
      lastFrameTime = timestamp;
      if (mixer) mixer.update(delta);
      if (trip) {
        const elapsed = Math.max(0, mixer.time - trip.startedAt);
        const cycles = Math.floor(elapsed / walkMotion.duration);
        const displacement = cycles * walkMotion.distance + walkMotion.distanceAt(elapsed - cycles * walkMotion.duration);
        const progress = Math.min(1, displacement * walkPixelsPerUnit / trip.distance);
        setPosition(
          trip.start.x + (trip.end.x - trip.start.x) * progress,
          trip.start.y + (trip.end.y - trip.start.y) * progress,
        );
        if (progress >= 1) finishTravel();
      }
      if (facingGroup) {
        const turn = Math.atan2(Math.sin(desiredYaw - facingGroup.rotation.y), Math.cos(desiredYaw - facingGroup.rotation.y));
        facingGroup.rotation.y += turn * (1 - Math.exp(-delta * 9));
      }
      renderer.render(scene, camera);
    };

    function fitCanvas() {
      const { width, height } = canvasHost.getBoundingClientRect();
      if (!width || !height) return;
      // Bound the drawing buffer to one megapixel, even on large displays.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5, Math.sqrt(1_000_000 / (width * height))));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (modelScale) walkPixelsPerUnit = modelScale * height / viewHeight;
      if (!rendering) renderer.render(scene, camera);
    }

    // Browser zoom and moving between screens change the pixel ratio but not the CSS size,
    // so the ResizeObserver stays silent. A resolution query fires once per change; re-arm it.
    function watchPixelRatio() {
      on(window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`), 'change', () => {
        fitCanvas();
        watchPixelRatio();
      }, { once: true });
    }

    resizeObserver = new ResizeObserver(fitCanvas);
    watchPixelRatio();
    resizeObserver.observe(canvasHost);

    new GLTFLoader().load(modelUrl, (gltf) => {
      if (destroyed) return;
      const model = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      modelScale = 2.3 / bounds.getSize(new THREE.Vector3()).y;
      model.scale.setScalar(modelScale);
      model.position.set(-center.x * modelScale, -bounds.min.y * modelScale, -center.z * modelScale);
      walkPixelsPerUnit = modelScale * canvasHost.clientHeight / viewHeight;
      facingGroup = new THREE.Group();
      facingGroup.add(model);
      scene.add(facingGroup);

      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) {
        const name = clip.name.split('|').pop().replace(/\.\d+$/, '');
        if (!clips[name]) continue;
        let actionClip = name === 'walk' ? walkInPlace(clip, model) : clip;
        if (name === 'clap') {
          actionClip = clip.clone();
          // End as the hands separate after the clap at three seconds.
          actionClip.duration = 74 / 24;
          actionClip.trim();
        }
        if (actionClip) actions.set(name, mixer.clipAction(actionClip));
      }
      idleName = actions.has('idle_clear') ? 'idle_clear' : 'fold_arms';
      idleAction = actions.get(idleName);
      if (idleName === 'idle_clear') breathingAction = mixer.clipAction(breathingClip(idleAction.getClip()));
      mixer.addEventListener('finished', ({ action }) => {
        if (action !== currentAction) return;
        if (trip && action === actions.get('walk')) {
          finishTravel();
          return;
        }
        if (automaticAction) {
          if (automaticAction.hold) {
            automaticAction.until = performance.now() + 10_000 + Math.random() * 50_000;
            idleSettled = true;
            queueMicrotask(() => { if (idleSettled && currentAction !== breathingAction) stopRendering(); });
          } else finishAutomatic();
          return;
        }
        if (action === idleAction) {
          idleDue = performance.now() + quietDelay();
          idleSettled = true;
          queueMicrotask(() => { if (idleSettled && currentAction !== breathingAction) stopRendering(); });
        } else play(idleName);
      });
      debugMenu?.build();
      loaded = true;
      loading.hidden = true;
      showHint();
      if (!greeted && !document.hidden && !reducedMotion.matches && actions.has('bow')) {
        greeted = true;
        remember(sessionStorage, 'digital-companion-greeted', 'true');
        startAutomatic('bow');
      } else if (idleAction) play(idleName);
    }, undefined, (error) => {
      console.error('Could not load mascot:', error);
      loading.innerHTML = '<span>COULD NOT LOAD THE MODEL</span>';
    });
  }

  // A manual action picker for development: it plays any clip on demand.
  function setupDebugMenu() {
    widget.insertAdjacentHTML('beforeend', `
      <button class="dm-trigger" type="button" aria-label="Open character actions" aria-expanded="false"><span aria-hidden="true">✳</span></button>
      <div class="dm-menu" role="group" aria-label="Character actions" hidden>
        <div class="dm-menu-heading"><span>DEBUG ACTIONS</span><span aria-hidden="true">✳</span></div>
        <div class="dm-actions"></div>
        <button class="dm-home" type="button"><span aria-hidden="true">↗</span> Back to my corner</button>
      </div>`);
    const trigger = widget.querySelector('.dm-trigger');
    const menu = widget.querySelector('.dm-menu');
    const grid = widget.querySelector('.dm-actions');
    let closeTimer;
    let pinned = false;

    function position() {
      menu.classList.remove('below', 'beside-left', 'beside-right', 'mobile-sheet', 'top-sheet');
      menu.style.top = '';
      menu.style.maxHeight = '';
      const widgetRect = widget.getBoundingClientRect();
      if (window.matchMedia(mobileQuery).matches) {
        menu.classList.add('mobile-sheet');
        menu.classList.toggle('top-sheet', widgetRect.top + widgetRect.height / 2 > window.innerHeight / 2);
        menu.style.maxHeight = `${window.innerHeight - 24}px`;
        return;
      }
      const width = menu.offsetWidth;
      const left = widgetRect.left - 12;
      const right = window.innerWidth - widgetRect.right - 12;
      if (Math.max(left, right) >= width + 8) {
        menu.classList.add(left >= width + 8 ? 'beside-left' : 'beside-right');
        menu.style.maxHeight = `${window.innerHeight - 16}px`;
        const top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, widgetRect.top + (widgetRect.height - menu.offsetHeight) / 2));
        menu.style.top = `${top - widgetRect.top}px`;
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      const placeBelow = menu.scrollHeight > above && below > above;
      menu.classList.toggle('below', placeBelow);
      menu.style.maxHeight = `${Math.max(120, placeBelow ? below : above)}px`;
    }

    function open(pin = false) {
      interruptAutomatic();
      clearTimeout(closeTimer);
      if (keyboardTarget) {
        keyboardTarget = null;
        cancelTravel();
      }
      pinned ||= pin;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-label', 'Close character actions');
      position();
    }

    function close() {
      clearTimeout(closeTimer);
      menu.hidden = true;
      pinned = false;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-label', 'Open character actions');
    }

    function scheduleClose() {
      if (!pinned) closeTimer = setTimeout(close, 350);
    }

    trigger.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse' && window.matchMedia('(hover: hover)').matches) open();
    });
    trigger.addEventListener('click', () => {
      if (menu.hidden) open(true);
      else if (pinned) close();
      else pinned = true;
    });
    widget.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    widget.addEventListener('pointerleave', scheduleClose);
    menu.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    menu.addEventListener('pointerleave', scheduleClose);
    on(document, 'pointerdown', (event) => {
      if (!widget.contains(event.target)) close();
    });
    on(document, 'keydown', (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        close();
        trigger.focus();
      }
    });
    widget.querySelector('.dm-home').addEventListener('click', () => {
      close();
      travelTo(defaultDestination());
    });

    return {
      isOpen: () => !menu.hidden,
      close,
      position: () => { if (!menu.hidden) position(); },
      markActive(name) {
        grid.querySelectorAll('button').forEach((button) => {
          button.classList.toggle('active', button.dataset.action === name);
          button.setAttribute('aria-pressed', String(button.dataset.action === name));
        });
      },
      build() {
        for (const [name, [label, symbol]] of Object.entries(clips)) {
          if (!actions.has(name)) continue;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dm-action';
          const symbolElement = document.createElement('span');
          symbolElement.className = 'dm-action-symbol';
          symbolElement.textContent = symbol;
          symbolElement.setAttribute('aria-hidden', 'true');
          button.append(symbolElement, document.createTextNode(label));
          button.dataset.action = name;
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            close();
            cancelTravel(true);
            play(name);
          });
          grid.append(button);
        }
      },
    };
  }

  function destroy() {
    destroyed = true;
    lifetime.abort();
    clearInterval(tick);
    clearTimeout(hintTimer);
    resizeObserver?.disconnect();
    renderer?.setAnimationLoop(null);
    renderer?.dispose();
    // dispose() leaves the model's textures and buffers on the GPU until the context is collected.
    renderer?.forceContextLoss();
    root.remove();
  }

  applyTheme();
  if (debug) debugMenu = setupDebugMenu();
  restoreSize();
  restorePosition();
  try { initScene(); } catch (error) {
    console.error('Could not start the 3D viewer:', error);
    loading.textContent = '3D IS UNAVAILABLE HERE';
  }

  return { setTheme, destroy };
}
