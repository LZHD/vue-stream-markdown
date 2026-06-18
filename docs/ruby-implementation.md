# Ruby 注音/拼音标注扩展 — 实现复盘

> 本文档复盘 `vue-stream-markdown` 中 Ruby 注音标注（`[文字]{注音}` / `[文字]^(注音)`）功能从需求到落地的完整思路，覆盖架构决策、各层实现细节、流式渲染优化以及踩坑记录。

## 1. 背景与需求

### 1.1 目标语法

需要支持两种 Ruby 标注写法，渲染为 HTML `<ruby>` 元素：

| 写法        | 示例              | 说明                   |
| ----------- | ----------------- | ---------------------- |
| 花括号      | `[漢字]{かんじ}`  | base text + annotation |
| 帽子+圆括号 | `[漢字]^(かんじ)` | 同上，另一种分隔符     |

并支持注音内的**分隔符**，将 base text 按字符与注音分段对齐：

- 分隔符集合：`・`（中点）、`．`（全角句点）、`。`（中文句号）、`-`（英文减号）
- 例：`[漢字]{かん・じ}` → `漢`→`かん`，`字`→`じ`，渲染为两组 `<ruby>`

### 1.2 起点：一段 `marked` 扩展代码

最初拿到的是一段基于 `marked` 的 `MarkedExtension` 实现（`markedRuby()`），它用正则 `tokenizer` 匹配语法、用字符串拼接 `renderer` 输出 `<ruby>` HTML。

**关键发现**：本仓库的 `marked` 只用于 `parse-blocks.ts` 里的**块级分片**（`Lexer.lex`），真正的渲染管线走的是 **micromark → mdast → Vue renderer**。因此那段 `marked` 扩展无法直接接入渲染流程。

```
Raw content
  → MarkdownProcessor.normalize()                 (CRLF→LF, trim, LaTeX 预处理)
  → MarkdownProcessor.parseMarkdownIntoBlocks()   (块级分片，仅这里用 marked.Lexer)
  → MarkdownProcessor.preprocess()                (流式语法补全，仅最后一块)
  → MarkdownAstParser.markdownToAst()             (micromark + mdast 解析)  ← Ruby 解析在这层
  → MarkdownAstParser.postprocess()               (流式调整)
  → Vue component tree                            (defineAsyncComponent renderers)  ← Ruby 渲染在这层
```

### 1.3 方案选择

向用户提供了两种方案：

- **轻量做法**：在 `postprocess` 阶段扫描 text 节点，用正则替换为自定义 ruby 节点。实现快，但嵌套链接/强调时不够健壮。
- **正统做法**：实现 micromark syntax extension + mdast extension（和现有 `math` 扩展同构），对边界情况最可靠。

用户选择**正统做法**。后续也证明这个选择是对的——它天然复用了流式引擎的 loading 机制、缓存、块管理等基础设施。

## 2. 架构对标：以 `math` 扩展为蓝本

实现前先研究了 `micromark-extension-math` + `mdast-util-math` 的源码，作为同构参考。一个自定义内联语法在本仓库需要打通 **6 层**：

```
1. micromark syntax     把字符流 tokenize 成 ruby* token
        ↓
2. mdast from-markdown   把 token 转成 { type: 'ruby' } mdast 节点
        ↓
3. mdast to-markdown     把 ruby 节点序列化回 markdown 字符串
        ↓
4. 类型注册              ParsedNode / NodeType / BuiltinNodeRenderers 加入 'ruby'
        ↓
5. Vue renderer          ruby.vue 输出 <ruby> DOM
        ↓
6. renderer 注册         NODE_RENDERERS 映射 + RubyNodeRendererProps 类型
```

### 依赖关系

```
@markmend/core            ← 新增 fixRuby 预处理（流式补全）
  ↑
@markmend/ast             ← 新增 ruby 扩展（syntax + from/to-markdown + types）
  ↑
@stream-markdown/core     ← 透传 RubyNode 类型，BuiltinNodeRenderers 加 'ruby'
  ↑
vue-stream-markdown       ← ruby.vue + NODE_RENDERERS 注册 + RubyNodeRendererProps
```

## 3. 第一层：micromark syntax 扩展

