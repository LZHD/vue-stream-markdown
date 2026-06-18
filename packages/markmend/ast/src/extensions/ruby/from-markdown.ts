import type { CompileContext, Extension, Token } from 'mdast-util-from-markdown'
import type { Ruby } from './types'

export function rubyFromMarkdown(): Extension {
  return {
    enter: {
      ruby: enterRuby,
    },
    exit: {
      rubyTextData: exitRubyTextData,
      rubyAnnotationData: exitRubyAnnotationData,
      ruby: exitRuby,
    },
  }

  function enterRuby(this: CompileContext, token: Token) {
    this.enter(
      {
        type: 'ruby',
        value: '',
        ruby: '',
        data: {
          hName: 'ruby',
        },
      } as Ruby,
      token,
    )
  }

  function exitRubyTextData(this: CompileContext, token: Token) {
    const node = this.stack[this.stack.length - 1] as Ruby
    node.value = this.sliceSerialize(token)
  }

  function exitRubyAnnotationData(this: CompileContext, token: Token) {
    const node = this.stack[this.stack.length - 1] as Ruby
    node.ruby = this.sliceSerialize(token)
  }

  function exitRuby(this: CompileContext, token: Token) {
    this.exit(token)
  }
}
