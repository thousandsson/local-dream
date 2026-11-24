// 主对话侧的记忆：照 RikkaHub 的两件事
//   1. 每轮 system prompt 里拼进 <memory_system>（profile / preferences 全文 + 其余文件清单 + 读写规则）
//   2. 主对话挂着 memory_read / write / str_replace / append / delete / list 六个工具，
//      用户明确要求「记住 / 忘掉」时当场就写；日常积累仍然交给后台的整理（做梦）
//
// 这里不 import @deepseek-ai/dsh-tools：本地插件跑在 profile 里解析不到引擎的包，
// 工具定义直接按注册表要求的结构手写（name / description / parameters / output / execute）。
import { listFiles, rebuildIndexes } from './memory-store.mjs'
import { buildMemoryPrompt } from './prompts.mjs'
import { TOOL_NAMES, executeMemoryTool, WRITE_TOOLS } from './tools.mjs'

// 插在工具提示词之后、环境信息（order 10000）之前
const MEMORY_SECTION_ORDER = 5000

const IF_VERSION_DESCRIPTION = 'The version returned by the most recent read or write of this file'

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

function tool(name, description, properties, required) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: true },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textRender(value ?? {}),
    },
    // 记忆读写不是无状态操作：同一批里顺序执行，避免版本互相踩
    isConcurrencySafe: () => false,
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const result = toValue(executeMemoryTool(name, input))
      // 写完同步重建索引，免得 MEMORY.md 和实际记忆块不一致
      if (WRITE_TOOLS.has(name) && !result.error) {
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
  return [
    tool(
      TOOL_NAMES.READ,
      "Read one or more memory files. Returns each file's content and version.",
      {
        path: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Paths of the files to read, e.g. ["/topics/food.md"]',
        },
      },
      ['path']
    ),
    tool(
      TOOL_NAMES.WRITE,
      'Create a memory file or overwrite it entirely. content is the complete file; lines not included are removed.\n' +
        'if_version: pass "new" for a new file, or the version returned by the most recent read or write of an existing file.',
      {
        path: { type: 'string', description: 'Path of the file, e.g. /topics/food.md' },
        content: { type: 'string', description: 'The complete file content' },
        if_version: { type: 'string', description: '"new" for a new file, otherwise the file\'s current version' },
      },
      ['path', 'content', 'if_version']
    ),
    tool(
      TOOL_NAMES.STR_REPLACE,
      'Replace the single occurrence of old_str in a memory file with new_str. An empty new_str deletes it.\n' +
        'Rejected when old_str matches zero or several places.',
      {
        path: { type: 'string', description: 'Path of the file' },
        old_str: { type: 'string', description: 'Text to replace; must match exactly one place' },
        new_str: { type: 'string', description: 'Replacement text; empty to delete' },
        if_version: { type: 'string', description: IF_VERSION_DESCRIPTION },
      },
      ['path', 'old_str', 'new_str', 'if_version']
    ),
    tool(
      TOOL_NAMES.APPEND,
      'Append one line to the end of a memory file.',
      {
        path: { type: 'string', description: 'Path of the file' },
        content: { type: 'string', description: 'The line to append' },
        if_version: { type: 'string', description: IF_VERSION_DESCRIPTION },
      },
      ['path', 'content', 'if_version']
    ),
    tool(
      TOOL_NAMES.DELETE,
      'Delete an entire memory file. Only use when the user explicitly asks to forget a whole topic.',
      {
        path: { type: 'string', description: 'Path of the file' },
        if_version: { type: 'string', description: IF_VERSION_DESCRIPTION },
      },
      ['path', 'if_version']
    ),
    tool(
      TOOL_NAMES.LIST,
      'List memory files (path, size, update time), optionally filtered by path prefix.',
      { path_prefix: { type: 'string', description: 'Only list files whose path starts with this, e.g. /people/' } },
      []
    ),
  ]
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