**文件**：`packages/markmend/ast/src/extensions/ruby/syntax.ts`

### 3.1 micromark 的状态机模型

micromark 的 tokenizer 是一个**逐字符状态机**。核心概念：

- `State` 是一个函数 `(code: Code) => State | undefined`，接收当前字符码，返回下一个状态。
- `effects.enter(type)` / `effects.exit(type)` 标记 token 的边界。
- `effects.consume(code)` 消费当前字符，推进游标。
- `ok(code)` 表示匹配成功，`nok(code)` 表示失败回退（让位给普通文本/其它构造）。

扩展挂载在 `text` 层（内联），以 `[`（`leftSquareBracket`）为触发字符：

```ts
export function rubySyntax(): Extension {
  return {
    text: { [codes.leftSquareBracket]: ruby() },
  }
}
```

### 3.2 Token 结构设计

参考 math 的 `mathText`/`mathTextSequence`/`mathTextData` 分层，定义了 6 种 token：

| Token                    | 含义                                           |
| ------------------------ | ---------------------------------------------- |
| `ruby`                   | 整个 Ruby 构造的外层容器                       |
| `rubyTextSequence`       | 分隔符 `[` 和 `]`                              |
| `rubyText`               | base text 容器                                 |
| `rubyTextData`           | base text 实际内容（供 `sliceSerialize` 提取） |
| `rubyAnnotationSequence` | 分隔符 `{` `}` 或 `^(` `)`                     |
| `rubyAnnotation`         | annotation 容器                                |
| `rubyAnnotationData`     | annotation 实际内容                            |

### 3.3 状态流转

```
start ──[──> textData ──字符──> textDataInner ──]──> textClose
                                                        │
                                          ┌─────────────┴──────────────┐
                                          ▼ {                          ▼ ^
                              annotationOpenCurly              afterText(caret)
                                          │                            │ (
                                          ▼ 字符                       ▼
                              annotationDataCurly ──}──>      hatStart → annotationDataParen
                                          │                            │
                                          ▼                            ▼ )
                              annotationCloseCurly → ok        annotationCloseParen → ok
```

`[文字]{注音}` 与 `[文字]^(注音)` 在 `afterText` 处分叉，共享前半段（`[...]` 的解析）。

### 3.4 关键踩坑：状态转移必须传递 `code`

第一版写成了 `return textClose`（返回状态函数本身），导致 micromark 报错：

```
Assertion: expected character to be consumed
```

**原因**：当一个状态函数**没有消费字符**就要把控制权交给下一个状态时，必须用 `return nextState(code)` 直接调用并传入当前 `code`，而不是 `return nextState`。后者会让 micromark 认为当前字符已被处理，但实际没消费，触发断言失败。

修复点（多处）：

- `textData` → `textClose(code)`
- `afterText` → `annotationOpenCurly(code)`
- `annotationDataCurly` → `annotationCloseCurly(code)`
- 等等，所有"不消费就转移"的地方都要传 `code`。

### 3.5 第二个踩坑：`^` 分支的 enter/exit 配对

`[漢字]^(かんじ)` 报了另一个断言：

```
Assertion: expected last token to be open
```

**原因**：`^` 分支最初把 `effects.enter('rubyAnnotationSequence')` 放在了 `hatStart` 里（即消费 `^` 之后才 enter），而 `^` 本身是用 `effects.consume` 消费的——consume 必须发生在一对 enter/exit 之间。

修复：在 `afterText` 里**先 enter sequence，再 consume `^`**，然后在 `hatStart` 消费 `(` 后统一 exit sequence：

```ts
if (code === codes.caret) {
  effects.enter('rubyAnnotationSequence') // 先开
  effects.consume(code) // 消费 ^
  return hatStart // hatStart 里消费 ( 后再 exit
}
```

### 3.6 流式友好的设计

注意到 `textData` / `annotationDataCurly` 等状态遇到 `eof`/`lf`/`cr` 都会 `nok` 回退。这意味着**未闭合**的 `[漢字]{かん`（流式中途）会被 micromark 判为非 Ruby，回退成普通文本。这个"缺陷"后续由预处理层 `fixRuby` 补偿（见第 7 节）。

## 4. 第二层：mdast from-markdown 扩展

