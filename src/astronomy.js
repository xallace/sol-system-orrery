/**
 * Astronomy core. This module knows nothing about the DOM, Three.js, or UI.
 *
 * Position model
 * --------------
 * Astronomy Engine 2.1.19 (MIT) supplies heliocentric geometric vectors in the
 * J2000 mean-equator frame (EQJ). Those vectors are rotated once per query into
 * the J2000 mean-ecliptic frame (ECL) with Astronomy.Rotation_EQJ_ECL().
 * No light-time, aberration, nutation, or observer correction is applied:
 * these are geometric, heliocentric positions at the selected instant.
 *
 * `Date` objects are UTC. Astronomy Engine converts UTC -> TT internally with
 * the Espenak–Meeus Delta-T model when evaluating its VSOP87 series.
 */
import * as Astronomy from '../vendor/astronomy/astronomy.js';

export const AU_KM = Astronomy.KM_PER_AU;
export const DAY_MS = 86_400_000;
export const MIN_UTC_MS = Date.UTC(1900, 0, 1, 0, 0, 0, 0);
export const MAX_UTC_MS = Date.UTC(2100, 11, 31, 23, 59, 59, 999);
export const SUPPORTED_RANGE_LABEL = '1900-01-01 through 2100-12-31 (UTC)';

const ROT_EQJ_ECL = Astronomy.Rotation_EQJ_ECL();

const BODY = {
  sun: Astronomy.Body.Sun,
  mercury: Astronomy.Body.Mercury,
  venus: Astronomy.Body.Venus,
  earth: Astronomy.Body.Earth,
  moon: Astronomy.Body.Moon,
  mars: Astronomy.Body.Mars,
  jupiter: Astronomy.Body.Jupiter,
  saturn: Astronomy.Body.Saturn,
  uranus: Astronomy.Body.Uranus,
  neptune: Astronomy.Body.Neptune,
};

export const PLANETARY_PERIOD_DAYS = {
  mercury: 87.9691,
  venus: 224.701,
  earth: 365.256,
  mars: 686.980,
  jupiter: 4332.589,
  saturn: 10759.22,
  uranus: 30685.4,
  neptune: 60189.0,
  moon: 27.321661,
};

export function assertSupportedTime(ms) {
  if (!Number.isFinite(ms)) {
    throw new TypeError('Timestamp must be a finite number of milliseconds since the Unix epoch.');
  }
  if (ms < MIN_UTC_MS || ms > MAX_UTC_MS) {
    throw new RangeError(
      `Timestamp is outside the supported interval: ${SUPPORTED_RANGE_LABEL}.`,
    );
  }
  return ms;
}

export function clampToSupportedTime(ms) {
  if (!Number.isFinite(ms)) return MIN_UTC_MS;
  return Math.min(MAX_UTC_MS, Math.max(MIN_UTC_MS, ms));
}

/**
 * Rotate an EQJ vector to J2000 mean ecliptic coordinates.
 * ECL axes: +x toward the J2000 equinox, +y 90° eastward in the ecliptic,
 * +z toward ecliptic north.
 */
function toEcliptic(vector) {
  const ecliptic = Astronomy.RotateVector(ROT_EQJ_ECL, vector);
  return { x: ecliptic.x, y: ecliptic.y, z: ecliptic.z };
}

function sphericalFromEcliptic({ x, y, z }) {
  const distance = Math.hypot(x, y, z);
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const lat = distance === 0 ? 0 : (Math.asin(z / distance) * 180) / Math.PI;
  return {
    lon: (lon + 360) % 360,
    lat,
    distance,
  };
}

function positionRecord(ecliptic, extras = {}) {
  const distanceAu = Math.hypot(ecliptic.x, ecliptic.y, ecliptic.z);
  const spherical = sphericalFromEcliptic(ecliptic);
  return {
    frame: 'J2000 mean ecliptic (ECL)',
    x: ecliptic.x,
    y: ecliptic.y,
    z: ecliptic.z,
    distanceAu,
    distanceKm: distanceAu * AU_KM,
    lonDeg: spherical.lon,
    latDeg: spherical.lat,
    ...extras,
  };
}

function heliocentricVectorUnchecked(bodyId, dateMs) {
  if (!(bodyId in BODY) || bodyId === 'moon') {
    throw new RangeError(`No heliocentric planet vector is defined for "${bodyId}".`);
  }
  const time = new Date(dateMs);
  if (bodyId === 'sun') return { x: 0, y: 0, z: 0 };
  return toEcliptic(Astronomy.HelioVector(BODY[bodyId], time));
}

function geocentricMoonVectorUnchecked(dateMs) {
  return toEcliptic(Astronomy.GeoMoon(new Date(dateMs)));
}

