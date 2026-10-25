import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  AU_KM,
  DAY_MS,
  MAX_UTC_MS,
  MIN_UTC_MS,
  SUPPORTED_RANGE_LABEL,
  calculateSnapshot,
  clampToSupportedTime,
  describeModel,
  geocentricMoonVector,
  heliocentricVector,
  northPoleDirection,
  orbitPolyline,
} from '../src/astronomy.js';
import { formatDateTimeInput, parseDateTimeInput } from '../src/ui.js';

const reference = JSON.parse(await readFile(
  fileURLToPath(new URL('./reference-vectors.json', import.meta.url)),
  'utf8',
));

test('model metadata identifies the frame, time scale, and supported interval', () => {
  const model = describeModel();
  assert.match(model.coordinateFrame, /J2000 mean ecliptic/);
  assert.match(model.timeScale, /TT/);
  assert.match(model.range, /1900/);
  assert.equal(model.range, SUPPORTED_RANGE_LABEL);
});

test('the current-time snapshot has a geometric heliocentric frame and all ten bodies', () => {
  const snapshot = calculateSnapshot(Date.now());
  assert.equal(snapshot.geometric, true);
  assert.match(snapshot.frame, /Heliocentric/);
  assert.deepEqual(Object.keys(snapshot.positions).sort(), [
    'earth', 'jupiter', 'mars', 'mercury', 'moon', 'neptune', 'saturn', 'sun', 'uranus', 'venus',
  ]);
  for (const [id, position] of Object.entries(snapshot.positions)) {
    assert.ok(Number.isFinite(position.x), `${id} x`);
    assert.ok(Number.isFinite(position.y), `${id} y`);
    assert.ok(Number.isFinite(position.z), `${id} z`);
    assert.ok(position.distanceAu >= 0, `${id} distance`);
  }
  assert.deepEqual(
    { x: snapshot.positions.sun.x, y: snapshot.positions.sun.y, z: snapshot.positions.sun.z },
    { x: 0, y: 0, z: 0 },
  );
});

test('Earth, Mars, and Neptune agree with independent JPL Horizons vectors', async (t) => {
  const results = [];
  for (const epoch of reference.epochs) {
    const snapshot = calculateSnapshot(Date.parse(epoch.utc));
    for (const body of ['earth', 'mars', 'neptune']) {
      const actual = snapshot.positions[body];
      const expected = epoch.vectors[body];
      const dx = actual.x - expected[0];
      const dy = actual.y - expected[1];
      const dz = actual.z - expected[2];
      const positionErrorAu = Math.hypot(dx, dy, dz);
      const referenceRadius = Math.hypot(...expected);
      const angularErrorArcsec = Math.asin(positionErrorAu / referenceRadius) * 206264.80624709636;
      results.push({
        epoch: epoch.utc,
        body,
        positionErrorAu,
        positionErrorKm: positionErrorAu * AU_KM,
        angularErrorArcsec,
      });
      const limitAu = body === 'neptune' ? 0.003 : 0.00003;
      assert.ok(
        positionErrorAu < limitAu,
        `${body} at ${epoch.utc}: ${positionErrorAu} AU exceeds ${limitAu} AU`,
      );
    }
  }
  // Limits above are deliberately looser than the observed differences. These
  // values are printed for the README and make regressions visible.
  for (const result of results) {
    t.diagnostic(
      `${result.epoch} ${result.body}: ${result.positionErrorAu.toFixed(9)} AU, `
      + `${result.positionErrorKm.toFixed(0)} km, ${result.angularErrorArcsec.toFixed(2)}″`,
    );
  }
  const byKey = Object.fromEntries(results.map((result) => [`${result.epoch}:${result.body}`, result]));
  assert.ok(byKey['2025-01-01T00:00:00Z:earth'].positionErrorKm < 1000);
  assert.ok(byKey['2035-07-04T12:00:00Z:neptune'].positionErrorKm < 200000);
});

test('positions are a pure function of the requested timestamp', () => {
  const iso = '2029-02-14T12:34:56.789Z';
  const first = calculateSnapshot(Date.parse(iso));
  calculateSnapshot(Date.parse('1987-06-30T01:02:03Z'));
  calculateSnapshot(Date.parse('2099-12-31T23:00:00Z'));
  const second = calculateSnapshot(Date.parse(iso));
  assert.deepEqual(second, first);
  assert.equal(second.utcIso, iso);
});

test('supported boundaries are inclusive and out-of-range queries are rejected', () => {
  assert.doesNotThrow(() => calculateSnapshot(MIN_UTC_MS));
  assert.doesNotThrow(() => calculateSnapshot(MAX_UTC_MS));
  assert.throws(() => calculateSnapshot(MIN_UTC_MS - 1), RangeError);
  assert.throws(() => calculateSnapshot(MAX_UTC_MS + 1), RangeError);
  assert.equal(clampToSupportedTime(MIN_UTC_MS - 1), MIN_UTC_MS);
  assert.equal(clampToSupportedTime(MAX_UTC_MS + 1), MAX_UTC_MS);
});

