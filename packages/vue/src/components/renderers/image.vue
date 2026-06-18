<script setup lang="ts">
import type { ImageNodeRendererProps } from '../../types'
import { createImageModel, saveImage } from '@stream-markdown/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useContext, useControls, useI18n, useImageUrlResolver, useSanitizers } from '../../composables'

const props = withDefaults(defineProps<ImageNodeRendererProps>(), {})

const {
  beforeDownload,
  controls,
  hardenOptions,
  imageOptions,
  uiComponents: UI,
} = useContext()

const { t } = useI18n()

const resolver = useImageUrlResolver()

const { isControlEnabled } = useControls({
  controls,
})

const maskRef = ref()

const loadError = ref<boolean>(false)
const imageLoaded = ref<boolean>(false)
const fallbackAttempted = ref<boolean>(false)

const resolvedUrl = ref<string>('')
const isResolving = ref<boolean>(false)

const baseImageModel = computed(() => createImageModel({
  node: props.node,
  imageOptions: imageOptions.value,
  fallbackAttempted: fallbackAttempted.value,
  imageLoaded: imageLoaded.value,
  isResolving: isResolving.value,
}))

const isLoading = computed(() => baseImageModel.value.isLoading)

const enableDownload = computed(() => isControlEnabled('image.download'))
const enablePreview = computed(() => isControlEnabled('image.preview'))

const fallback = computed(() => baseImageModel.value.fallback)
const imageSrc = computed(() => baseImageModel.value.imageSrc)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => imageSrc.value, async (url) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  if (!url) {
    resolvedUrl.value = ''
    return
  }

  if (!resolver) {
    resolvedUrl.value = url
    return
  }

  const cached = resolver.getState(url)
  if (cached?.status === 'resolved' || cached?.status === 'rejected') {
    resolvedUrl.value = cached.value!
    return
  }
  if (cached?.status === 'pending') {
    resolvedUrl.value = await cached.promise
    return
  }

  debounceTimer = setTimeout(async () => {
    debounceTimer = null
    isResolving.value = true
    try {
      resolvedUrl.value = await resolver.resolve(
        url,
        { alt: props.node.alt, title: props.node.title },
      )
    }
    catch {
      resolvedUrl.value = url
    }
    finally {
      isResolving.value = false
    }
  }, 150)
}, { immediate: true })

onBeforeUnmount(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
})

const { transformedUrl, isHardenUrl, transformHardenUrl } = useSanitizers({
  url: resolvedUrl,
  hardenOptions,
  loading: isLoading,
  isImage: true,
})

const imageModel = computed(() => createImageModel({
  node: props.node,
  imageOptions: imageOptions.value,
  fallbackAttempted: fallbackAttempted.value,
  imageLoaded: imageLoaded.value,
  isHardenUrl: isHardenUrl.value,
  loadError: loadError.value,
  isResolving: isResolving.value,
}))

const alt = computed(() => imageModel.value.alt)
const title = computed(() => imageModel.value.title)
const showCaption = computed(() => imageModel.value.showCaption)

const Error = computed(() => isHardenUrl.value
  ? (hardenOptions.value?.errorComponent ?? UI.value.ErrorComponent)
  : (imageOptions.value?.errorComponent ?? UI.value.ErrorComponent))

function handleLoaded() {
  imageLoaded.value = true
}

function handleError() {
  if (fallback.value && !fallbackAttempted.value) {
    fallbackAttempted.value = true
    return
  }
  loadError.value = true
}

async function handleDownload(url: string = resolvedUrl.value) {
  if (!url)
    return
  const result = await beforeDownload({
    type: 'image',
    url,
  })
  if (result)
    saveImage(url, alt.value)
}

function handleMouseEnter() {
  if (maskRef.value)
    maskRef.value.style.opacity = 1
}

function handleMouseLeave() {
  if (maskRef.value)
    maskRef.value.style.opacity = 0
}
</script>

<template>
  <figure
    data-stream-markdown="image-figure"
    class="inline-block"
    :style="{
      width: imageModel.figureWidth,
    }"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <div
      data-stream-markdown="image-wrapper"
      class="text-center relative"
    >
      <div
        v-if="!isHardenUrl"
        ref="maskRef"
        data-stream-markdown="image-mask"
        class="rounded-lg bg-[rgb(0_0_0_/_0.1)] opacity-0 pointer-events-none transition-opacity duration-[var(--default-transition-duration)] ease inset-0 absolute"
      >
        <div
          v-if="!isLoading && enableDownload"
          class="pointer-events-auto bottom-2 right-2 absolute"
        >
          <component
            :is="UI.Button"
            data-stream-markdown="image-download-button"
            icon="download"
            :name="t('button.download')"
            icon-class="test"
            :icon-width="16"
            :icon-height="16"
            :button-style="{
              backgroundColor: 'color-mix(in oklab, var(--background) 90%, transparent)',
            }"
            @click="() => handleDownload(resolvedUrl)"
          />
        </div>
      </div>

      <component :is="UI.Spin" v-if="imageModel.showSpin" />

      <component
        :is="UI.Image"
        v-if="imageModel.showImage && typeof transformedUrl === 'string'"
        :key="transformedUrl"
        :src="transformedUrl"
        :alt="alt"
        :title="title"
        :preview="!fallbackAttempted && enablePreview"
        :referrer-policy="imageOptions?.referrerPolicy"
        :controls="controls"
        :transform-harden-url="transformHardenUrl"
        :node-props="props"
        :handle-download="handleDownload"
        @load="handleLoaded"
        @error="handleError"
      />
      <component
        :is="Error"
        v-else-if="imageModel.showError"
        :variant="imageModel.errorVariant"
      >
        {{ title }}
      </component>
    </div>

    <figcaption
      v-if="showCaption && title"
      data-stream-markdown="image-caption"
      class="text-sm text-center italic"
    >
      {{ title }}
    </figcaption>
  </figure>
</template>
