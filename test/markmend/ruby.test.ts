import type { ParsedNode, RubyNode, SyntaxTree } from '@markmend/ast'
import { MarkdownAstParser } from '@markmend/ast'
import { fixRuby, preprocess } from '@markmend/core'
import { describe, expect, it } from 'vitest'

function getFirstRubyNode(ast: SyntaxTree): RubyNode | undefined {
  const paragraph = ast.children[0] as { children?: ParsedNode[] } | undefined
  return paragraph?.children?.find((child): child is RubyNode => child.type === 'ruby')
}

describe('ruby annotation', () => {
  it('should parse [text]{ruby} syntax', () => {
    const parser = new MarkdownAstParser({ mode: 'static' })
    const result = parser.parseMarkdown('[漢字]{かんじ}')

    expect(result.asts).toHaveLength(1)

    const ruby = getFirstRubyNode(result.asts[0]!)
    expect(ruby).toBeDefined()
    expect(ruby!.type).toBe('ruby')
    expect(ruby!.value).toBe('漢字')
    expect(ruby!.ruby).toBe('かんじ')
  })

  it('should parse [text]^(ruby) syntax', () => {
    const parser = new MarkdownAstParser({ mode: 'static' })
    const result = parser.parseMarkdown('[漢字]^(かんじ)')

    const ruby = getFirstRubyNode(result.asts[0]!)
    expect(ruby).toBeDefined()
    expect(ruby!.value).toBe('漢字')
    expect(ruby!.ruby).toBe('かんじ')
  })

  it('should not break regular links', () => {
    const parser = new MarkdownAstParser({ mode: 'static' })
    const result = parser.parseMarkdown('[link](https://example.com)')

    const paragraph = result.asts[0]?.children[0] as { children?: Array<{ type: string } & Record<string, unknown>> } | undefined
    const link = paragraph?.children?.find(child => child.type === 'link')
    expect(link).toBeDefined()
  })

  it('should serialize ruby back to markdown', () => {
    const parser = new MarkdownAstParser({ mode: 'static' })
    const result = parser.parseMarkdown('[漢字]{かんじ}')
    const markdown = parser.astToMarkdown(result.asts[0]!)

    expect(markdown).toBe('[漢字]{かんじ}\n')
  })

  it('should parse incomplete ruby as ruby node in streaming mode', () => {
    const parser = new MarkdownAstParser({ mode: 'streaming' })
    const result = parser.parseMarkdown('[漢字]{かん')

    const ruby = getFirstRubyNode(result.asts[0]!)
    expect(ruby).toBeDefined()
    expect(ruby!.value).toBe('漢字')
    expect(ruby!.ruby).toBe('かん')
  })
})

describe('fixRuby preprocess', () => {
  it('fixRuby directly closes unclosed curly ruby syntax', () => {
    expect(fixRuby('[漢字]{かん')).toBe('[漢字]{かん}')
  })

  it('should complete unclosed curly ruby syntax', () => {
    expect(preprocess('[漢字]{かん')).toBe('[漢字]{かん}')
  })

  it('should complete unclosed hat ruby syntax', () => {
    expect(preprocess('[漢字]^(')).toBe('[漢字]^()')
  })

  it('should not affect closed ruby syntax', () => {
    expect(preprocess('[漢字]{かんじ}')).toBe('[漢字]{かんじ}')
  })

  it('should only process the last paragraph', () => {
    expect(preprocess('Hello\n\n[漢字]{かん')).toBe('Hello\n\n[漢字]{かん}')
  })
})
