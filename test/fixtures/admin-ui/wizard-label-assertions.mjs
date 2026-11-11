import assert from 'node:assert/strict';

export async function assertWizardLabelsVisible(dialog, step, labels) {
  const list = dialog.locator('.admin-wizard-steps');
  // Measure at the legitimate top position, not after the user scrolls to footer actions.
  await list.scrollIntoViewIfNeeded();
  const geometry = await list.evaluate(list => {
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const body = list.closest('.admin-dialog-body');
    return { clip: box(body), labels: [...list.children].map(item => {
      const marker = item.firstElementChild, walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT), rects = [];
      let text, label = '';
      while ((text = walker.nextNode())) {
        if (marker.contains(text) || !text.textContent.trim()) continue;
        label += text.textContent;
        const range = document.createRange(); range.selectNodeContents(text);
        rects.push(...[...range.getClientRects()].filter(r => r.width && r.height).map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
      }
      return { text: label.trim(), number: marker.textContent.trim(), active: item.getAttribute('aria-current'), marker: box(marker), item: box(item), rects };
    }) };
  });
  assert.equal(geometry.labels.length, 3);
  const overlaps = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  for (const [index, label] of geometry.labels.entries()) {
    assert.equal(label.number, String(index + 1)); assert.equal(label.text, labels[index]);
    assert.equal(label.active, index === step ? 'step' : null);
    assert.ok(label.rects.length, 'each wizard label must have real nonempty glyph ranges');
    for (const rect of [label.marker, ...label.rects]) {
      assert.ok(rect.x >= geometry.clip.x - 1 && rect.right <= geometry.clip.right + 1 && rect.y >= geometry.clip.y - 1 && rect.bottom <= geometry.clip.bottom + 1, `wizard label ${index + 1} glyphs extend beyond the real body clipping edge`);
    }
    assert.ok(label.rects.every(rect => !overlaps(rect, label.marker)), 'label glyphs overlap their marker');
    for (const other of geometry.labels.slice(index + 1)) assert.equal(overlaps(label.item, other.item), false, 'neighboring step items overlap');
  }
  return geometry;
}