**文件**：`packages/markmend/ast/src/extensions/ruby/from-markdown.ts`

把 micromark token 转成 mdast 节点。机制是注册 `enter`/`exit` handler，对应 token 类型：

```ts
export function rubyFromMarkdown(): Extension {
  return {
    enter: { ruby: enterRuby },
    exit: {
      rubyTextData: exitRubyTextData,
      rubyAnnotationData: exitRubyAnnotationData,
      ruby: exitRuby,
    },
  }
  // ...
}
```

- `enterRuby`：进入 `ruby` token 时，`this.enter()` 压入一个 `{ type: 'ruby', value: '', ruby: '', data: { hName: 'ruby' } }` 节点到栈。
- `exitRubyTextData`：用 `this.sliceSerialize(token)` 取出 base text 写入 `node.value`。
- `exitRubyAnnotationData`：取出 annotation 写入 `node.ruby`。
- `exitRuby`：`this.exit()` 弹栈。

注意节点用了 **flat 结构**（`value` + `ruby` 两个字符串字段），而不是 mdast 惯用的 `children`。因为 Ruby 的 base/annotation 是纯文本，不需要再递归解析内联语法，flat 更简单且利于流式拆分。

## 5. 第三层：mdast to-markdown 扩展

**文件**：`packages/markmend/ast/src/extensions/ruby/to-markdown.ts`

负责把 ruby 节点序列化回 markdown（`astToMarkdown` 用到，例如复制、调试）：

```ts
function ruby(node: Ruby): string {
  const text = node.value || ''
  const ruby = node.ruby || ''
  if (node.format === 'basic-hat' || ruby.includes('}')) {
    return `[${text}]^(${ruby})`
  }
  return `[${text}]{${ruby}}`
}
```

当 annotation 含 `}` 时自动改用 `^()` 写法避免歧义。

## 6. 第四 ~ 六层：类型注册与 Vue 渲染

### 6.1 类型声明（`types.ts`）

**文件**：`packages/markmend/ast/src/extensions/ruby/types.ts`

通过 TS 模块增强，把 `ruby` 注入 mdast 和 micromark 的类型表：

```ts
export interface Ruby extends Literal {
  type: 'ruby'
  value: string // base text
  ruby: string // annotation
  format?: 'basic' | 'basic-hat'
  data?: RubyData
}

declare module 'mdast' {
  interface PhrasingContentMap { ruby: Ruby }
  interface RootContentMap { ruby: Ruby }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    ruby: 'ruby'
    rubyText: 'rubyText'
    // ... 其余 5 种 token
  }
}
```

### 6.2 扩展注册（`constants.ts`）

把三个扩展挂进 `@markmend/ast` 的内置扩展表，并默认启用：

```ts
export const BUILTIN_MICROMARK_EXTENSIONS = {
  // ...
  ruby: () => rubySyntax(),
}
export const BUILTIN_FROM_MDAST_EXTENSIONS = {
  // ...
  rubyFromMarkdown: () => rubyFromMarkdown(),
}
export const BUILTIN_TO_MDAST_EXTENSIONS = {
  // ...
  rubyToMarkdown: () => rubyToMarkdown(),
}
```

因为走的是 `resolveBuiltinExtensions` 机制，用户可以通过 `mdastOptions.builtin.micromark.ruby: false` 等关闭它。

### 6.3 类型透传链

- `@markmend/ast/types.ts`：`export type RubyNode = Extract<ParsedNode, { type: 'ruby' }>`
- `@markmend/ast/index.ts`：`export * from './extensions/ruby'`
- `@stream-markdown/core` 的 `types/ast.ts`：透传 `RubyNode`
- `@stream-markdown/core` 的 `types/builtin.ts`：`BuiltinNodeRenderers` 联合类型加 `'ruby'`
- `vue` 的 `types/renderer.ts`：`export type RubyNodeRendererProps = NodeRendererProps<RubyNode>`

### 6.4 Vue renderer（`ruby.vue`）

**文件**：`packages/vue/src/components/renderers/ruby.vue`，并在 `NODE_RENDERERS` 里以 `defineAsyncComponent` 懒加载注册。

渲染逻辑复刻了原始 `marked` 实现的分隔符对齐算法：

