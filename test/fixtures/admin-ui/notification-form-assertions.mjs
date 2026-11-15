import assert from 'node:assert/strict';
import { providers } from '../../../src/frontend/views/admin/composables/notificationPresentation.js';

export async function chooseProvider(dialog, type) {
  await dialog.locator('.admin-toolbar-group-trigger').click();
  await dialog.getByRole('option').nth(providers.indexOf(type)).click();
  await dialog.locator('.admin-toolbar-group-menu').waitFor({ state: 'hidden' });
}

export async function assertNotificationLabelsVisible(dialog, labels) {
  assert.equal(await dialog.locator('.admin-wizard-steps, [data-action=next], [data-action=back]').count(), 0);
  const geometry = [];
  for (const [index, selector] of ['.admin-notification-provider > span', '.admin-notification-name', '.admin-notification-template', '.admin-form-group-heading'].entries()) {
    const label = index === 3 ? dialog.locator(selector).last() : dialog.locator(selector);
    await label.scrollIntoViewIfNeeded();
    const value = await label.evaluate(element => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
      const body = element.closest('.admin-dialog-body'), port = body.closest('.admin-dialog-scroll');
      const rects = [], text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      for (const node of text) { const range = document.createRange(); range.selectNodeContents(node); rects.push(...[...range.getClientRects()].map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom }))); }
      return { text: text.map(node => node.textContent).join('').trim(), rects, clip: box(port) };
    });
    assert.equal(value.text, labels[index]);
    assert.ok(value.rects.length);
    for (const rect of value.rects) assert.ok(rect.x >= value.clip.x - 1 && rect.right <= value.clip.right + 1 && rect.y >= value.clip.y - 1 && rect.bottom <= value.clip.bottom + 1, `localized label ${labels[index]} extends beyond the scrollport`);
    geometry.push(value);
  }
  return geometry;
}