/** Heliocentric geometric vector of a planet, in J2000 ecliptic coordinates. */
export function heliocentricVector(bodyId, dateMs) {
  assertSupportedTime(dateMs);
  return heliocentricVectorUnchecked(bodyId, dateMs);
}

/** Geocentric Moon vector in J2000 ecliptic coordinates, in AU. */
export function geocentricMoonVector(dateMs) {
  assertSupportedTime(dateMs);
  return geocentricMoonVectorUnchecked(dateMs);
}

/**
 * Unit vector toward a planet's IAU north pole, rotated into J2000 ecliptic
 * coordinates. Used only to orient Saturn's illustrative ring plane.
 */
export function northPoleDirection(bodyId, dateMs) {
  assertSupportedTime(dateMs);
  if (!(bodyId in BODY) || bodyId === 'moon') {
    throw new RangeError(`No rotation-axis model is used for "${bodyId}".`);
  }
  const axis = Astronomy.RotationAxis(BODY[bodyId], new Date(dateMs));
  const ecliptic = toEcliptic(axis.north);
  const length = Math.hypot(ecliptic.x, ecliptic.y, ecliptic.z);
  return {
    x: ecliptic.x / length,
    y: ecliptic.y / length,
    z: ecliptic.z / length,
  };
}

/**
 * Snapshot every body at one UTC instant.
 * The result is a pure function of `dateMs`; no accumulated simulation state
 * is consulted anywhere in this module.
 */
export function calculateSnapshot(dateMs) {
  assertSupportedTime(dateMs);
  const date = new Date(dateMs);
  const astroTime = new Astronomy.AstroTime(date);
  const earth = toEcliptic(Astronomy.HelioVector(Astronomy.Body.Earth, date));
  const moonGeo = toEcliptic(Astronomy.GeoMoon(date));
  const positions = {};

  for (const id of Object.keys(BODY)) {
    let vector;
    let extras = {};

    if (id === 'sun') {
      vector = { x: 0, y: 0, z: 0 };
    } else if (id === 'moon') {
      vector = {
        x: earth.x + moonGeo.x,
        y: earth.y + moonGeo.y,
        z: earth.z + moonGeo.z,
      };
      extras = {
        parent: 'earth',
        earthDistanceAu: Math.hypot(moonGeo.x, moonGeo.y, moonGeo.z),
        earthDistanceKm: Math.hypot(moonGeo.x, moonGeo.y, moonGeo.z) * AU_KM,
        relativeToEarth: moonGeo,
      };
    } else if (id === 'earth') {
      vector = earth;
    } else {
      vector = toEcliptic(Astronomy.HelioVector(BODY[id], date));
    }

    positions[id] = positionRecord(vector, extras);
  }

  return {
    utcMs: dateMs,
    utcIso: date.toISOString(),
    julianDayUtc: dateMs / DAY_MS + 2440587.5,
    deltaTSeconds: (astroTime.tt - astroTime.ut) * 86_400,
    frame: 'Heliocentric, J2000 mean ecliptic (ECL)',
    geometric: true,
    positions,
  };
}

/**
 * Polyline for one complete revolution, sampled from the same position model.
 * The first point is the body at `centerMs`; the rest sample forward by one
 * sidereal period. Moon polylines are geocentric and are drawn relative to
 * Earth; planet polylines are heliocentric.
 */
export function orbitPolyline(bodyId, centerMs, segments = 288) {
  assertSupportedTime(centerMs);
  const period = PLANETARY_PERIOD_DAYS[bodyId];
  if (!period) return null;

  if (bodyId === 'moon') {
    const points = [];
    for (let i = 0; i <= segments; i += 1) {
      // Path samples are allowed to extend beyond the selectable interval so
      // the curve still closes near 1900 and 2100. Positions shown for the
      // selected instant always remain inside the supported interval.
      const t = centerMs + (i / segments) * period * DAY_MS;
      points.push(geocentricMoonVectorUnchecked(t));
    }
    return {
      bodyId,
      frame: 'geocentric ecliptic',
      parent: 'earth',
      periodDays: period,
      epochMs: centerMs,
      points,
    };
  }

  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = centerMs + (i / segments) * period * DAY_MS;
    points.push(heliocentricVectorUnchecked(bodyId, t));
  }
  return {
    bodyId,
    frame: 'heliocentric ecliptic',
    parent: 'sun',
    periodDays: period,
    epochMs: centerMs,
    points,
  };
}

/** Local sidereal-ish diagnostics used by tests and the About panel. */
export function describeModel() {
  return {
    library: 'Astronomy Engine 2.1.19',
    positions: 'Geometric heliocentric vectors',
    coordinateFrame: 'J2000 mean ecliptic (ECL)',
    timeScale: 'UTC input converted internally to TT (ΔT via Espenak–Meeus)',
    range: SUPPORTED_RANGE_LABEL,
    orbitCurves: 'Sampled directly from the same position model over one sidereal period',
  };
}