- 无分隔符：整体一个 `<ruby>text<rt>annotation</rt></ruby>`
- 有分隔符：
  - `textChars.length >= rubyParts.length`：每个注音段默认对应 1 个字符，最后一段吃掉剩余所有字符
  - `textChars.length < rubyParts.length`：每字符对应一个注音段，多余注音忽略
- 所有动态内容经 `escapeHtml` 转义后再用 `v-html` 输出（防 XSS）

## 7. 流式渲染优化：消除闪烁跳动

这是用户反馈的第二个问题——**流式输入带分隔符的 Ruby 会频繁闪烁跳动**。

### 7.1 根因分析

两个独立原因叠加：

1. **分隔符拆分在流式期间不稳定**
   `ruby.vue` 一拿到 ruby 节点就按 `・．。-` 拆分 base/annotation。流式中 annotation 每多一个字符，拆分结果（分几组、每组对应几个字）就可能变化，导致 `<ruby>` DOM 结构被反复重建。

2. **Ruby 节点出现太晚**
   未闭合的 `[漢字]{かん`（还没输入 `}`）被 micromark 判为普通文本（见 3.6）。直到 `}` 到达才突然从"纯文本"变成"Ruby 节点"，产生一次明显的形态跳变。

### 7.2 解法一：流式期间不拆分

在 `ruby.vue` 中通过 `markdownParser.hasLoadingNode()` 判断是否仍在流式：

```ts
const isStreaming = computed(() => props.markdownParser.hasLoadingNode())
```

- 流式中（`isStreaming === true`）：始终 `renderSingleRuby`，渲染成单个 `<ruby>`，保留完整 annotation 字符串，**DOM 结构不随字符增长而变**。
- 流式结束后：才 `renderRuby` 按分隔符拆成多组。

这样把"结构会变"的拆分操作推迟到流结束，流式期间结构恒定。

### 7.3 解法二：提前产生 Ruby 节点（`fixRuby` 预处理）

**文件**：`packages/markmend/core/src/preprocess/ruby.ts`

新增预处理步骤，仅处理最后一段（流式只对最后一块跑 preprocess），把未闭合的 Ruby 临时补全，让它能被 micromark 解析成 Ruby 节点：

```ts
const rubyPattern = /\[[^\]]+\]\{[^}]*$/
const rubyHatPattern = /\[[^\]]+\]\^\([^)]*$/

export function fixRuby(content: string): string {
  const { lastParagraph } = getLastParagraphWithIndex(content, true)
  if (rubyPattern.test(lastParagraph)) {
    return `${content}}` // [漢字]{かん → [漢字]{かん}
  }
  if (rubyHatPattern.test(lastParagraph)) {
    return `${content})` // [漢字]^( → [漢字]^()
  }
  return content
}
```

并注册到默认预处理流水线（`packages/markmend/core/src/preprocess/index.ts`），排在 `math` 之后：

```ts
const DEFAULT_PREPROCESS_STEP_NAMES = [
  'code',
  'html',
  'footnote',
  'strong',
  'emphasis',
  'delete',
  'taskList',
  'link',
  'table',
  'inlineMath',
  'math',
  'ruby',
]
```

这与现有的 `fixStrong`/`fixEmphasis`/`fixInlineMath` 等流式补全步骤完全同构——它们都是"在流式期间临时闭合未完成的语法，避免视觉跳变"。

### 7.4 两个解法的配合

```
流式输入 "[漢字]{か"
  → fixRuby 补全为 "[漢字]{か}"
  → micromark 解析出 ruby 节点（value=漢字, ruby=か）
  → ruby.vue 检测到 isStreaming，渲染单个 <ruby>漢字<rt>か</rt></ruby>
继续输入 "[漢字]{か・ん・じ"
  → fixRuby 补全为 "[漢字]{か・ん・じ}"
  → ruby 节点 annotation = "か・ん・じ"
  → 仍是单个 <ruby>，只是 annotation 文本变长，DOM 结构不变 ✅
流结束 "[漢字]{か・ん・じ}"（无 loading 节点）
  → ruby.vue 切换到拆分模式，一次性渲染成 漢→か、字→ん・じ 等多组 <ruby>
```

