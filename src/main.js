/**
 * Application orchestration.
 *
 * Simulation time is authored as a UTC millisecond value plus an anchor.
 * While playing, the current instant is derived from elapsed real time:
 *   sim = anchorSim + direction * speed * (now - anchorReal)
 * Orbital positions are then recomputed from that timestamp. No position is
 * integrated frame-by-frame, so frame rate and playback history cannot change
 * the state at a given instant.
 */
import {
  MAX_UTC_MS,
  MIN_UTC_MS,
  calculateSnapshot,
  clampToSupportedTime,
  describeModel,
} from './astronomy.js';
import { CATALOG_BY_ID } from './catalog.js';
import { SolarScene } from './scene.js';
import { UI } from './ui.js';

const state = {
  simMs: Date.now(),
  playing: true,
  direction: 1,
  speed: 1,
  anchorRealMs: performance.now(),
  anchorSimMs: Date.now(),
  selectedId: 'earth',
  focusedId: null,
  presetName: 'system',
  timezoneMode: 'local',
  snapshot: null,
  toggles: { orbits: true, labels: true, grid: false },
};

const snapshotCache = { ms: null, value: null };
let ui;
let scene;
let rafId = 0;
let stopping = false;
let boundaryToastAt = 0;

function getSnapshot(ms) {
  if (snapshotCache.ms === ms && snapshotCache.value) return snapshotCache.value;
  const value = calculateSnapshot(ms);
  snapshotCache.ms = ms;
  snapshotCache.value = value;
  return value;
}

function rebase(now = performance.now()) {
  state.anchorRealMs = now;
  state.anchorSimMs = state.simMs;
}

function boundaryForDirection(direction) {
  return direction > 0 ? MAX_UTC_MS : MIN_UTC_MS;
}

function isAtBoundary(direction) {
  return direction > 0 ? state.simMs >= MAX_UTC_MS : state.simMs <= MIN_UTC_MS;
}

function announceBoundary() {
  const now = performance.now();
  if (now - boundaryToastAt < 2500) return;
  boundaryToastAt = now;
  ui.showToast('Reached the edge of the supported 1900–2100 UTC interval.');
}

function announceBlockedDirection(direction) {
  ui.showToast(direction > 0
    ? 'At the end of the supported range. Choose an earlier time or play backwards.'
    : 'At the start of the supported range. Choose a later time or play forwards.');
}

function syncSimulation(now = performance.now()) {
  if (!state.playing) {
    rebase(now);
    return;
  }
  const elapsedSeconds = (now - state.anchorRealMs) / 1000;
  const deltaMs = state.direction * state.speed * elapsedSeconds * 1000;
  let next = state.anchorSimMs + deltaMs;
  if (next <= MIN_UTC_MS) {
    state.simMs = MIN_UTC_MS;
    state.playing = false;
    rebase(now);
    announceBoundary();
    return;
  }
  if (next >= MAX_UTC_MS) {
    state.simMs = MAX_UTC_MS;
    state.playing = false;
    rebase(now);
    announceBoundary();
    return;
  }
  state.simMs = Math.round(next);
}

function startPlaying(now = performance.now()) {
  if (isAtBoundary(state.direction)) {
    state.playing = false;
    announceBlockedDirection(state.direction);
    return;
  }
  state.playing = true;
  rebase(now);
}

function setTime(ms, { pause = true, notify = false } = {}) {
  const clamped = clampToSupportedTime(Number(ms));
  state.simMs = clamped;
  if (pause) state.playing = false;
  rebase();
  if (notify && clamped !== Number(ms)) {
    ui.showToast('That instant is outside 1900–2100 UTC; the boundary was used instead.');
  }
}

function selectBody(id, { focus = false } = {}) {
  if (!id) {
    clearSelection();
    return;
  }
  if (!CATALOG_BY_ID[id]) return;
  state.selectedId = id;
  scene.setSelected(id);
  if (focus) {
    state.focusedId = id;
    state.presetName = null;
    scene.focusBody(id);
  }
}

function clearSelection() {
  state.selectedId = null;
  state.focusedId = null;
  scene.setSelected(null);
  scene.clearFocus();
}

function focusBody() {
  if (!state.selectedId) return;
  state.focusedId = state.selectedId;
  state.presetName = null;
  scene.focusBody(state.selectedId);
}

function applyPreset(name) {
  state.focusedId = null;
  state.presetName = name;
  scene.setView(name, { animate: true });
}

function toggleLayer(name, value) {
  if (!(name in state.toggles)) return;
  state.toggles[name] = Boolean(value);
  if (name === 'orbits') scene.setOrbitsVisible(value);
  if (name === 'labels') scene.setLabelsVisible(value);
  if (name === 'grid') scene.setGridVisible(value);
}

function onNow() {
  state.simMs = Date.now();
  state.playing = true;
  state.direction = 1;
  state.speed = 1;
  rebase();
  ui.refreshTime(state);
}

function onPlayToggle() {
  syncSimulation();
  if (state.playing) {
    state.playing = false;
    rebase();
  } else {
    startPlaying();
  }
}

