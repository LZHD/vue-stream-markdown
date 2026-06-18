import { getLastParagraphWithIndex } from './utils'

const rubyPattern = /\[[^\]]+\]\{[^}]*$/
const rubyHatPattern = /\[[^\]]+\]\^\([^)]*$/

/**
 * Fix unclosed Ruby annotation syntax in streaming markdown.
 *
 * Only processes the last paragraph (content after the last blank line).
 *
 * @example
 * fixRuby('[漢字]{かん')
 * // Returns: '[漢字]{かん}'
 *
 * @example
 * fixRuby('[漢字]^(')
 * // Returns: '[漢字]^()'
 */
export function fixRuby(
  content: string,
): string {
  const { lastParagraph } = getLastParagraphWithIndex(content, true)

  if (rubyPattern.test(lastParagraph)) {
    return `${content}}`
  }

  if (rubyHatPattern.test(lastParagraph)) {
    return `${content})`
  }

  return content
}
