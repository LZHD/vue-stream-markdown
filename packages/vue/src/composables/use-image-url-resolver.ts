import type { ImageOptions, ImageUrlContext } from '@stream-markdown/core'
import type { InjectionKey, Ref } from 'vue'
import { resolveImageUrl } from '@stream-markdown/core'
import { inject, provide } from 'vue'

export interface CacheEntry {
  promise: Promise<string>
  status: 'pending' | 'resolved' | 'rejected'
  value?: string
}

export interface ImageUrlResolver {
  /** Resolve a URL through the global cache. Same URL only resolves once. */
  resolve: (url: string, context: ImageUrlContext) => Promise<string>
  /** Get the current cache state for a URL. Useful to avoid loading flicker. */
  getState: (url: string) => CacheEntry | undefined
  /** Clear the cache. Call when resolveUrl function changes. */
  clear: () => void
}

const IMAGE_URL_RESOLVER_KEY: InjectionKey<ImageUrlResolver> = Symbol('image-url-resolver')

export function createImageUrlResolver(
  imageOptions: Ref<ImageOptions | undefined>,
): ImageUrlResolver {
  const cache = new Map<string, CacheEntry>()

  return {
    async resolve(url, context) {
      if (!url)
        return url

      const resolveFn = imageOptions.value?.resolveUrl
      if (!resolveFn)
        return url

      const cached = cache.get(url)
      if (cached)
        return cached.promise

      const promise = resolveImageUrl(url, context, imageOptions.value)
        .then((resolved) => {
          const entry = cache.get(url)
          if (entry) {
            entry.status = 'resolved'
            entry.value = resolved
          }
          return resolved
        })
        .catch(() => {
          const entry = cache.get(url)
          if (entry) {
            entry.status = 'rejected'
            entry.value = url
          }
          return url
        })

      cache.set(url, { promise, status: 'pending' })
      return promise
    },
    getState(url) {
      return cache.get(url)
    },
    clear() {
      cache.clear()
    },
  }
}

export function provideImageUrlResolver(resolver: ImageUrlResolver): void {
  provide(IMAGE_URL_RESOLVER_KEY, resolver)
}

export function useImageUrlResolver(): ImageUrlResolver | undefined {
  return inject(IMAGE_URL_RESOLVER_KEY, undefined)
}
