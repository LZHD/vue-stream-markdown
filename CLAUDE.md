# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

- `pnpm dev` - Alias for `pnpm playground:dev`.
- `pnpm playground:dev` - Start the Nuxt 4 playground dev server (`pnpm -F nuxt-playground dev`).
- `pnpm playground:build` - Generate the playground as a static site (`nuxt generate`).
- `pnpm playground:prepare` - Run `nuxt prepare` (generates `.nuxt/` types and is also invoked by `pnpm prepare`).
- `pnpm playground:typecheck` - Type check the playground only.
- `pnpm docs:dev` - Start the VitePress documentation site.
- `pnpm docs:build` - Build the documentation site.
- `pnpm build` - Build all publishable packages via Turborepo (`tsdown`). Filters on `packages/*`, `packages/extensions/*`, and `packages/markmend/*`.
- `pnpm typecheck` - Type check packages (`tsc --noEmit`) and the playground (`pnpm playground:typecheck`). Uses the experimental TypeScript tsgo implementation via `typescript.experimental.useTsgo`.
- `pnpm lint` - Run ESLint on all tracked files.
- `pnpm prepare` - Install git hooks (`simple-git-hooks`) and prepare the playground (`pnpm playground:prepare`).

### Testing

- `pnpm test` - Run Vitest in watch mode.
- `pnpm test run` - Run all tests once.
- `pnpm test run <path-to-test-file>` - Run a single test file, e.g. `pnpm test run test/markmend/preprocess/code.test.ts`.
- `pnpm test:coverage` - Run tests once with coverage. Coverage is focused on `packages/markmend/core/src/preprocess/*.ts`, `packages/markmend/core/src/processor.ts`, and `packages/markmend/ast/src/parser.ts`.

### Release & Dependencies

- `pnpm deps` - Update dependencies using `taze major -I`.
- `pnpm release` - Bump versions across the monorepo using `bumpp -r`.
- `pnpm prepack` - Runs `tsx ./scripts/publish.ts` before packing.

## Code Architecture

### Monorepo Structure

Turborepo monorepo using pnpm workspaces with catalog dependency management (`pnpm-workspace.yaml`).

**Published Packages**:

- `vue-stream-markdown` (`packages/vue/`): Main Vue 3 component library. Exports `Markdown`, composables, types, and utilities. Peer dependencies (`vue`, `shiki`, `katex`, `mermaid`, `beautiful-mermaid`) are all optional; CDN fallbacks exist for code, math, and mermaid.
- `@markmend/core` (`packages/markmend/core/`): Streaming-friendly Markdown processor with syntax completion and block segmentation.
- `@markmend/ast` (`packages/markmend/ast/`): MDAST parser adapter wrapping `mdast-util-from-markdown` with streaming support. Depends on `@markmend/core`.
- `@stream-markdown/core` (`packages/core/`): Shared runtime utilities, types, browser helpers, and renderer abstractions used by the Vue package and extensions. Depends on `@markmend/ast`.
- `@stream-markdown/code` (`packages/extensions/code/`): Code block rendering with Shiki syntax highlighting and CDN fallback.
- `@stream-markdown/math` (`packages/extensions/math/`): LaTeX/KaTeX math equation rendering with CDN fallback.
- `@stream-markdown/mermaid` (`packages/extensions/mermaid/`): Diagram rendering with dual renderer system (vanilla Mermaid + beautiful-mermaid).
- `@stream-markdown/html` (`packages/extensions/html/`): Optional HTML tag rendering with sanitization and custom element mapping.

### Dependency Graph

```
@markmend/core
  ↑
@markmend/ast
  ↑
@stream-markdown/core
  ↑        ↑        ↑        ↑
@stream-markdown/code  @stream-markdown/math  @stream-markdown/mermaid  @stream-markdown/html
  \        |        |        /
   \       |        |       /
    vue-stream-markdown
```

### Data Flow

```
Raw content
  → MarkdownProcessor.normalize()                 (CRLF → LF, trim trailing whitespace, LaTeX preprocessing)
  → MarkdownProcessor.parseMarkdownIntoBlocks()   (segment into blocks)
  → MarkdownProcessor.preprocess()                (syntax inference for incomplete nodes, last block only in streaming mode)
  → MarkdownAstParser.markdownToAst()             (mdast-util-from-markdown parsing)
  → MarkdownAstParser.postprocess()               (streaming mode adjustments)
  → Vue component tree                            (defineAsyncComponent renderers)
```

### Streaming Engine

**MarkdownAstParser** (`packages/markmend/ast/src/parser.ts`):

- Caches parsed ASTs with `QuickLRU` (max 100 entries) keyed by content string.
- In `streaming` mode, preprocesses the last block and marks the last leaf text node with `loading: true`.
- In `static` mode, clears loading states and preserves multi-block segmentation.
- `updateMode` preserves block keys to avoid broad component remounts when switching modes at runtime.

**MarkdownProcessor** (`packages/markmend/core/src/processor.ts`):

- Normalizes content and preprocesses Dify-style LaTeX.
- Segments content into blocks for streaming-friendly incremental updates.
- Applies preprocess steps only to the last block while streaming.

