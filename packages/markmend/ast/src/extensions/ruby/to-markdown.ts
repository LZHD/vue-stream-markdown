import type { Options } from 'mdast-util-to-markdown'
import type { Ruby } from './types'

export function rubyToMarkdown(): Options {
  return {
    handlers: {
      ruby,
    },
  }

  function ruby(node: Ruby): string {
    const text = node.value || ''
    const ruby = node.ruby || ''

    if (node.format === 'basic-hat' || ruby.includes('}')) {
      return `[${text}]^(${ruby})`
    }

    return `[${text}]{${ruby}}`
  }
}
