// 后台整理器附带的对话查询工具，照 RikkaHub 的 ConversationTools.kt（createMemoryConversationTools）：
//   - conversation_search：在主人的历史对话里全文搜索，用来确认某个偏好是不是以前提过
//   - conversation_read：按位置读一整段对话，用来补看被截断的消息
const READ_DEFAULT_LIMIT = 20
const READ_MAX_LIMIT = 40
const READ_MESSAGE_LENGTH = 12_000
const SEARCH_DEFAULT_LIMIT = 15
const SEARCH_MAX_LIMIT = 50

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }
}

const dateOf = (ms) => new Date(Number(ms) || 0).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

function snippetAround(text, terms, radius = 60) {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0) return text.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius * 2)
  let snippet = text.slice(start, end)
  for (const term of terms) {
    snippet = snippet.replace(new RegExp(escapeRegExp(term), 'gi'), (m) => `[${m}]`)
  }
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '')
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 给模型看的对话查询工具；conversations 是本次读取到的全部主对话 */
export function buildConversationTools(conversations) {
  return [
    fn(
      'conversation_search',
      'Full-text search across the user\'s past conversations to recall specific information they mentioned before.\n' +
        'Use focused keywords. Run multiple searches with different keywords if needed.\n' +
        'Each result includes the conversation title, a snippet with matched keywords wrapped in [brackets], and the date.',
      {
        query: { type: 'string', description: 'Keywords to search for in past conversation messages' },
        limit: {
          type: 'integer',
          description: `Maximum number of results to return (default: ${SEARCH_DEFAULT_LIMIT}, max: ${SEARCH_MAX_LIMIT})`,
        },
      },
      ['query']
    ),
    fn(
      'conversation_read',
      'Read the messages of one conversation in full, by position.\n' +
        'Use it when a message you were given was cut off, or a search snippet needs its surrounding context.\n' +
        'Positions are the #numbers shown next to each message.',
      {
        conversation_id: { type: 'string', description: 'Id of the conversation' },
        offset: { type: 'integer', description: 'Position of the first message to return (default: 0)' },
        limit: {
          type: 'integer',
          description: `Maximum number of messages to return (default: ${READ_DEFAULT_LIMIT}, max: ${READ_MAX_LIMIT})`,
        },
      },
      ['conversation_id']
    ),
  ]
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 执行对话查询工具，返回给模型的 JSON 字符串 */
export function executeConversationTool(name, args, conversations) {
  const input = typeof args === 'string' ? safeJson(args) : args || {}
  if (name === 'conversation_read') {
    const conv = conversations.find((c) => c.id === input.conversation_id)
    if (!conv) return JSON.stringify({ error: 'conversation not found' })
    const offset = Math.max(0, Number(input.offset) || 0)
    const limit = Math.min(READ_MAX_LIMIT, Math.max(1, Number(input.limit) || READ_DEFAULT_LIMIT))
    return JSON.stringify({
      title: conv.title || 'Untitled',
      total: conv.messages.length,
      messages: conv.messages.slice(offset, offset + limit).map((message, index) => ({
        position: offset + index,
        role: String(message.role).toUpperCase(),
        date: dateOf(message.time),
        text: String(message.text || '').slice(0, READ_MESSAGE_LENGTH),
      })),
    })
  }
  if (name === 'conversation_search') {
    const raw = String(input.query || '').trim()
    if (!raw) return JSON.stringify({ error: 'query is required' })
    const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Number(input.limit) || SEARCH_DEFAULT_LIMIT))
    const terms = raw
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
    if (!terms.length) return JSON.stringify({ error: 'query is required' })
    const hits = []
    for (const conv of conversations) {
      for (const message of conv.messages) {
        const text = String(message.text || '')
        const lower = text.toLowerCase()
        let score = 0
        for (const term of terms) {
          let at = lower.indexOf(term)
          while (at >= 0) {
            score++
            at = lower.indexOf(term, at + term.length)
          }
        }
        if (score <= 0) continue
        hits.push({
          conversation_id: conv.id,
          title: conv.title || 'Untitled',
          snippet: snippetAround(text, terms),
          date: dateOf(message.time),
          score,
        })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    const results = []
    const seen = new Set()
    for (const hit of hits) {
      const key = `${hit.conversation_id}:${hit.snippet}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({
        conversation_id: hit.conversation_id,
        title: hit.title,
        snippet: hit.snippet,
        date: hit.date,
      })
      if (results.length >= limit) break
    }
    return JSON.stringify(results)
  }
  return JSON.stringify({ error: `unknown tool ${name}` })
}