test('the 2000 leap day is represented at the correct UTC instant', () => {
  const snapshot = calculateSnapshot(Date.parse('2000-02-29T12:00:00.000Z'));
  assert.equal(snapshot.utcIso, '2000-02-29T12:00:00.000Z');
  assert.equal(new Date(snapshot.utcMs).getUTCDate(), 29);
  assert.equal(new Date(snapshot.utcMs).getUTCMonth(), 1);
});

test('Delta-T is applied and stays in a physically plausible range', () => {
  const y2025 = calculateSnapshot(Date.parse('2025-01-01T00:00:00Z'));
  const y1900 = calculateSnapshot(Date.parse('1900-01-01T00:00:00Z'));
  assert.ok(y2025.deltaTSeconds > 50 && y2025.deltaTSeconds < 100);
  assert.ok(y1900.deltaTSeconds > -15 && y1900.deltaTSeconds < 15);
});

test('the Moon combines the geocentric ephemeris with Earth’s barycentric position', () => {
  const snapshot = calculateSnapshot(Date.parse('2026-10-25T20:00:00Z'));
  const moon = snapshot.positions.moon;
  const geo = geocentricMoonVector(Date.parse('2026-10-25T20:00:00Z'));
  const earth = snapshot.positions.earth;
  assert.ok(Math.abs(moon.x - (earth.x + geo.x)) < 1e-15);
  assert.ok(Math.abs(moon.y - (earth.y + geo.y)) < 1e-15);
  assert.ok(Math.abs(moon.z - (earth.z + geo.z)) < 1e-15);
  assert.ok(moon.earthDistanceAu > 0.0023 && moon.earthDistanceAu < 0.0028);
});

test('orbit polylines are sampled from the same position model', () => {
  const ms = Date.parse('2030-03-20T00:00:00Z');
  const curve = orbitPolyline('earth', ms, 128);
  assert.equal(curve.points.length, 129);
  const direct = heliocentricVector('earth', ms);
  assert.ok(Math.abs(curve.points[0].x - direct.x) < 1e-15);
  assert.ok(Math.abs(curve.points[0].y - direct.y) < 1e-15);
  assert.ok(Math.abs(curve.points[0].z - direct.z) < 1e-15);

  const xs = curve.points.map((point) => point.x);
  const ys = curve.points.map((point) => point.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 1.8);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1.8);
});

test('orbit curves still close at the supported end boundary', () => {
  const curve = orbitPolyline('earth', MAX_UTC_MS, 96);
  assert.equal(curve.points.length, 97);
  const xs = curve.points.map((point) => point.x);
  const ys = curve.points.map((point) => point.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 1.8);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 1.8);
});

test('Saturn’s modeled north pole is a unit vector', () => {
  const pole = northPoleDirection('saturn', Date.parse('2026-10-25T20:00:00Z'));
  const length = Math.hypot(pole.x, pole.y, pole.z);
  assert.ok(Math.abs(length - 1) < 1e-12);
});

test('UTC datetime-local parsing handles leap days, rollovers, and range limits', () => {
  const leap = parseDateTimeInput('2000-02-29T12:34:56', 'utc');
  assert.equal(new Date(leap).toISOString(), '2000-02-29T12:34:56.000Z');
  assert.equal(formatDateTimeInput(new Date(leap), 'utc'), '2000-02-29T12:34:56');
  assert.throws(() => parseDateTimeInput('2023-02-29T00:00:00', 'utc'), /not valid/);
  assert.throws(() => parseDateTimeInput('2100-12-31T23:59:60', 'utc'), /not valid/);
  assert.throws(() => parseDateTimeInput('1899-12-31T23:59:59', 'utc'), /Supported range/);
  assert.throws(() => parseDateTimeInput('2101-01-01T00:00:00', 'utc'), /Supported range/);
  assert.throws(() => parseDateTimeInput('not a date', 'utc'), /complete date/);
});

test('local datetime-local values round-trip through the browser time zone', () => {
  const instant = new Date(2024, 6, 14, 9, 8, 7, 0).getTime();
  const localValue = formatDateTimeInput(new Date(instant), 'local');
  assert.equal(parseDateTimeInput(localValue, 'local'), instant);
  const boundary = new Date(2025, 0, 1, 0, 0, 0, 0).getTime();
  assert.equal(parseDateTimeInput(formatDateTimeInput(new Date(boundary), 'local'), 'local'), boundary);
  assert.equal(DAY_MS, 86_400_000);
});
