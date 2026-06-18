import type { Data, Literal } from 'mdast'

export interface Ruby extends Literal {
  type: 'ruby'
  value: string
  ruby: string
  format?: 'basic' | 'basic-hat'
  data?: RubyData
}

export interface RubyData extends Data {}

declare module 'mdast' {
  interface PhrasingContentMap {
    ruby: Ruby
  }

  interface RootContentMap {
    ruby: Ruby
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    ruby: 'ruby'
    rubyText: 'rubyText'
    rubyTextData: 'rubyTextData'
    rubyTextSequence: 'rubyTextSequence'
    rubyAnnotation: 'rubyAnnotation'
    rubyAnnotationData: 'rubyAnnotationData'
    rubyAnnotationSequence: 'rubyAnnotationSequence'
  }
}
