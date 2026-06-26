import type { Editor } from '../types'

// Monaco text model (null excluded)
export type EditorModel = NonNullable<ReturnType<Editor['getModel']>>

// A logical block of the source document, split on blank lines (1-based, inclusive)
export interface SourceBlock {
  startLine: number
  endLine: number
}

// Split the source document into logical blocks on blank lines.
// Scroll sync and click-to-locate share the same segmentation so their granularity stays consistent.
//
// Known approximation: a blank line inside a fenced code block splits that one rendered <pre> into
// several source blocks, so source and preview block counts can differ. This is by design - the
// proportional projectBlock mapping in use-scroll-sync tolerates count mismatches, and use-cursor-sync
// falls back to proportional mapping when content matching fails on the partial block.
export function parseSourceBlocks(model: EditorModel): SourceBlock[] {
  const blocks: SourceBlock[] = []
  let blockStart = -1
  const lineCount = model.getLineCount()

  for (let i = 1; i <= lineCount; i++) {
    const isEmpty = model.getLineContent(i).trim() === ''
    if (!isEmpty && blockStart === -1) {
      blockStart = i
    }
    else if (isEmpty && blockStart !== -1) {
      blocks.push({ startLine: blockStart, endLine: i - 1 })
      blockStart = -1
    }
  }
  if (blockStart !== -1)
    blocks.push({ startLine: blockStart, endLine: lineCount })

  return blocks
}

// Create a block cache keyed by the model version id.
// Each caller holds its own cache; the result is reused while the content is unchanged,
// avoiding a re-segmentation on every scroll/click.
export function createSourceBlockCache() {
  let cachedVersion = -1
  let cachedSourceBlocks: SourceBlock[] = []

  function get(model: EditorModel): SourceBlock[] {
    const version = model.getVersionId()
    if (version === cachedVersion)
      return cachedSourceBlocks
    cachedVersion = version
    cachedSourceBlocks = parseSourceBlocks(model)
    return cachedSourceBlocks
  }

  return { get }
}
