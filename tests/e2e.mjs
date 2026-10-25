/**
 * End-to-end verification in a real Chromium browser.
 *
 * The test starts its own zero-dependency HTTP server. It can launch Chrome
 * through Playwright, or attach to a Chrome already exposing CDP on 9222
 * (needed in environments that forbid Playwright's spawn pipes).
 *
 * Usage:
 *   npm start                 # optional; tests use their own server
 *   npm run test:e2e
 *   CDP_URL=http://127.0.0.1:9222 npm run test:e2e
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createOrreryServer, listen } from '../scripts/server.mjs';

const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const summary = [];

function record(message) {
  summary.push(message);
  console.log(`✓ ${message}`);
}

async function openBrowser() {
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  try {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 3500 });
    const context = browser.contexts()[0] || await browser.newContext();
    return { browser, context, managed: false, page: await context.newPage() };
  } catch (error) {
    const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!executablePath) {
      throw new Error(
        `Could not attach to Chrome at ${cdpUrl}, and no Chrome/Edge executable was found. `
        + 'Set CHROME_PATH or CDP_URL. Original error: ' + error.message,
      );
    }
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    });
    const context = await browser.newContext();
    return { browser, context, managed: true, page: await context.newPage() };
  }
}

async function readState(page) {
  return page.evaluate(() => window.__orrery.getState());
}

async function settle(page, ms = 1100) {
  await page.waitForTimeout(ms);
}

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  const server = createOrreryServer();
  const info = await listen(server, 0, '127.0.0.1');
  const { browser, page, managed } = await openBrowser();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(info.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__orreryReady === true, null, { timeout: 30000 });
    await page.waitForTimeout(800);

    assert.equal(await page.locator('#fatal-error').isHidden(), true, 'fatal panel must stay hidden');
    assert.equal(await page.locator('#loading').isHidden(), true, 'loading overlay must clear');
    assert.equal(await page.locator('#scene-root canvas').count(), 1, 'WebGL canvas must exist');
    assert.ok(await page.evaluate(() => document.querySelector('#scene-root canvas').width > 100), 'canvas should have pixels');
    assert.equal(await page.locator('.body-label').count(), 10, 'all ten body markers should exist');
    record('loads with no fatal panel and renders a WebGL canvas');

    let state = await readState(page);
    assert.equal(state.playing, true);
    assert.equal(state.speed, 1);
    assert.equal(state.direction, 1);
    assert.equal(state.selectedId, 'earth');
    assert.equal(state.presetName, 'system');
    assert.ok(Math.abs(state.simMs - Date.now()) < 8000, 'initial instant should be the computer’s current time');
    assert.match(state.utcIso, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(await page.locator('#clockTime').textContent(), /\d{2}:\d{2}:\d{2}/);
    assert.match(await page.locator('#clockUtc').textContent(), /UTC/);
    record('starts at the computer’s current time with real-time playback and a visible active timestamp');
    await page.screenshot({ path: `${ARTIFACTS}desktop-home.png` });

    // Time-zone control and explicit labels.
    await page.click('#timezoneUtc');
    await page.waitForTimeout(250);
    state = await readState(page);
    assert.equal(state.timezoneMode, 'utc');
    assert.match(await page.locator('#timezoneLabel').textContent(), /UTC/);
    assert.match(await page.locator('#clockZoneLabel').textContent(), /UTC/);
    const utcInput = await page.inputValue('#dateTimeInput');
    assert.match(utcInput, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.ok(
      Math.abs(Date.parse(`${utcInput}Z`) - state.simMs) < 3000,
      'UTC input should reflect the active instant within clock-tick tolerance',
    );
    record('exposes Local/UTC entry and shows the UTC-equivalent input value');

    // Leap day through the real date control.
    await page.evaluate(() => {
      const input = document.getElementById('dateTimeInput');
      input.value = '2000-02-29T12:00:00';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    state = await readState(page);
    assert.equal(state.utcIso, '2000-02-29T12:00:00.000Z');
    assert.equal(state.playing, false, 'manual date edits should pause');
    assert.match(await page.inputValue('#dateTimeInput'), /^2000-02-29T12:00(?::00)?$/);
    assert.match(await page.locator('#clockDate').textContent(), /2000/);
    record('accepts and displays leap day 2000-02-29 through the date picker');

    // Now returns to current time, real-time, forward.
    await page.click('#nowButton');
    await page.waitForTimeout(350);
    state = await readState(page);
    assert.equal(state.playing, true);
    assert.equal(state.speed, 1);
    assert.equal(state.direction, 1);
    assert.ok(Math.abs(state.simMs - Date.now()) < 8000, 'Now should return to the current instant');
    record('Now returns to the current instant, forward real-time playback, and 1× rate');

    // Reverse and forward playback, pause, and speed selection.
    const beforeReverse = (await readState(page)).simMs;
    await page.click('#reverseBtn');
    await page.waitForTimeout(450);
    let afterReverse = await readState(page);
    assert.equal(afterReverse.playing, true);
    assert.equal(afterReverse.direction, -1);
    assert.ok(afterReverse.simMs < beforeReverse, 'reverse playback should decrease simulation time');
    await page.click('#playBtn');
    await page.waitForTimeout(100);
    state = await readState(page);
    assert.equal(state.playing, false);
    await page.selectOption('#speedSelect', '86400');
    await page.click('#forwardBtn');
    await page.waitForTimeout(400);
    state = await readState(page);
    assert.equal(state.playing, true);
    assert.equal(state.direction, 1);
    assert.equal(state.speed, 86400);
    assert.match(await page.locator('#playbackStatus').textContent(), /1 day \/ sec/);
    await page.click('#playBtn');
    record('plays forward and backward, pauses, and switches to labelled fast rates');
    await page.click('#nowButton');
    await page.waitForTimeout(200);

    const speedOptions = await page.$$eval('#speedSelect option', (options) => options.map((option) => option.textContent));
    assert.deepEqual(speedOptions, ['Real time', '1 min / sec', '1 hour / sec', '1 day / sec', '1 week / sec', '30 days / sec', '1 year / sec']);
    record('offers the full labelled range from real time to one year per second');

    // All camera presets.
    await page.click('#presetInner');
    await settle(page);
    state = await readState(page);
    const innerDistance = state.scene.camera.distance;
    assert.equal(state.presetName, 'inner');
    assert.equal(state.focusedId, null);
    assert.equal(await page.locator('#presetInner').getAttribute('aria-pressed'), 'true');
    await page.click('#presetSystem');
    await settle(page);
    state = await readState(page);
    const systemDistance = state.scene.camera.distance;
    assert.equal(state.presetName, 'system');
    assert.ok(systemDistance > innerDistance * 5, 'entire-system view should be much wider');
    await page.click('#presetInner');
    await settle(page);
    await page.click('#resetView');
    await settle(page);
    state = await readState(page);
    assert.equal(state.presetName, 'system');
    assert.ok(state.scene.camera.distance > innerDistance * 5);
    record('Entire system, Inner planets, and Reset view all move the camera correctly');

    // Wheel zoom, drag rotation, and right-drag panning.
    let before = await readState(page);
    const canvasBox = await page.locator('#scene-root canvas').boundingBox();
    const cx = canvasBox.x + canvasBox.width * 0.48;
    const cy = canvasBox.y + canvasBox.height * 0.46;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -420);
    await page.waitForTimeout(500);
    let after = await readState(page);
    assert.ok(after.scene.camera.distance < before.scene.camera.distance * 0.997, 'wheel should dolly in');

    await page.evaluate(() => window.__orrery.resetView());
    await settle(page);
    before = await readState(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 42, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    after = await readState(page);
    assert.ok(
      Math.hypot(
        after.scene.camera.x - before.scene.camera.x,
        after.scene.camera.y - before.scene.camera.y,
        after.scene.camera.z - before.scene.camera.z,
      ) > 1,
      'left drag should rotate the camera',
    );

    await page.evaluate(() => window.__orrery.resetView());
    await settle(page);
    before = await readState(page);
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 65, cy + 25, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(400);
    after = await readState(page);
    assert.ok(
      Math.hypot(
        after.scene.target.x - before.scene.target.x,
        after.scene.target.y - before.scene.target.y,
        after.scene.target.z - before.scene.target.z,
      ) > 0.01,
      'right drag should pan the camera target',
    );
    await page.evaluate(() => window.__orrery.resetView());
    await settle(page);
    record('wheel zoom, drag-to-rotate, and right-drag pan all operate smoothly');

    // Mercury close-up and selection.
    await page.locator('.body-item[data-body-id="mercury"]').click();
    await settle(page);
    state = await readState(page);
    assert.equal(state.selectedId, 'mercury');
    assert.equal(state.focusedId, 'mercury');
    assert.ok(state.scene.camera.distance < 0.1, 'Mercury should be close-up');
    assert.ok(state.scene.camera.near < 0.01, 'near plane should adapt for close inspection');
    const mercuryGap = Math.hypot(
      state.scene.target.x - state.scene.focusPosition.x,
      state.scene.target.y - state.scene.focusPosition.y,
      state.scene.target.z - state.scene.focusPosition.z,
    );
    assert.ok(mercuryGap < 1e-6, 'camera target should be the focused planet');
    assert.match(await page.locator('#infoName').textContent(), /Mercury/);
    await page.screenshot({ path: `${ARTIFACTS}desktop-mercury.png` });
    record('selecting Mercury focuses the camera with an adaptive near plane and live details');

    // Tracking through playback.
    const distanceBefore = state.scene.camera.distance;
    await page.waitForTimeout(700);
    state = await readState(page);
    const gapDuringPlayback = Math.hypot(
      state.scene.target.x - state.scene.focusPosition.x,
      state.scene.target.y - state.scene.focusPosition.y,
      state.scene.target.z - state.scene.focusPosition.z,
    );
    assert.ok(gapDuringPlayback < 1e-5, 'Mercury target should remain tracked while time advances');
    assert.ok(Math.abs(state.scene.camera.distance - distanceBefore) / distanceBefore < 0.02);
    assert.deepEqual(state.focusedId, 'mercury');
    record('focused Mercury stays tracked and keeps its camera distance during playback');

    // Date jump while focused.
    await page.evaluate(() => window.__orrery.setTime('2035-07-04T12:00:00Z'));
    await page.waitForTimeout(350);
    state = await readState(page);
    const gapAfterJump = Math.hypot(
      state.scene.target.x - state.scene.focusPosition.x,
      state.scene.target.y - state.scene.focusPosition.y,
      state.scene.target.z - state.scene.focusPosition.z,
    );
    assert.ok(gapAfterJump < 1e-5, 'camera should translate with the focused body after a date jump');
    assert.ok(Math.abs(state.scene.camera.distance - distanceBefore) / distanceBefore < 0.02);
    record('focused camera remains attached across a multi-year date jump');

    // Neptune close-up.
    await page.locator('.body-item[data-body-id="neptune"]').click();
    await settle(page);
    state = await readState(page);
    assert.equal(state.selectedId, 'neptune');
    assert.equal(state.focusedId, 'neptune');
    assert.ok(state.scene.camera.distance < 0.5);
    assert.match(await page.locator('#infoName').textContent(), /Neptune/);
    assert.equal(await page.locator('#infoDistance').textContent(), state.snapshot.positions.neptune.distanceAu.toFixed(6));
    await page.screenshot({ path: `${ARTIFACTS}desktop-neptune.png` });
    record('selecting Neptune focuses and displays its calculated distance and reference facts');

    // Focused Earth, then determinism and range behaviour.
    await page.locator('.body-item[data-body-id="earth"]').click();
    await settle(page);
    await page.evaluate(() => window.__orrery.setTime('1900-01-01T00:00:00Z'));
    await page.waitForTimeout(250);
    state = await readState(page);
    assert.equal(state.utcIso, '1900-01-01T00:00:00.000Z');
    await page.evaluate(() => window.__orrery.setTime('2100-12-31T23:59:59Z'));
    await page.waitForTimeout(250);
    state = await readState(page);
    assert.equal(state.utcIso, '2100-12-31T23:59:59.000Z');
    record('accepts both supported date boundaries and keeps the focused Earth attached');

    const fixedIso = '2028-03-01T00:00:00Z';
    const firstPosition = await page.evaluate((iso) => window.__orrery.positionAt('mars', iso), fixedIso);
    await page.evaluate(() => {
      window.__orrery.setTime('1999-12-31T23:59:59Z');
      window.__orrery.setDirection(1);
      window.__orrery.setSpeed(31557600);
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__orrery.pause());
    await page.evaluate((iso) => window.__orrery.setTime(iso), fixedIso);
    await page.waitForTimeout(200);
    const repeated = await page.evaluate((iso) => window.__orrery.positionAt('mars', iso), fixedIso);
    assert.deepEqual(repeated, firstPosition, 'positions must not depend on playback history');
    state = await readState(page);
    assert.equal(state.snapshot.positions.mars.x, firstPosition.x);
    assert.equal(state.snapshot.positions.mars.y, firstPosition.y);
    assert.equal(state.snapshot.positions.mars.z, firstPosition.z);
    record('positions depend only on the requested instant, independent of playback history');

    // Toggles expose actual scene object visibility.
    await page.click('#toggleOrbits');
    await page.waitForTimeout(100);
    assert.equal((await readState(page)).toggles.orbits, false);
    assert.equal(await page.evaluate(() => window.__orrery.scene().orbitGroup.visible), false);
    await page.click('#toggleLabels');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.getElementById('marker-layer').classList.contains('labels-off')), true);
    await page.click('#toggleGrid');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__orrery.scene().gridGroup.visible), true);
    await page.click('#toggleOrbits');
    await page.click('#toggleLabels');
    await page.click('#toggleGrid');
    record('orbit, label, and grid toggles change both state and rendered layer visibility');

    // Timeline scrubber pauses and seeks.
    const midRange = await page.evaluate(() => {
      const slider = document.getElementById('timeSlider');
      const value = Number(slider.max) * 0.5;
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return value;
    });
    await page.waitForTimeout(200);
    state = await readState(page);
    assert.equal(state.playing, false);
    const midYear = new Date(state.simMs).getUTCFullYear();
    assert.ok(midYear >= 1999 && midYear <= 2001, `timeline midpoint should be near 2000, got ${midYear}`);
    assert.ok(midRange > 0);
    record('timeline scrubber seeks to the requested instant and pauses playback');

    // Narrow-screen layout and details sheet.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__orrery.preset('system'));
    await settle(page);
    const mobileMetrics = await page.evaluate(() => {
      const rect = (id) => {
        const box = document.getElementById(id).getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        console: rect('time-console'),
        inspector: rect('inspector'),
        reset: rect('resetView'),
        rail: rect('body-list'),
        resetVisible: getComputedStyle(document.getElementById('resetView')).display !== 'none',
      };
    });
    assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.viewport.width, 'no horizontal overflow');
    assert.equal(mobileMetrics.resetVisible, true, 'Reset view must remain available on narrow screens');
    assert.ok(mobileMetrics.inspector.bottom <= mobileMetrics.console.top + 1, 'details and time controls must not overlap');
    assert.ok(mobileMetrics.console.left >= 0 && mobileMetrics.console.right <= mobileMetrics.viewport.width + 1);
    await page.screenshot({ path: `${ARTIFACTS}mobile-home.png` });

    await page.click('#inspectorToggle');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#inspectorToggle').getAttribute('aria-expanded'), 'true');
    assert.ok((await page.locator('#inspector').boundingBox()).height > 100);
    await page.screenshot({ path: `${ARTIFACTS}mobile-details.png` });
    await page.click('#inspectorToggle');
    await page.locator('.body-item[data-body-id="venus"]').click();
    await settle(page);
    state = await readState(page);
    assert.equal(state.selectedId, 'venus');
    assert.equal(state.focusedId, 'venus');
    await page.click('#aboutButton');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#aboutDialog').evaluate((dialog) => dialog.open), true);
    const dialogBox = await page.locator('#aboutDialog').boundingBox();
    assert.ok(dialogBox.width <= 390 && dialogBox.height <= 844);
    await page.screenshot({ path: `${ARTIFACTS}mobile-about.png` });
    await page.click('#aboutClose');
    record('narrow-screen layout has no overflow, keeps Reset view, avoids panel overlap, and opens usable details/About sheets');

    // Short landscape layout: controls remain distinct and usable.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.__orrery.preset('system'));
    await settle(page);
    const landscape = await page.evaluate(() => {
      const rect = (id) => {
        const box = document.getElementById(id).getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
      };
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        console: rect('time-console'),
        inspector: rect('inspector'),
        reset: rect('resetView'),
      };
    });
    assert.ok(landscape.scrollWidth <= landscape.width);
    assert.ok(landscape.inspector.bottom <= landscape.console.top, 'landscape details and console must not overlap');
    assert.ok(landscape.console.height < 140, 'landscape console should be compact');
    assert.ok(landscape.reset.height > 0, 'Reset view should remain visible in landscape');
    await page.screenshot({ path: `${ARTIFACTS}landscape-home.png` });
    record('short landscape layout keeps scene space and all controls without overlap');

    // Return to desktop for a final sanity screenshot.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.__orrery.now());
    await page.evaluate(() => window.__orrery.preset('system'));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${ARTIFACTS}desktop-final.png` });

    assert.deepEqual(failedRequests, [], 'all resources must load successfully');
    assert.deepEqual(errors, [], 'no browser console errors or uncaught exceptions');
    record('no failed network resources, console errors, or uncaught page exceptions');

    console.log('\nE2E SUMMARY');
    for (const line of summary) console.log(`  ${line}`);
    console.log(`\nScreenshots: ${ARTIFACTS}`);
    console.log('All end-to-end checks passed.');
  } finally {
    await Promise.race([page.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (managed) {
      await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('\nE2E FAILURE');
  console.error(error.stack || error);
  process.exit(1);
});
