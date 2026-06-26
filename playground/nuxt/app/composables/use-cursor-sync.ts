import type { MaybeRefOrGetter } from 'vue'
import type { Editor } from '../types'
import type { EditorModel, SourceBlock } from './source-blocks'
import { clamp } from '../utils'
import { createSourceBlockCache } from './source-blocks'

const WHITESPACE_RE = /\s+/g
const LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+\.)\s+/
const QUOTE_MARKER_RE = /^\s*>+\s?/
const HEADING_MARKER_RE = /^\s*#{1,6}\s+/
const INLINE_MARK_RE = /[*_`~]/g
const TRAILING_HASH_RE = /#+\s*$/
const HEADING_TAG_RE = /^h[1-6]$/
const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,img'

function normalizeText(text: string): string {
  return text.replace(WHITESPACE_RE, ' ').trim()
}

// Strip common Markdown markers so a source line can be compared against the rendered textContent
function stripMarkdown(line: string): string {
  return line
    .replace(LINK_RE, '$1') // links / images -> text
    .replace(LIST_MARKER_RE, '') // list markers
    .replace(QUOTE_MARKER_RE, '') // blockquote markers
    .replace(HEADING_MARKER_RE, '') // ATX heading markers
    .replace(INLINE_MARK_RE, '') // inline emphasis / code / strikethrough
}

function parseHeadingLine(line: string): { level: number, title: string } | null {
  if (!line.startsWith('#'))
    return null

  let level = 0
  while (level < line.length && line.charAt(level) === '#' && level < 6)
    level++

  if (level === 0 || line.charAt(level) !== ' ')
    return null

  const title = normalizeText(line.slice(level + 1).replace(TRAILING_HASH_RE, ''))
  if (!title)
    return null

  return { level, title }
}

// Preview block index -> expected source block index (proportional mapping)
function projectIndex(previewIndex: number, previewTotal: number, sourceTotal: number): number {
  if (sourceTotal <= 0)
    return 0
  const index = previewTotal <= 1
    ? 0
    : Math.round(previewIndex * (sourceTotal - 1) / (previewTotal - 1))
  return clamp(index, 0, sourceTotal - 1)
}

// Click a preview element to locate the corresponding position back in the editor.
//
// Hybrid strategy:
//   1. Content match first - search the source for the rendered text to find the real position
//      (headings match precisely by level + title; other blocks match by normalized text per block). High precision.
//   2. Proportional fallback - when nothing matches (formulas, marker-heavy inline text, duplicate text),
//      fall back to a preview-index -> source-index proportional mapping, so a click always gets a response.
//
// Duplicate-text disambiguation: when the same text matches multiple source blocks, pick the one
// nearest to the "expected block" inferred from the click position, using spatial location to
// disambiguate instead of always jumping to the first occurrence.
//
// Granularity matches use-scroll-sync: the preview DOM carries no source-position metadata, so
// character-level precision is impossible - headings resolve to a specific line, other blocks
// resolve to their source block's start line.
export function useCursorSync(
  editorRef: MaybeRefOrGetter<Editor | null | undefined>,
  previewRef: MaybeRefOrGetter<HTMLElement | null | undefined>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  // Source block parsing (shared with use-scroll-sync, cached by model version id)
  const sourceBlockCache = createSourceBlockCache()

  // Cache of the normalized source-block text (markers stripped + whitespace collapsed), also keyed
  // by the model version id, so a click does not re-read the whole document and each block's text is
  // computed only once across the multi-candidate comparison.
  let cachedTextVersion = -1
  let cachedBlockTexts: string[] = []

  function getBlockTexts(model: EditorModel, sourceBlocks: SourceBlock[]): string[] {
    const version = model.getVersionId()
    if (version === cachedTextVersion)
      return cachedBlockTexts

    cachedTextVersion = version
    cachedBlockTexts = sourceBlocks.map((block) => {
      const parts: string[] = []
      for (let i = block.startLine; i <= block.endLine; i++)
        parts.push(stripMarkdown(model.getLineContent(i)))
      return normalizeText(parts.join(' '))
    })
    return cachedBlockTexts
  }

  // Content match (precise, with nearest-position disambiguation)
  function matchHeading(
    model: EditorModel,
    sourceBlocks: SourceBlock[],
    el: HTMLElement,
    expectedIndex: number,
  ): SourceBlock | null {
    const level = Number(el.tagName.charAt(1))
    const title = normalizeText(el.textContent ?? '')
    if (!title)
      return null

    let best: SourceBlock | null = null
    let bestDist = Number.POSITIVE_INFINITY

    for (let i = 0; i < sourceBlocks.length; i++) {
      const block = sourceBlocks[i]!
      for (let line = block.startLine; line <= block.endLine; line++) {
        const parsed = parseHeadingLine(model.getLineContent(line))
        if (!parsed || parsed.level !== level)
          continue
        if (parsed.title === title || parsed.title.includes(title) || title.includes(parsed.title)) {
          const dist = Math.abs(i - expectedIndex)
          if (dist < bestDist) {
            bestDist = dist
            best = { startLine: line, endLine: line }
            if (dist === 0)
              return best // cannot get nearer than the expected block
          }
          break // one hit per block is enough
        }
      }
    }
    return best
  }

  function matchText(texts: string[], rawText: string, expectedIndex: number): number {
    const target = normalizeText(rawText)
    if (target.length < 6)
      return -1

    // Progressively shortened candidates to raise the hit rate (handles wrapping / marker-heavy
    // inline differences); deduped to avoid redundant comparisons
    const candidates = [...new Set(
      [target, target.slice(0, 80), target.slice(0, 40), target.slice(0, 20)]
        .filter(item => item.length >= 6),
    )]

    for (const candidate of candidates) {
      let best = -1
      let bestDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]
        if (!text)
          continue
        if (text.includes(candidate) || (candidate.length > text.length && text.length >= 6 && candidate.includes(text))) {
          const dist = Math.abs(i - expectedIndex)
          if (dist < bestDist) {
            bestDist = dist
            best = i
            if (dist === 0)
              break // cannot get nearer than the expected block
          }
        }
      }
      if (best >= 0)
        return best
    }
    return -1
  }

  function matchContent(
    model: EditorModel,
    sourceBlocks: SourceBlock[],
    el: HTMLElement,
    expectedIndex: number,
  ): SourceBlock | null {
    const tag = el.tagName.toLowerCase()

    if (HEADING_TAG_RE.test(tag))
      return matchHeading(model, sourceBlocks, el, expectedIndex)

    const rawText = tag === 'img' ? ((el as HTMLImageElement).alt ?? '') : (el.textContent ?? '')
    const texts = getBlockTexts(model, sourceBlocks)
    const index = matchText(texts, rawText, expectedIndex)
    return index >= 0 ? sourceBlocks[index]! : null
  }

  // Locate the top-level preview block of the click target (shared by disambiguation and fallback)
  function locatePreviewBlock(preview: HTMLElement, target: HTMLElement): { index: number, total: number } | null {
    const root = preview.querySelector('.stream-markdown')
    if (!root)
      return null

    // Climb from the click target up to the direct child of .stream-markdown (the top-level preview block)
    let el: HTMLElement | null = target
    while (el && el.parentElement !== root)
      el = el.parentElement
    if (!el)
      return null

    const children = Array.from(root.children).filter(child => child.tagName !== 'STYLE')
    const index = children.indexOf(el)
    if (index < 0)
      return null

    return { index, total: children.length }
  }

  // Perform the jump: place a collapsed cursor at the block start (not a range selection, so a
  // following keystroke cannot overwrite the block), reveal it, and focus the editor.
  //
  // Known interaction: when the target line is off-screen, the reveal scrolls the editor, which
  // use-scroll-sync then mirrors by re-aligning the preview (the clicked element may shift). This is
  // minimized by using revealLineInCenterIfOutsideViewport - if the line is already visible, the
  // editor does not scroll and the preview stays put.
  function jumpTo(editor: Editor, range: SourceBlock) {
    editor.setPosition({ lineNumber: range.startLine, column: 1 })
    editor.revealLineInCenterIfOutsideViewport(range.startLine)
    editor.focus()
  }

  function onPreviewClick(event: MouseEvent) {
    if (!toValue(enabled))
      return

    // Ignore clicks that conclude a text selection (drag-to-copy) so we do not steal focus
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed)
      return

    const editor = toValue(editorRef)
    const preview = toValue(previewRef)
    if (!editor || !preview)
      return

    const model = editor.getModel()
    if (!model)
      return

    const target = event.target as HTMLElement | null
    if (!target)
      return

    const block = target.closest(BLOCK_SELECTOR) as HTMLElement | null
    if (!block)
      return

    const sourceBlocks = sourceBlockCache.get(model)
    if (sourceBlocks.length === 0)
      return

    // Infer the expected source block from the click position: used both for duplicate-text
    // disambiguation and as the fallback when content matching finds nothing
    const located = locatePreviewBlock(preview, target)
    const expectedIndex = located
      ? projectIndex(located.index, located.total, sourceBlocks.length)
      : 0

    const range = matchContent(model, sourceBlocks, block, expectedIndex)
      ?? (located ? sourceBlocks[expectedIndex]! : null)
    if (range)
      jumpTo(editor, range)
  }

  // Bind / unbind
  watchEffect((onCleanup) => {
    if (!toValue(enabled))
      return

    const editor = toValue(editorRef)
    const preview = toValue(previewRef)
    if (!editor || !preview)
      return

    preview.addEventListener('click', onPreviewClick)

    onCleanup(() => {
      preview.removeEventListener('click', onPreviewClick)
    })
  })
}