从 `[漢字]{` 开始结构就稳定，直到全部输入完成才发生唯一一次形态切换。

## 8. 测试

**文件**：`test/markmend/ruby.test.ts`

覆盖三类场景：

| 类别   | 用例                                                     |
| ------ | -------------------------------------------------------- |
| 解析   | `[text]{ruby}`、`[text]^(ruby)` 正确解析为 ruby 节点     |
| 非干扰 | 普通链接 `[link](url)` 不被误判为 ruby                   |
| 序列化 | ruby 节点能 `astToMarkdown` 回 `[漢字]{かんじ}`          |
| 可关闭 | `mdastOptions.builtin` 关闭后退回纯文本                  |
| 流式   | 未闭合 `[漢字]{かん` 在 streaming 模式被解析为 ruby 节点 |
| 预处理 | `fixRuby` 直接调用 + `preprocess` 集成、仅处理最后一段   |

## 9. 文件清单

### 新增

| 文件                                                         | 职责                   |
| ------------------------------------------------------------ | ---------------------- |
| `packages/markmend/ast/src/extensions/ruby/syntax.ts`        | micromark tokenizer    |
| `packages/markmend/ast/src/extensions/ruby/from-markdown.ts` | token → mdast 节点     |
| `packages/markmend/ast/src/extensions/ruby/to-markdown.ts`   | mdast 节点 → markdown  |
| `packages/markmend/ast/src/extensions/ruby/types.ts`         | `Ruby` 类型 + 模块增强 |
| `packages/markmend/ast/src/extensions/ruby/index.ts`         | 统一导出               |
| `packages/markmend/core/src/preprocess/ruby.ts`              | `fixRuby` 流式补全     |
| `packages/vue/src/components/renderers/ruby.vue`             | Vue 渲染组件           |
| `test/markmend/ruby.test.ts`                                 | 测试                   |

### 修改

| 文件                                                         | 改动                                     |
| ------------------------------------------------------------ | ---------------------------------------- |
| `packages/markmend/ast/src/constants.ts`                     | 注册三个扩展                             |
| `packages/markmend/ast/src/types.ts`                         | `RubyNode` + Builtin\*Extension 联合类型 |
| `packages/markmend/ast/src/index.ts`                         | 导出 ruby 扩展                           |
| `packages/markmend/core/src/types.ts`                        | `PreprocessStepName` 加 `'ruby'`         |
| `packages/markmend/core/src/preprocess/index.ts`             | 注册 `fixRuby`                           |
| `packages/core/src/types/ast.ts`                             | 透传 `RubyNode`                          |
| `packages/core/src/types/builtin.ts`                         | `BuiltinNodeRenderers` 加 `'ruby'`       |
| `packages/vue/src/types/renderer.ts`                         | `RubyNodeRendererProps`                  |
| `packages/vue/src/components/renderers/index.ts`             | `NODE_RENDERERS` 注册                    |
| `pnpm-workspace.yaml` / `packages/markmend/ast/package.json` | 加 `micromark-util-symbol` 依赖          |

## 10. 经验总结

1. **先对标同构特性**：math 扩展是最好的参考样板，照着它的分层（syntax/from/to + 类型注册 + renderer）抄，少走弯路。
2. **micromark 状态机的两条铁律**：
   - 不消费字符就转移状态时，必须 `return nextState(code)` 传 `code`。
   - `effects.consume` 必须在一对 `enter`/`exit` 之间。
   - 这两条不遵守会触发 `devlop` 的断言，报错信息（"expected character to be consumed" / "expected last token to be open"）能精确定位问题。
3. **流式优化是两层协作**：
   - 解析层（`fixRuby`）让节点**提前稳定出现**；
   - 渲染层（`isStreaming` 分支）让 DOM **结构在流式期间保持恒定**。
   - 缺任何一层都还会跳动。
4. **复用基础设施**：走正统路线后，loading 状态、AST 缓存、块分片、`resolveBuiltinExtensions` 的可开关机制全都自动复用，无需额外造轮子。
5. **flat 节点 vs children 节点**：Ruby 的 base/annotation 是纯文本，用 flat 字段（`value`/`ruby`）比 mdast 惯用的 `children` 更简单，也更利于流式期间的"整体单 ruby"渲染。
