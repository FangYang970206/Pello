import assert from 'node:assert/strict'

export async function assertSettingsDialogPosition(dialog) {
  await dialog.waitFor()
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const geometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const area = document.querySelector('.scontent').getBoundingClientRect()
    const column = document.querySelector('.scol').getBoundingClientRect()
    const footer = element.querySelector('footer').getBoundingClientRect()
    const body = element.querySelector('.bdy')
    return {
      offsetX: box.x + box.width / 2 - column.x - column.width / 2,
      offsetY: box.y + box.height / 2 - area.y - area.height / 2,
      withinColumn: box.left >= column.left - 1 && box.right <= column.right + 1,
      viewportPadding: box.top - area.top >= 23 && area.bottom - box.bottom >= 23,
      footerVisible: footer.bottom <= box.bottom + 1,
      bodyVisible: body.clientHeight > 100,
      bodyFits: body.scrollWidth <= body.clientWidth + 1
    }
  })
  assert.ok(Math.abs(geometry.offsetX) < 2 && Math.abs(geometry.offsetY) < 2, JSON.stringify(geometry))
  assert.ok(geometry.withinColumn && geometry.viewportPadding && geometry.footerVisible && geometry.bodyVisible && geometry.bodyFits, JSON.stringify(geometry))
}
