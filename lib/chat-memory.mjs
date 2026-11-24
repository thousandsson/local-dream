// 主对话侧的记忆：照 RikkaHub 的两件事
//   1. 每轮 system prompt 里拼进 <memory_system>（profile / preferences 全文 + 其余文件清单 + 读写规则）
//   2. 主对话挂着 memory_read / write / str_replace / append / delete / list 六个工具，
//      用户明确要求「记住 / 忘掉」时当场就写；日常积累仍然交给后台的整理（做梦）
//
// 这里不 import @deepseek-ai/dsh-tools：本地插件跑在 profile 里解析不到引擎的包，
// 工具定义按注册表要求的结构手写；名字、描述、参数结构统一从 tools.mjs 取，不再重复一份。
import { listFiles, rebuildIndexes } from './memory-store.mjs'
import { buildMemoryPrompt } from './prompts.mjs'
import { MEMORY_TOOL_SPECS, WRITE_TOOLS, executeMemoryTool } from './tools.mjs'

// 插在工具提示词之后、环境信息（order 10000）之前
const MEMORY_SECTION_ORDER = 5000

function toValue(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : { result: parsed }
  } catch {
    return { error: String(text) }
  }
}

/** 工具结果统一转成文本给模型看；界面上不额外渲染 */
function textRender(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 把权威定义包成引擎注册表要的形状 */
function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: spec.parameters,
      required: spec.required,
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textRender(value ?? {}),
    },
    // 记忆读写不是无状态操作：同一批里顺序执行，避免版本互相踩
    isConcurrencySafe: () => false,
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const result = toValue(executeMemoryTool(spec.name, input))
      // 写完同步重建索引，免得 MEMORY.md 和实际记忆块不一致
      if (WRITE_TOOLS.has(spec.name) && !result.error) {
        try {
          rebuildIndexes()
        } catch {
          // 索引重建失败不影响这次写入
        }
      }
      return result
    },
  }
}

function buildToolDefinitions() {
  return MEMORY_TOOL_SPECS.map(tool)
}

/**
 * 注册主对话侧的记忆：工具 + system prompt 片段。
 * 插件在 profile 的 Cordis 容器里运行，tools / systemPrompt 都是宿主平面的服务，
 * 用 inject 等它们就绪；任一服务缺失时这部分功能自动不生效，不影响面板和后台做梦。
 */
export function registerChatMemory(ctx) {
  ctx.inject(['tools'], (tctx) => {
    for (const definition of buildToolDefinitions()) tctx.tools.register(definition)
  })

  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({
      name: 'memory:store',
      order: MEMORY_SECTION_ORDER,
      // 记忆正文里可能有 {{ }}，不能当提示词变量插值
      interpolate: false,
      text: () => buildMemoryPrompt(listFiles()),
    })
  })
}
