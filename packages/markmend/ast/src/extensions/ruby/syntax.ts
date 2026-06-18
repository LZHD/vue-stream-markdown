import type { Code, Construct, Effects, Extension, State, TokenizeContext } from 'micromark-util-types'
import { codes } from 'micromark-util-symbol'

/**
 * Create a micromark extension for Ruby annotations.
 *
 * Supports:
 * - `[文字]{注音}`
 * - `[文字]^(注音)`
 */
export function rubySyntax(): Extension {
  return {
    text: { [codes.leftSquareBracket]: ruby() },
  }
}

function ruby(): Construct {
  return {
    name: 'ruby',
    tokenize: tokenizeRuby,
  }
}

function tokenizeRuby(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return start

  function start(code: Code): State | undefined {
    if (code !== codes.leftSquareBracket) {
      return nok(code)
    }

    effects.enter('ruby')
    effects.enter('rubyTextSequence')
    effects.consume(code)
    effects.exit('rubyTextSequence')
    effects.enter('rubyText')
    return textData
  }

  function textData(code: Code): State | undefined {
    if (code === codes.eof || code === codes.lf || code === codes.cr) {
      return nok(code)
    }

    if (code === codes.rightSquareBracket) {
      effects.exit('rubyText')
      effects.enter('rubyTextSequence')
      return textClose(code)
    }

    effects.enter('rubyTextData')
    return textDataInner(code)
  }

  function textDataInner(code: Code): State | undefined {
    if (code === codes.eof || code === codes.lf || code === codes.cr || code === codes.rightSquareBracket) {
      effects.exit('rubyTextData')
      return textData(code)
    }

    effects.consume(code)
    return textDataInner
  }

  function textClose(code: Code): State | undefined {
    if (code !== codes.rightSquareBracket) {
      return nok(code)
    }

    effects.consume(code)
    effects.exit('rubyTextSequence')
    return afterText
  }

  function afterText(code: Code): State | undefined {
    if (code === codes.leftCurlyBrace) {
      effects.enter('rubyAnnotationSequence')
      return annotationOpenCurly(code)
    }

    if (code === codes.caret) {
      effects.enter('rubyAnnotationSequence')
      effects.consume(code)
      return hatStart
    }

    return nok(code)
  }

  function annotationOpenCurly(code: Code): State | undefined {
    if (code !== codes.leftCurlyBrace) {
      return nok(code)
    }

    effects.consume(code)
    effects.exit('rubyAnnotationSequence')
    effects.enter('rubyAnnotation')
    return annotationDataCurly
  }

  function annotationDataCurly(code: Code): State | undefined {
    if (code === codes.eof || code === codes.lf || code === codes.cr) {
      return nok(code)
    }

    if (code === codes.rightCurlyBrace) {
      effects.exit('rubyAnnotation')
      effects.enter('rubyAnnotationSequence')
      return annotationCloseCurly(code)
    }

    effects.enter('rubyAnnotationData')
    return annotationDataInnerCurly(code)
  }

  function annotationDataInnerCurly(code: Code): State | undefined {
    if (code === codes.eof || code === codes.lf || code === codes.cr || code === codes.rightCurlyBrace) {
      effects.exit('rubyAnnotationData')
      return annotationDataCurly(code)
    }

    effects.consume(code)
    return annotationDataInnerCurly
  }

  function annotationCloseCurly(code: Code): State | undefined {
    if (code !== codes.rightCurlyBrace) {
      return nok(code)
    }

    effects.consume(code)
    effects.exit('rubyAnnotationSequence')
    effects.exit('ruby')
    return ok(code)
  }

  function hatStart(code: Code): State | undefined {
    if (code !== codes.leftParenthesis) {
      return nok(code)
    }

    effects.consume(code)
    effects.exit('rubyAnnotationSequence')
    effects.enter('rubyAnnotation')
    return annotationDataParen
  }

  function annotationDataParen(code: Code): State | undefined {
    if (code === codes.eof || code === codes.lf || code === codes.cr) {
      return nok(code)
    }

    if (code === codes.rightParenthesis) {
      effects.exit('rubyAnnotation')
      effects.enter('rubyAnnotationSequence')
      return annotationCloseParen(code)
    }

    effects.enter('rubyAnnotationData')
    return annotationDataInnerParen(code)
  }

  function annotationDataInnerParen(code: Code): State | undefined {
    if (code === codes.eof || code === codes.lf || code === codes.cr || code === codes.rightParenthesis) {
      effects.exit('rubyAnnotationData')
      return annotationDataParen(code)
    }

    effects.consume(code)
    return annotationDataInnerParen
  }

  function annotationCloseParen(code: Code): State | undefined {
    if (code !== codes.rightParenthesis) {
      return nok(code)
    }

    effects.consume(code)
    effects.exit('rubyAnnotationSequence')
    effects.exit('ruby')
    return ok(code)
  }
}
