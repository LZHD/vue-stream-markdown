<script setup lang="ts">
import type { RubyNodeRendererProps } from '../../types'
import { computed } from 'vue'

const props = withDefaults(defineProps<RubyNodeRendererProps>(), {})

const isStreaming = computed(() => props.markdownParser.hasLoadingNode())

const separatorRegex = /[・．。\-]/g

function renderSingleRuby(text: string, ruby: string, format?: string): string {
  return `<ruby data-text="${escapeHtml(text)}" data-ruby="${escapeHtml(ruby)}" data-format="${format ?? 'basic'}">${escapeHtml(text)}<rp>(</rp><rt>${escapeHtml(ruby)}</rt><rp>)</rp></ruby>`
}

function renderSplitRuby(text: string, ruby: string, format?: string): string {
  const rubyParts = ruby.split(separatorRegex).filter(part => part.trim() !== '')
  const textChars = text.split('')
  const result: string[] = []

  if (textChars.length >= rubyParts.length) {
    let currentIndex = 0

    for (let i = 0; i < rubyParts.length; i++) {
      const rubyPart = rubyParts[i]!
      const remainingChars = textChars.length - currentIndex
      const remainingParts = rubyParts.length - i

      let charCount = 1
      if (remainingParts === 1) {
        charCount = remainingChars
      }

      const currentText = textChars.slice(currentIndex, currentIndex + charCount).join('')

      result.push(renderSingleRuby(currentText, rubyPart, format))

      currentIndex += charCount
    }

    if (currentIndex < textChars.length) {
      result.push(textChars.slice(currentIndex).join(''))
    }
  }
  else {
    for (let i = 0; i < textChars.length; i++) {
      const char = textChars[i]!
      const rubyPart = rubyParts[i] || ''

      if (rubyPart) {
        result.push(renderSingleRuby(char, rubyPart, format))
      }
      else {
        result.push(char)
      }
    }
  }

  return result.join('')
}

function renderRuby(text: string, ruby: string, format?: string): string {
  const hasSeparators = separatorRegex.test(ruby)

  if (!hasSeparators) {
    return renderSingleRuby(text, ruby, format)
  }

  return renderSplitRuby(text, ruby, format)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
</script>

<template>
  <span
    data-stream-markdown="ruby"
    v-html="isStreaming ? renderSingleRuby(node.value, node.ruby, node.format) : renderRuby(node.value, node.ruby, node.format)"
  />
</template>
