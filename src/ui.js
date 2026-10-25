/**
 * DOM interface, time-zone conversion, and accessible controls.
 * No astronomical positions are calculated here.
 */
import { CATALOG, CATALOG_BY_ID } from './catalog.js';
import {
  DAY_MS,
  MAX_UTC_MS,
  MIN_UTC_MS,
  SUPPORTED_RANGE_LABEL,
} from './astronomy.js';

const SPEED_LABELS = {
  1: 'Real time',
  60: '1 min / sec',
  3600: '1 hour / sec',
  86400: '1 day / sec',
  604800: '1 week / sec',
  2592000: '30 days / sec',
  31557600: '1 year / sec',
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const dateFormatterUtc = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const timeFormatterUtc = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function pad(value) {
  return String(value).padStart(2, '0');
}

function validParts(year, month, day, hour, minute, second) {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    && Number.isInteger(hour) && Number.isInteger(minute) && Number.isInteger(second)
    && month >= 1 && month <= 12 && day >= 1 && day <= 31
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/**
 * Converts a datetime-local control value into UTC milliseconds.
 * mode is "local" (browser zone) or "utc".
 */
export function parseDateTimeInput(value, mode = 'local') {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || '').trim());
  if (!match) {
    throw new Error('Enter a complete date and time, including seconds if desired.');
  }
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s || 0);
  if (!validParts(year, month, day, hour, minute, second)) {
    throw new Error('That date or time is not valid.');
  }

  let ms;
  if (mode === 'utc') {
    ms = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const date = new Date(ms);
    if (
      date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
      || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    ) {
      throw new Error('That UTC date or time is not valid.');
    }
  } else {
    const date = new Date(year, month - 1, day, hour, minute, second, 0);
    ms = date.getTime();
    if (
      date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
    ) {
      throw new Error('That local time does not exist because of a daylight-saving change. Choose another time or use UTC.');
    }
  }

  if (ms < MIN_UTC_MS || ms > MAX_UTC_MS) {
    throw new Error(`Supported range: ${SUPPORTED_RANGE_LABEL}.`);
  }
  return ms;
}

export function formatDateTimeInput(date, mode = 'local') {
  if (mode === 'utc') {
    return [
      date.getUTCFullYear(),
      pad(date.getUTCMonth() + 1),
      pad(date.getUTCDate()),
    ].join('-') + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  }
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch {
    return 'Local';
  }
}

function zoneAbbreviation(date) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

