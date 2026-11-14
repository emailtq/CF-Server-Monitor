import assert from 'node:assert/strict';
import path from 'node:path';

export async function nativeScrollbar({ page, out, report, PNG }, locator, axis, name) {
  report.geometry ||= []; report.screenshots ||= [];
  const horizontal = axis === 'x';
  const geometry = await locator.evaluate((element, horizontal) => {
    const root = element === document.documentElement, owner = root ? document.scrollingElement : element;
    owner[horizontal ? 'scrollLeft' : 'scrollTop'] = 0;
    const r = element.getBoundingClientRect(), length = horizontal ? owner.clientWidth : owner.clientHeight;
    const total = horizontal ? owner.scrollWidth : owner.scrollHeight;
    const gutter = root ? innerWidth - document.documentElement.clientWidth : horizontal ? owner.offsetHeight - owner.clientHeight - owner.clientTop * 2 : owner.offsetWidth - owner.clientWidth - owner.clientLeft * 2;
    const start = root ? 0 : horizontal ? r.left + owner.clientLeft : r.top + owner.clientTop;
    const cross = root ? document.documentElement.clientWidth : horizontal ? r.top + owner.clientTop + owner.clientHeight : r.left + owner.clientLeft + owner.clientWidth;
    return { horizontal, gutter, length, total, start, cross, middle: start + Math.max(20, length * length / total) / 2, dpr: devicePixelRatio, root, body: document.body.className, styles: [getComputedStyle(document.body, '::-webkit-scrollbar').width, getComputedStyle(document.documentElement, '::-webkit-scrollbar').width], hit: getComputedStyle(element).getPropertyValue('--admin-scrollbar-hit') };
  }, horizontal);
  report.geometry.push({ kind: 'native-scrollbar-start', name, ...geometry });
  assert.ok(geometry.total > geometry.length, `${name} must really overflow`);
  assert.equal(geometry.gutter, 8, `${name} preserves the 8px hit area without double gutter`);
  await page.mouse.move(0, 0); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const clip = horizontal ? { x: Math.round(geometry.middle), y: Math.round(geometry.cross) - 2, width: 1, height: 10 } : { x: Math.round(geometry.cross) - 2, y: Math.round(geometry.middle), width: 10, height: 1 };
  const shot = path.join(out, `${name}-paint.png`), png = PNG.sync.read(await page.screenshot({ path: shot, clip })); report.screenshots.push(shot);
  const columns = horizontal ? png.height : png.width, inset = Math.floor(2.5 * geometry.dpr) * (horizontal ? png.width : 1) * 4;
  const background = [...png.data.subarray(inset, inset + 3)];
  const contrast = Array.from({ length: columns }, (_, i) => {
    if (i < Math.round(2 * geometry.dpr) || i >= Math.floor(10 * geometry.dpr)) return 0;
    const at = (horizontal ? i * png.width : i) * 4;
    return Math.max(...background.map((value, c) => Math.abs(value - png.data[at + c])));
  });
  const painted = Array.from({ length: columns }, (_, i) => i).filter(i => {
    if (i < Math.round(2 * geometry.dpr) || i >= Math.floor(10 * geometry.dpr)) return false;
    const at = (horizontal ? i * png.width : i) * 4;
    return background.some((value, c) => Math.abs(value - png.data[at + c]) > 3);
  });
  const drag = [];
  report.geometry.push({ kind: 'native-drag-samples', name, drag });
  await page.evaluate(() => {
    window.nativeScrollbarEvents = [];
    if (!window.nativeScrollbarListening) {
      window.nativeScrollbarListening = true;
      for (const type of ['pointerdown', 'focusin', 'focusout', 'scroll', 'click']) document.addEventListener(type, event => window.nativeScrollbarEvents.push({ type, target: event.target?.className, related: event.relatedTarget?.className, active: document.activeElement?.className }), true);
    }
  });
  for (const offset of [1, 4, 7]) {
    await locator.evaluate((el, horizontal) => { el[horizontal ? 'scrollLeft' : 'scrollTop'] = 0; }, horizontal);
    const x = horizontal ? geometry.middle : geometry.cross + offset, y = horizontal ? geometry.cross + offset : geometry.middle;
    const sample = { offset, x, y, beforeHit: await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x, y }) }; drag.push(sample);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (horizontal ? Math.min(140, geometry.length * .4) : 0), y + (horizontal ? 0 : Math.min(140, geometry.length * .4)), { steps: 8 }); await page.mouse.up();
    sample.events = await page.evaluate(() => window.nativeScrollbarEvents.slice(-15));
    sample.moved = await locator.evaluate((el, horizontal) => el[horizontal ? 'scrollLeft' : 'scrollTop'], horizontal);
  }
  // Fractional DPR creates partial edge pixels; retain support and contrast-weighted paint separately.
  const paintedCss = contrast.reduce((sum, value) => sum + value / Math.max(...contrast), 0) / geometry.dpr;
  report.geometry.push({ kind: 'native-scrollbar', name, ...geometry, paintedPhysical: painted.length, supportCss: painted.length / geometry.dpr, paintedCss, contrast, drag });
  assert.ok(Math.abs(paintedCss - 3) <= .55, `${name} contrast-weighted actual paint ${paintedCss}`);
  if (geometry.dpr === 1) assert.equal(painted.length, 3, 'DPR1 must actually paint three physical columns');
  assert.ok(drag.every(sample => sample.moved > 0), `${name} center and both unpainted edges drag: ${JSON.stringify(drag)}`);
}
