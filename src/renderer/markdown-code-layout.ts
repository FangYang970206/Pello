/** Keep lazy code-block teardown from changing the height above the viewport. */
export function preserveCodeLayout(root: HTMLElement): () => void {
  const observed = new WeakSet<Element>()
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const block = entry.target as HTMLElement
      if (block.querySelector(':scope > .milkdown-code-block-placeholder,.diagram-preview[data-loading=true]')) continue
      const height = entry.borderBoxSize[0]?.blockSize
      if (height > 0) block.style.setProperty('--pello-code-height', `${height}px`)
    }
  })
  const observe = (node: Node) => {
    if (!(node instanceof HTMLElement)) return
    const blocks = node.matches('.milkdown-code-block') ? [node] : [...node.querySelectorAll<HTMLElement>('.milkdown-code-block')]
    for (const block of blocks) if (!observed.has(block)) { observed.add(block); sizes.observe(block) }
  }
  const changes = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach(observe)
      for (const node of record.removedNodes) if (node instanceof HTMLElement) {
        const blocks = node.matches('.milkdown-code-block') ? [node] : [...node.querySelectorAll('.milkdown-code-block')]
        for (const block of blocks) if (!root.contains(block)) { sizes.unobserve(block); observed.delete(block) }
      }
    }
  })
  observe(root)
  changes.observe(root, { childList: true, subtree: true })
  return () => { changes.disconnect(); sizes.disconnect() }
}