**Preprocess Steps** (`packages/markmend/core/src/preprocess/`):
Applied to the last block in streaming mode to infer incomplete syntax: `code`, `html`, `footnote`, `strong`, `emphasis`, `delete`, `taskList`, `link`, `table`, `inlineMath`, `math`.

### Vue Component Layer

**Main Markdown Component** (`packages/vue/src/index.vue`):

- Orchestrates parser creation, preloaders (Shiki, Mermaid, KaTeX), theme detection, and context provision.
- Creates the parser via `createStreamMarkdownEngine()` from `@stream-markdown/core`.
- Emits `copied` when copy buttons are triggered.

**Renderer Components** (`packages/vue/src/components/renderers/`):

- All node renderers are lazy-loaded via `defineAsyncComponent`.
- `NodeList` recursively renders AST nodes using the renderer registry.
- Renderers receive `NodeRendererProps` including `node`, `blockIndex`, `deep`, `markdownParser`, and `nodeRenderers`.

### Extension Architecture

Extensions (`@stream-markdown/*`) typically export:

- `runtime.ts`: Core rendering logic and CDN loaders.
- `cdn.ts` / `*-cdn.ts`: CDN fallback loading (jsDelivr/unpkg).
- `constants.ts`: Default themes, aliases, and configuration defaults.
- `types.ts`: TypeScript interfaces for options and runtime state.

**Code Highlighting**: Uses Shiki's `codeToTokens` API for token-level incremental updates. Supports bundled Shiki and CDN-loaded Shiki. Heavy peer deps (`shiki`, `katex`, `mermaid`, `beautiful-mermaid`) are marked `neverBundle` in the Vue package build config.

**Mermaid**: Dual renderer system. `resolveMermaidRendererType()` auto-selects `beautiful` or `vanilla` based on module availability, CDN config, or explicit option.

**Math**: KaTeX integration with streaming-friendly rendering for inline (`$...$`) and block (`$$...$$`) math.

### Security & Sanitization

Built-in content hardening (`packages/core/src/utils/harden.ts`):

- URL validation and protocol blocking for links and images.
- Configurable `allowedLinkPrefixes`, `allowedImagePrefixes`, and `allowedProtocols`.
- Ported from rehype-harden principles.

### Build System

- **Build tool**: `tsdown` (TypeScript to ESM/CJS bundler).
- **Vue package** (`packages/vue/tsdown.config.ts`): Uses `@vitejs/plugin-vue` and `unplugin-icons`. Entry points: `src/index` and `src/html`. Bundles `src/style.css` as `dist/index.css` and copies `src/theme.css` to `dist/theme.css`. `dts.vue: true` enables Vue type generation.
- **Other packages**: Entry point `src/index.ts`, `dts.tsgo: true` for fast type generation, and `exports: true` for auto-generated export map.
- **Turborepo**: `turbo.json` defines a `build` task with `dependsOn: ["^build"]` and outputs `dist/**`.

### Alias Resolution

`shared.ts` at repo root defines Vite aliases for monorepo package resolution. Imported by `vitest.config.ts`, the playground Nuxt config, and the VitePress docs config. Key aliases:

- `vue-stream-markdown` → `packages/vue/src/index.ts`
- `vue-stream-markdown/html` → `packages/vue/src/html.ts`
- `vue-stream-markdown/style.css` → `packages/vue/src/style.css`
- `@markmend/core` → `packages/markmend/core/src/index.ts`
- `@markmend/ast` → `packages/markmend/ast/src/index.ts`
- `@markmend` → `packages/markmend/core/src` (used for deep imports from the markmend core package)
- `@stream-markdown/*` → `packages/extensions/*/src/index.ts`
- `@vue-stream-markdown/*` → `packages/vue/src/*`

### Dependencies

- **Package manager**: pnpm 11.1.2 with workspace catalog (`pnpm-workspace.yaml`).
- **ESLint**: `@octohash/eslint-config` with UnoCSS and formatters support.
- **Git hooks**: `simple-git-hooks` runs `pnpm nano-staged` on pre-commit, which runs `eslint --fix`.

### Testing Strategy

- **Test runner**: Vitest with `@vitejs/plugin-vue` and `unplugin-icons`.
- **DOM environment**: `happy-dom` for component tests.
- **Test files**: Located in `test/`, organized by package (`test/markmend/`, `test/vue/`, `test/core/`, `test/html/`).
- **Coverage**: Focused on `packages/markmend/core/src/preprocess/*.ts`, `packages/markmend/core/src/processor.ts`, and `packages/markmend/ast/src/parser.ts`.
- **Shiki resolution**: `vitest.config.ts` aliases `shiki` to `packages/vue/node_modules/shiki` and excludes it from dependency optimization.

### Playground & Documentation

- **Playground**: Nuxt 4 app in `playground/nuxt/`. Uses UnoCSS, `@nuxtjs/color-mode`, `@nuxt/devtools`, `unplugin-icons`, `@monaco-editor/loader`, and `vue-json-pretty`. Directly imports `packages/vue/src/style.css`. Includes shareable-link generation and AST viewing for debugging streaming issues.
- **Documentation**: VitePress in `docs/`. Custom theme with a landing page component. Consumes `vue-stream-markdown` as a workspace dependency.