function onDirection(direction) {
  syncSimulation();
  if (isAtBoundary(direction)) {
    state.playing = false;
    announceBlockedDirection(direction);
    return;
  }
  state.direction = direction;
  state.playing = true;
  rebase();
}

function onSpeed(speed) {
  syncSimulation();
  state.speed = speed;
  rebase();
}

function onScrub(ms) {
  setTime(ms, { pause: true });
}

function onDateChange(ms) {
  setTime(ms, { pause: true });
}

function parseDebugTimestamp(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new TypeError(`Could not parse timestamp "${value}".`);
  return parsed;
}

function buildStateView() {
  return {
    simMs: state.simMs,
    utcIso: new Date(state.simMs).toISOString(),
    playing: state.playing,
    direction: state.direction,
    speed: state.speed,
    selectedId: state.selectedId,
    focusedId: state.focusedId,
    presetName: state.presetName,
    timezoneMode: ui?.timezoneMode || state.timezoneMode,
    toggles: { ...state.toggles },
    snapshot: state.snapshot,
    scene: scene?.debugState(),
    model: describeModel(),
    dateInputValue: ui?.nodes.dateTimeInput.value,
  };
}

const callbacks = {
  onSelect: (id, options) => selectBody(id, options),
  onFocus: (id) => {
    state.selectedId = id;
    scene.setSelected(id);
    focusBody();
  },
  onClear: clearSelection,
  onNow,
  onPlayToggle,
  onDirection,
  onSpeed,
  onScrub,
  onTimeChange: onDateChange,
  onInvalidTime: () => ui.refreshTime(state),
  onTimezoneChange: (mode) => {
    state.timezoneMode = mode;
    ui.refreshTime(state);
  },
  onPreset: applyPreset,
  onResetView: () => applyPreset('system'),
  onToggleLayer: toggleLayer,
  onHover: () => {},
};

function frame(now) {
  if (stopping) return;
  try {
    syncSimulation(now);
    const snapshot = getSnapshot(state.simMs);
    state.snapshot = snapshot;
    scene.update(snapshot);
    ui.render(state);
    rafId = requestAnimationFrame(frame);
  } catch (error) {
    fail(error);
  }
}

function fail(error) {
  if (stopping) return;
  stopping = true;
  cancelAnimationFrame(rafId);
  console.error('Solar system explorer stopped:', error);
  ui?.showFatal(error?.message || String(error));
}

function boot() {
  try {
    ui = new UI(callbacks);
    ui.setLoadingStatus('Compiling the local ephemeris model…');
    scene = new SolarScene({
      container: document.getElementById('scene-root'),
      markerLayer: document.getElementById('marker-layer'),
      onSelect: callbacks.onSelect,
      onHover: callbacks.onHover,
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
    });

    ui.setLoadingStatus('Calculating positions for the current instant…');
    state.simMs = Date.now();
    rebase();
    const snapshot = getSnapshot(state.simMs);
    state.snapshot = snapshot;
    scene.setSelected('earth');
    scene.update(snapshot);
    ui.render(state);
    ui.setLoadingStatus('Ready');
    ui.finishLoading();
    const fatal = document.getElementById('fatal-error');
    if (fatal) fatal.hidden = true;
    window.__orreryReady = true;

    // Debug / verification surface. Positions are still produced only by the
    // astronomy module and the requested timestamp.
    window.__orrery = {
      version: 1,
      getState: () => buildStateView(),
      snapshotAt: (value) => calculateSnapshot(parseDebugTimestamp(value)),
      positionAt: (bodyId, value) => calculateSnapshot(parseDebugTimestamp(value)).positions[bodyId],
      setTime: (value) => {
        setTime(parseDebugTimestamp(value), { pause: true });
        ui.refreshTime(state);
        return buildStateView();
      },
      now: onNow,
      play: () => {
        if (!state.playing) startPlaying();
        ui.refreshTime(state);
      },
      pause: () => {
        syncSimulation();
        state.playing = false;
        rebase();
        ui.refreshTime(state);
      },
      setDirection: (direction) => {
        onDirection(direction);
        ui.refreshTime(state);
      },
      setSpeed: (speed) => {
        onSpeed(Number(speed));
        ui.refreshTime(state);
      },
      select: (id, options = {}) => {
        selectBody(id, options);
        return buildStateView();
      },
      focus: (id) => {
        state.selectedId = id;
        scene.setSelected(id);
        focusBody();
        return buildStateView();
      },
      clear: clearSelection,
      preset: (name) => {
        applyPreset(name);
        return buildStateView();
      },
      resetView: () => {
        applyPreset('system');
        return buildStateView();
      },
      toggle: (name, value) => {
        toggleLayer(name, value);
        return buildStateView();
      },
      ui: () => ui,
      scene: () => scene,
    };

    rafId = requestAnimationFrame(frame);
  } catch (error) {
    stopping = false;
    fail(error);
  }
}

window.addEventListener('error', (event) => {
  if (window.__orreryReady && event?.error) {
    console.error('Uncaught error:', event.error);
  }
});

boot();