function offsetLabel(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value?.replace('GMT', 'UTC') || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatUtcStamp(date) {
  return `UTC ${date.toISOString().slice(0, 19).replace('T', ' ')}`;
}

function speedStatus(speed) {
  return SPEED_LABELS[speed] || `${numberFormatter.format(speed)}×`;
}

function safeSetText(element, text) {
  if (!element) return;
  const value = String(text);
  if (element.textContent !== value) element.textContent = value;
}

function createElement(tag, className, parent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (parent) parent.appendChild(element);
  return element;
}

export class UI {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.timezoneMode = 'local';
    this.localZone = localTimeZone();
    this.scrubbing = false;
    this._toastTimer = null;
    this._lastClockSecond = null;
    this._lastSliderSecond = null;
    this._lastSelectedId = undefined;
    this._lastInfoMs = 0;
    this._lastToggleSignature = '';
    this._lastPlaybackSignature = '';
    this._lastPresetSignature = '';
    this._mobileQuery = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;

    this._cacheNodes();
    this._buildBodyList();
    this._bindEvents();
    this._configureTimezoneText();
  }

  _cacheNodes() {
    const byId = (id) => document.getElementById(id);
    this.nodes = {
      clockKicker: byId('clockKicker'),
      clockZoneLabel: byId('clockZoneLabel'),
      clockTime: byId('clockTime'),
      clockDate: byId('clockDate'),
      clockUtc: byId('clockUtc'),
      playbackDot: byId('playbackDot'),
      nowButton: byId('nowButton'),
      nowInline: byId('nowInline'),
      aboutButton: byId('aboutButton'),
      aboutDialog: byId('aboutDialog'),
      aboutClose: byId('aboutClose'),
      bodyList: byId('body-list'),
      inspector: byId('inspector'),
      inspectorToggle: byId('inspectorToggle'),
      inspectorToggleLabel: document.querySelector('.inspector-toggle-label'),
      inspectorContent: byId('inspectorContent'),
      inspectorEmpty: byId('inspectorEmpty'),
      infoSwatch: byId('infoSwatch'),
      infoKicker: byId('infoKicker'),
      infoName: byId('infoName'),
      infoKind: byId('infoKind'),
      infoDescription: byId('infoDescription'),
      infoDistance: byId('infoDistance'),
      infoDistanceKm: byId('infoDistanceKm'),
      infoAngles: byId('infoAngles'),
      infoEarthDistanceRow: byId('infoEarthDistanceRow'),
      infoEarthDistance: byId('infoEarthDistance'),
      infoPeriod: byId('infoPeriod'),
      infoRadius: byId('infoRadius'),
      infoCaveat: byId('infoCaveat'),
      focusSelected: byId('focusSelected'),
      focusSelectedLabel: byId('focusSelectedLabel'),
      clearSelection: byId('clearSelection'),
      presetSystem: byId('presetSystem'),
      presetInner: byId('presetInner'),
      resetView: byId('resetView'),
      toggleOrbits: byId('toggleOrbits'),
      toggleLabels: byId('toggleLabels'),
      toggleGrid: byId('toggleGrid'),
      reverseBtn: byId('reverseBtn'),
      playBtn: byId('playBtn'),
      forwardBtn: byId('forwardBtn'),
      speedSelect: byId('speedSelect'),
      dateTimeInput: byId('dateTimeInput'),
      timezoneLocal: byId('timezoneLocal'),
      timezoneUtc: byId('timezoneUtc'),
      timezoneLabel: byId('timezoneLabel'),
      timeSlider: byId('timeSlider'),
      sliderReadout: byId('sliderReadout'),
      playbackStatus: byId('playbackStatus'),
      deltaTStatus: byId('deltaTStatus'),
      toast: byId('toast'),
      loading: byId('loading'),
      loadingStatus: byId('loadingStatus'),
      fatalError: byId('fatal-error'),
    };
  }

  _buildBodyList() {
    this.bodyButtons = {};
    for (let i = 0; i < CATALOG.length; i += 1) {
      const body = CATALOG[i];
      const item = createElement('button', 'body-item', this.nodes.bodyList);
      item.type = 'button';
      item.dataset.bodyId = body.id;
      item.style.setProperty('--body-color', body.color);
      if (body.id === 'moon') item.classList.add('is-moon');
      item.setAttribute('aria-label', `Select ${body.name}`);
      const dot = createElement('span', 'body-dot', item);
      dot.setAttribute('aria-hidden', 'true');
      const name = createElement('span', 'body-item-name', item);
      name.textContent = body.name;
      const index = createElement('span', 'body-item-index', item);
      index.textContent = String(i + 1).padStart(2, '0');
      index.setAttribute('aria-hidden', 'true');
      item.addEventListener('click', () => this.callbacks.onSelect?.(body.id, { focus: true }));
      this.bodyButtons[body.id] = item;
    }
  }

  _bindEvents() {
    const n = this.nodes;

    n.nowButton.addEventListener('click', () => this.callbacks.onNow?.());
    n.nowInline.addEventListener('click', () => this.callbacks.onNow?.());
    n.aboutButton.addEventListener('click', () => this.openAbout());
    n.aboutClose.addEventListener('click', () => n.aboutDialog.close());
    n.aboutDialog.addEventListener('click', (event) => {
      if (event.target === n.aboutDialog) n.aboutDialog.close();
    });

    n.playBtn.addEventListener('click', () => this.callbacks.onPlayToggle?.());
    n.reverseBtn.addEventListener('click', () => this.callbacks.onDirection?.(-1));
    n.forwardBtn.addEventListener('click', () => this.callbacks.onDirection?.(1));
    n.speedSelect.addEventListener('change', () => {
      this.callbacks.onSpeed?.(Number(n.speedSelect.value));
    });

    for (const [name, button] of [['system', n.presetSystem], ['inner', n.presetInner]]) {
      button.addEventListener('click', () => this.callbacks.onPreset?.(name));
    }
    n.resetView.addEventListener('click', () => this.callbacks.onResetView?.());

    for (const [name, button] of [['orbits', n.toggleOrbits], ['labels', n.toggleLabels], ['grid', n.toggleGrid]]) {
      button.addEventListener('click', () => {
        const next = button.getAttribute('aria-pressed') !== 'true';
        this.callbacks.onToggleLayer?.(name, next);
      });
    }

    n.focusSelected.addEventListener('click', () => {
      if (this._selectedId) this.callbacks.onFocus?.(this._selectedId);
    });
    n.clearSelection.addEventListener('click', () => this.callbacks.onClear?.());

    n.dateTimeInput.addEventListener('change', () => {
      try {
        const ms = parseDateTimeInput(n.dateTimeInput.value, this.timezoneMode);
        this.callbacks.onTimeChange?.(ms, 'date');
      } catch (error) {
        this.showToast(error.message || 'That date and time is not valid.');
        this.callbacks.onInvalidTime?.();
      }
    });

    n.timezoneLocal.addEventListener('click', () => this._setTimezoneMode('local'));
    n.timezoneUtc.addEventListener('click', () => this._setTimezoneMode('utc'));

    n.timeSlider.addEventListener('pointerdown', () => {
      this.scrubbing = true;
    });
    n.timeSlider.addEventListener('input', () => {
      const value = Number(n.timeSlider.value);
      const ms = Math.round(MIN_UTC_MS + value * DAY_MS);
      this.callbacks.onScrub?.(Math.min(MAX_UTC_MS, Math.max(MIN_UTC_MS, ms)));
    });
    window.addEventListener('pointerup', () => {
      this.scrubbing = false;
    });
    window.addEventListener('pointercancel', () => {
      this.scrubbing = false;
    });

    n.inspectorToggle.addEventListener('click', () => {
      const collapsed = n.inspector.classList.toggle('is-collapsed');
      n.inspectorToggle.setAttribute('aria-expanded', String(!collapsed));
    });

    if (this._mobileQuery) {
      const apply = (event) => {
        if (event.matches) {
          n.inspector.classList.add('is-collapsed');
          n.inspectorToggle.setAttribute('aria-expanded', 'false');
        } else {
          n.inspector.classList.remove('is-collapsed');
          n.inspectorToggle.setAttribute('aria-expanded', 'true');
        }
      };
      apply(this._mobileQuery);
      this._mobileQuery.addEventListener?.('change', apply);
    }

    document.addEventListener('keydown', (event) => {
      if (n.aboutDialog.open) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
      if (event.code === 'Space') {
        event.preventDefault();
        this.callbacks.onPlayToggle?.();
      } else if (event.key.toLowerCase() === 'n') {
        this.callbacks.onNow?.();
      } else if (event.key === '1') {
        this.callbacks.onPreset?.('system');
      } else if (event.key === '2') {
        this.callbacks.onPreset?.('inner');
      } else if (event.key === '0') {
        this.callbacks.onResetView?.();
      }
    });

    const maxDays = (MAX_UTC_MS - MIN_UTC_MS) / DAY_MS;
    n.timeSlider.min = '0';
    n.timeSlider.max = String(maxDays);
    n.timeSlider.step = String(1 / 24);
    this._configureTimezoneText();
  }

  _setTimezoneMode(mode) {
    if (mode === this.timezoneMode) return;
    this.timezoneMode = mode;
    this._configureTimezoneText();
    this.callbacks.onTimezoneChange?.(mode);
  }

  _configureTimezoneText() {
    const n = this.nodes;
    n.timezoneLocal.classList.toggle('is-active', this.timezoneMode === 'local');
    n.timezoneUtc.classList.toggle('is-active', this.timezoneMode === 'utc');
    n.timezoneLocal.setAttribute('aria-pressed', String(this.timezoneMode === 'local'));
    n.timezoneUtc.setAttribute('aria-pressed', String(this.timezoneMode === 'utc'));
    const now = new Date();
    const zone = this.localZone;
    safeSetText(n.timezoneLabel, this.timezoneMode === 'local'
      ? `Local time · ${zone} (${offsetLabel(now)})`
      : `UTC entry · local display uses ${zone}`);
    this._lastClockSecond = null;
    this._syncDateRange();
  }

  _syncDateRange() {
    const min = new Date(MIN_UTC_MS);
    const max = new Date(MAX_UTC_MS);
    this.nodes.dateTimeInput.min = formatDateTimeInput(min, this.timezoneMode);
    this.nodes.dateTimeInput.max = formatDateTimeInput(max, this.timezoneMode);
  }

  openAbout() {
    if (!this.nodes.aboutDialog.open) {
      this.nodes.aboutDialog.showModal();
    }
  }

  closeAbout() {
    if (this.nodes.aboutDialog.open) this.nodes.aboutDialog.close();
  }

  refreshTime(state) {
    this._lastClockSecond = null;
    this._lastSliderSecond = null;
    this._lastInfoMs = 0;
    this.render(state);
  }

  setLoadingStatus(text) {
    safeSetText(this.nodes.loadingStatus, text);
  }

  finishLoading() {
    const loading = this.nodes.loading;
    loading.classList.add('is-done');
    setTimeout(() => {
      loading.hidden = true;
    }, 550);
  }

  showFatal(message) {
    if (window.__showFatal) {
      window.__showFatal(message);
      return;
    }
    this.nodes.fatalError.hidden = false;
    this.nodes.fatalError.querySelector('[data-fatal-detail]').textContent = message;
  }

  showToast(message, duration = 3000) {
    const toast = this.nodes.toast;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, duration);
  }

  render(state) {
    this._selectedId = state.selectedId;
    this._renderTime(state);
    this._renderPlayback(state);
    this._renderPreset(state);
    this._renderSelection(state);
    this._renderLayers(state.toggles);
  }

  _renderPreset(state) {
    const active = state.focusedId ? null : state.presetName;
    const signature = String(active);
    if (signature === this._lastPresetSignature) return;
    this._lastPresetSignature = signature;
    this.nodes.presetSystem.classList.toggle('is-active', active === 'system');
    this.nodes.presetInner.classList.toggle('is-active', active === 'inner');
    this.nodes.presetSystem.setAttribute('aria-pressed', String(active === 'system'));
    this.nodes.presetInner.setAttribute('aria-pressed', String(active === 'inner'));
  }

  _renderTime(state) {
    const n = this.nodes;
    const date = new Date(state.simMs);
    const secondKey = `${Math.floor(state.simMs / 1000)}:${this.timezoneMode}:${state.playing}:${state.direction}`;
    if (secondKey !== this._lastClockSecond) {
      this._lastClockSecond = secondKey;
      const isLocal = this.timezoneMode === 'local';
      safeSetText(n.clockKicker, state.playing
        ? (state.direction < 0 ? 'Reverse playback' : 'Forward playback')
        : 'Selected instant');
      safeSetText(n.clockZoneLabel, isLocal ? `Local · ${zoneAbbreviation(date)}` : 'UTC');
      safeSetText(n.clockTime, isLocal ? timeFormatter.format(date) : timeFormatterUtc.format(date));
      safeSetText(n.clockDate, isLocal ? dateFormatter.format(date) : dateFormatterUtc.format(date));
      safeSetText(n.clockUtc, isLocal ? formatUtcStamp(date) : `Local ${dateFormatter.format(date)} ${timeFormatter.format(date)}`);
      safeSetText(n.timezoneLabel, isLocal
        ? `Local time · ${this.localZone} (${offsetLabel(date)})`
        : `UTC entry · local display uses ${this.localZone}`);
      if (document.activeElement !== n.dateTimeInput) {
        n.dateTimeInput.value = formatDateTimeInput(date, this.timezoneMode);
      }
    }

    if (!this.scrubbing && (this._lastSliderSecond === null || Math.abs(state.simMs - this._lastSliderSecond) > 800)) {
      this._lastSliderSecond = state.simMs;
      n.timeSlider.value = String(clamp((state.simMs - MIN_UTC_MS) / DAY_MS, 0, Number(n.timeSlider.max)));
    }
    safeSetText(n.sliderReadout, `${dateFormatter.format(date)}`);
    if (state.snapshot && Number.isFinite(state.snapshot.deltaTSeconds)) {
      safeSetText(n.deltaTStatus, `ΔT ${state.snapshot.deltaTSeconds.toFixed(1)} s → TT`);
    }
  }

  _renderPlayback(state) {
    const n = this.nodes;
    const signature = `${state.playing}:${state.direction}:${state.speed}`;
    if (signature !== this._lastPlaybackSignature) {
      this._lastPlaybackSignature = signature;
      n.playBtn.classList.toggle('is-playing', state.playing);
      n.playBtn.title = state.playing ? 'Pause' : 'Play';
      n.playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
      n.reverseBtn.classList.toggle('is-active', state.playing && state.direction < 0);
      n.forwardBtn.classList.toggle('is-active', state.playing && state.direction > 0);
      n.reverseBtn.setAttribute('aria-pressed', String(state.playing && state.direction < 0));
      n.forwardBtn.setAttribute('aria-pressed', String(state.playing && state.direction > 0));
      n.playbackDot.classList.toggle('is-playing', state.playing);
      n.speedSelect.value = String(state.speed);
      if (!state.playing) {
        safeSetText(n.playbackStatus, 'Paused · at selected instant');
      } else if (state.speed === 1) {
        safeSetText(n.playbackStatus, state.direction < 0 ? 'Reverse · real time' : 'Live · real-time playback');
      } else {
        safeSetText(n.playbackStatus, `${state.direction < 0 ? 'Reverse' : 'Forward'} · ${speedStatus(state.speed)}`);
      }
    }
  }

  _renderSelection(state) {
    const selectedId = state.selectedId;
    const def = selectedId ? CATALOG_BY_ID[selectedId] : null;
    const selectionChanged = selectedId !== this._lastSelectedId;
    const focusChanged = state.focusedId !== this._lastFocusedId;
    if (selectionChanged) {
      this._lastSelectedId = selectedId;
      for (const [id, button] of Object.entries(this.bodyButtons)) {
        const selected = id === selectedId;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-current', selected ? 'true' : 'false');
      }
      this.nodes.focusSelected.disabled = !def;
      this.nodes.inspectorToggleLabel.textContent = def ? `${def.name} details` : 'Details';
      this.nodes.inspectorToggle.setAttribute('aria-expanded', String(!this.nodes.inspector.classList.contains('is-collapsed')));
    }
    this._lastFocusedId = state.focusedId;

    const needContent = Boolean(def) && (selectionChanged || focusChanged || Math.abs(state.simMs - this._lastInfoMs) > 120);
    if (!def) {
      this.nodes.inspectorContent.hidden = true;
      this.nodes.inspectorEmpty.hidden = false;
      this.nodes.focusSelected.disabled = true;
      return;
    }
    this.nodes.inspectorContent.hidden = false;
    this.nodes.inspectorEmpty.hidden = true;
    if (!needContent) return;
    this._lastInfoMs = state.simMs;

    const position = state.snapshot?.positions?.[selectedId];
    this.nodes.infoSwatch.style.setProperty('--swatch', def.color);
    this.nodes.infoSwatch.style.setProperty('--swatch-light', def.accent);
    safeSetText(this.nodes.infoKicker, state.focusedId === selectedId ? 'Camera target' : 'Selected body');
    safeSetText(this.nodes.infoName, def.name);
    safeSetText(this.nodes.infoKind, def.kind);
    safeSetText(this.nodes.infoDescription, def.description);

    if (position) {
      safeSetText(this.nodes.infoDistance, position.distanceAu.toFixed(6));
      safeSetText(
        this.nodes.infoDistanceKm,
        selectedId === 'sun' ? 'reference origin' : `${(position.distanceKm / 1_000_000).toFixed(3)} million km`,
      );
      const lon = `${position.lonDeg.toFixed(2)}°`;
      const lat = `${position.latDeg >= 0 ? '+' : '−'}${Math.abs(position.latDeg).toFixed(2)}°`;
      safeSetText(this.nodes.infoAngles, `${lon} / ${lat}`);
    } else {
      safeSetText(this.nodes.infoDistance, '—');
      safeSetText(this.nodes.infoDistanceKm, '');
      safeSetText(this.nodes.infoAngles, '—');
    }

    const isMoon = selectedId === 'moon';
    this.nodes.infoEarthDistanceRow.hidden = !isMoon;
    if (isMoon && position?.earthDistanceAu != null) {
      safeSetText(this.nodes.infoEarthDistance, position.earthDistanceAu.toFixed(6));
    }

    safeSetText(this.nodes.infoPeriod, def.periodLabel);
    safeSetText(this.nodes.infoRadius, `${numberFormatter.format(Math.round(def.radiusKm))} km`);
    this.nodes.focusSelected.setAttribute('aria-label', `Focus the camera on ${def.name}`);
    safeSetText(this.nodes.focusSelectedLabel, state.focusedId === selectedId ? 'Re-centre' : 'Focus body');

    let caveat = '';
    if (selectedId === 'saturn') {
      caveat = 'Ring plane follows the modeled IAU north pole. Ring spacing and texture are illustrative; spin phase is not modeled.';
    } else if (selectedId === 'moon') {
      caveat = 'Orbit curve is geocentric and illustrative in segment density. Earth–Moon distance is calculated.';
    }
    this.nodes.infoCaveat.hidden = !caveat;
    safeSetText(this.nodes.infoCaveat, caveat);
  }

  _renderLayers(toggles) {
    const signature = `${toggles.orbits}:${toggles.labels}:${toggles.grid}`;
    if (signature === this._lastToggleSignature) return;
    this._lastToggleSignature = signature;
    const map = {
      orbits: this.nodes.toggleOrbits,
      labels: this.nodes.toggleLabels,
      grid: this.nodes.toggleGrid,
    };
    for (const [name, button] of Object.entries(map)) {
      button.classList.toggle('is-on', Boolean(toggles[name]));
      button.setAttribute('aria-pressed', String(Boolean(toggles[name])));
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
