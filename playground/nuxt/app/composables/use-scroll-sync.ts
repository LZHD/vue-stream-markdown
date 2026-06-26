import type { MaybeRefOrGetter } from 'vue'
import type { Editor } from '../types'
import type { SourceBlock } from './source-blocks'
import { clamp } from '../utils'
import { createSourceBlockCache } from './source-blocks'

// Scroll sync between the editor and the preview.
//
// Uses block-based mapping (instead of a plain pixel ratio) to stay accurate when the two
// sides differ greatly in content size:
//   1. split the source document into logical blocks on blank lines
//   2. extract the matching block-level elements from the preview DOM
//   3. map the two sides by proportional index
//   4. align to the corresponding block on scroll
export function useScrollSync(
  editorRef: MaybeRefOrGetter<Editor | null | undefined>,
  previewRef: MaybeRefOrGetter<HTMLElement | null | undefined>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  // Directional suppression: a programmatic scroll only needs to absorb the echo scroll
  // event from the OTHER side, not freeze the side the user is driving.
  //   - suppressEditor: ignore the editor echo caused by a preview -> editor sync
  //   - suppressPreview: ignore the preview echo caused by an editor -> preview sync
  // Each is released via double rAF: Monaco's onDidScrollChange fires synchronously inside
  // setScrollTop while the DOM scroll event fires asynchronously, so double rAF covers both
  // and self-recovers (it does not rely on an echo actually firing). Since each handler only
  // scrolls the OTHER side and never itself, there is no back-edge and no loop; meanwhile the
  // driving side's continuous scroll events are no longer dropped, so the other side follows
  // smoothly at 60fps.
  let suppressEditor = false
  let suppressPreview = false

  function syncPreviewTo(preview: HTMLElement, top: number) {
    suppressPreview = true
    preview.scrollTop = top
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressPreview = false
      })
    })
  }

  function syncEditorTo(editor: Editor, top: number) {
    suppressEditor = true
    editor.setScrollTop(top)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressEditor = false
      })
    })
  }

  // Source block parsing (cached by model version id)
  const sourceBlockCache = createSourceBlockCache()

  // Preview block extraction (Mutation/Resize observers + a version counter instead of an innerHTML cache key)
  let previewVersion = 0
  let cachedPreviewVersion = -1
  let cachedPreviewBlocks: HTMLElement[] = []
  let cachedPreviewOffsetTops: number[] = []
  let mutationObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null

  function setupObservers(preview: HTMLElement) {
    if (mutationObserver)
      return
    const output = preview.querySelector('.stream-markdown')
    if (!output)
      return
    // childList catches node add/remove; ResizeObserver catches reflows that change block
    // offsets without changing node structure (width changes, image/font/async chart renders),
    // so offsetTops never silently go stale.
    mutationObserver = new MutationObserver(() => {
      previewVersion++
    })
    mutationObserver.observe(output, { childList: true, subtree: true })
    resizeObserver = new ResizeObserver(() => {
      previewVersion++
    })
    resizeObserver.observe(output)
  }

  function teardownObservers() {
    mutationObserver?.disconnect()
    mutationObserver = null
    resizeObserver?.disconnect()
    resizeObserver = null
  }

  function getPreviewBlocks(preview: HTMLElement): { blocks: HTMLElement[], offsetTops: number[] } {
    // Lazy init: if .stream-markdown was not ready on the first watchEffect run, compensate here
    if (!mutationObserver)
      setupObservers(preview)

    if (cachedPreviewVersion === previewVersion)
      return { blocks: cachedPreviewBlocks, offsetTops: cachedPreviewOffsetTops }

    const output = preview.querySelector('.stream-markdown')
    if (!output) {
      cachedPreviewVersion = previewVersion
      cachedPreviewBlocks = []
      cachedPreviewOffsetTops = []
      return { blocks: [], offsetTops: [] }
    }

    const blocks: HTMLElement[] = []
    for (const child of output.children) {
      if (child.tagName === 'STYLE')
        continue
      blocks.push(child as HTMLElement)
    }

    // Batch-compute each block's offset relative to the preview container; only runs on content change (not per scroll)
    const previewRect = preview.getBoundingClientRect()
    const offsetTops = blocks.map(el =>
      el.getBoundingClientRect().top - previewRect.top + preview.scrollTop,
    )

    cachedPreviewVersion = previewVersion
    cachedPreviewBlocks = blocks
    cachedPreviewOffsetTops = offsetTops
    return { blocks, offsetTops }
  }

  // Mapping helpers

  // Binary search: the last block whose startLine <= lineNo (blocks are sorted by startLine ascending)
  function sourceBlockIndexForLine(sourceBlocks: SourceBlock[], lineNo: number): number {
    let lo = 0
    let hi = sourceBlocks.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (sourceBlocks[mid]!.startLine <= lineNo)
        lo = mid
      else
        hi = mid - 1
    }
    return lo
  }

  // Pixel top/bottom of a source block in the editor (bottom = next block's top; last block uses content height)
  function editorBlockBounds(editor: Editor, sourceBlocks: SourceBlock[], index: number): [number, number] {
    const top = editor.getTopForLineNumber(sourceBlocks[index]!.startLine)
    const next = sourceBlocks[index + 1]
    const bottom = next ? editor.getTopForLineNumber(next.startLine) : editor.getScrollHeight()
    return [top, bottom]
  }

  // Pixel top/bottom of a preview block in the preview container
  function previewBlockBounds(preview: HTMLElement, offsetTops: number[], index: number): [number, number] {
    const top = offsetTops[index]!
    const bottom = index + 1 < offsetTops.length ? offsetTops[index + 1]! : preview.scrollHeight
    return [top, bottom]
  }

  // Project a "continuous block coordinate" (source block index + in-block progress) onto the
  // target side's continuous block coordinate, returning target block index + in-block progress.
  // At a block boundary "block bottom = next block top", so the mapping is continuous across
  // blocks and monotonic throughout, eliminating the reverse jumps caused by Math.round quantization.
  function projectBlock(
    index: number,
    fraction: number,
    sourceTotal: number,
    targetTotal: number,
  ): [number, number] {
    if (targetTotal <= 1)
      return [0, 0]

    const sourceCoord = sourceTotal <= 1
      ? fraction * (targetTotal - 1)
      : (index + fraction) * ((targetTotal - 1) / (sourceTotal - 1))

    const coord = clamp(sourceCoord, 0, targetTotal - 1)
    const targetIndex = Math.min(Math.floor(coord), targetTotal - 1)
    return [targetIndex, coord - targetIndex]
  }

  // Editor -> preview
  function onEditorScroll() {
    if (suppressEditor || !toValue(enabled))
      return

    const editor = toValue(editorRef)
    const preview = toValue(previewRef)
    if (!editor || !preview)
      return

    const scrollTop = editor.getScrollTop()
    const scrollable = editor.getScrollHeight() - editor.getLayoutInfo().height
    if (scrollable <= 0)
      return

    const maxPreviewScrollTop = preview.scrollHeight - preview.clientHeight

    // Edge snap: force-align at the very top/bottom to avoid block-mapping drift
    if (scrollTop <= 0) {
      syncPreviewTo(preview, 0)
      return
    }
    if (scrollTop >= scrollable) {
      syncPreviewTo(preview, maxPreviewScrollTop)
      return
    }

    const model = editor.getModel()
    if (!model)
      return
    const sourceBlocks = sourceBlockCache.get(model)
    if (sourceBlocks.length === 0)
      return

    const visibleRange = editor.getVisibleRanges()[0]
    const lineNo = visibleRange?.startLineNumber ?? 1
    const srcIndex = sourceBlockIndexForLine(sourceBlocks, lineNo)

    const { blocks: previewBlocks, offsetTops: previewOffsetTops } = getPreviewBlocks(preview)
    if (previewBlocks.length === 0)
      return

    // In-block scroll progress within the current source block (0~1)
    const [srcTop, srcBottom] = editorBlockBounds(editor, sourceBlocks, srcIndex)
    const srcFraction = srcBottom > srcTop ? clamp((scrollTop - srcTop) / (srcBottom - srcTop), 0, 1) : 0

    // Continuous mapping to the preview side: locate the target block + interpolate in-block, monotonic with no jumps
    const [previewIndex, dstFraction] = projectBlock(srcIndex, srcFraction, sourceBlocks.length, previewBlocks.length)
    const [dstTop, dstBottom] = previewBlockBounds(preview, previewOffsetTops, previewIndex)
    const targetScrollTop = Math.min(dstTop + (dstBottom - dstTop) * dstFraction, maxPreviewScrollTop)

    syncPreviewTo(preview, targetScrollTop)
  }

  // Preview -> editor
  function onPreviewScroll() {
    if (suppressPreview || !toValue(enabled))
      return

    const editor = toValue(editorRef)
    const preview = toValue(previewRef)
    if (!editor || !preview)
      return

    const previewScrollable = preview.scrollHeight - preview.clientHeight
    if (previewScrollable <= 0)
      return

    const maxEditorScrollTop = editor.getScrollHeight() - editor.getLayoutInfo().height

    // Edge snap: force-align at the very top/bottom to avoid block-mapping drift
    if (preview.scrollTop <= 0) {
      syncEditorTo(editor, 0)
      return
    }
    if (preview.scrollTop >= previewScrollable) {
      syncEditorTo(editor, maxEditorScrollTop)
      return
    }

    const { blocks: previewBlocks, offsetTops: previewOffsetTops } = getPreviewBlocks(preview)
    if (previewBlocks.length === 0)
      return

    // Binary search: the last block with offsetTop <= scrollTop (the top-visible block), avoiding an O(n) forced layout
    const scrollTop = preview.scrollTop
    let lo = 0
    let hi = previewOffsetTops.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (previewOffsetTops[mid]! <= scrollTop)
        lo = mid
      else
        hi = mid - 1
    }
    const visibleBlockIndex = lo

    const model = editor.getModel()
    if (!model)
      return
    const sourceBlocks = sourceBlockCache.get(model)
    if (sourceBlocks.length === 0)
      return

    // In-block scroll progress within the preview block (0~1)
    const [pvTop, pvBottom] = previewBlockBounds(preview, previewOffsetTops, visibleBlockIndex)
    const pvFraction = pvBottom > pvTop ? clamp((scrollTop - pvTop) / (pvBottom - pvTop), 0, 1) : 0

    // Continuous mapping to the source side: locate the source block + interpolate in-block, monotonic with no jumps
    const [srcIndex, edFraction] = projectBlock(visibleBlockIndex, pvFraction, previewBlocks.length, sourceBlocks.length)
    const [edTop, edBottom] = editorBlockBounds(editor, sourceBlocks, srcIndex)
    const targetScrollTop = Math.min(edTop + (edBottom - edTop) * edFraction, maxEditorScrollTop)

    syncEditorTo(editor, targetScrollTop)
  }

  // Bind / unbind
  watchEffect((onCleanup) => {
    if (!toValue(enabled))
      return

    const editor = toValue(editorRef)
    const preview = toValue(previewRef)
    if (!editor || !preview)
      return

    setupObservers(preview)
    const scrollDisposable = editor.onDidScrollChange(onEditorScroll)
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })

    onCleanup(() => {
      scrollDisposable.dispose()
      preview.removeEventListener('scroll', onPreviewScroll)
      teardownObservers()
    })
  })
}
