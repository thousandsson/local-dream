// 读 DSH 的会话日志，算出「上次整理之后新增的轮次」。
// 算法照搬 RikkaHub 的 MemoryConsolidator（pendingMemoryTurns / initialMemoryProgress）：
//   - 一轮 = 一条用户消息 + 它之后直到下一条用户消息之前的所有回复
//   - 进度按用户消息的时间记，重新生成回复不会重复整理
//   - 只回看最近 12 轮、最多 8 段对话、转写合计 6 万字，7 天前的对话不再补整理
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { SESSIONS_ROOT as SESSIONS, MEMORY_DIR, WORKSPACE } from './paths.mjs'

export const SESSIONS_ROOT = SESSIONS
export const LEDGER = `${MEMORY_DIR}/.consolidation.json`

const MAX_CONVERSATIONS_PER_RUN = 8
const MAX_SCANNED_CONVERSATIONS = 50
const MAX_TURNS_PER_CONVERSATION = 12
const MAX_TRANSCRIPT_LENGTH = 60_000
const RECENT_CONTEXT_MESSAGES = 6
const RECENT_CONTEXT_MESSAGE_LENGTH = 500
const USER_MESSAGE_LENGTH = 8000
const ASSISTANT_MESSAGE_LENGTH = 2000
const PENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// 插件自己开的「做梦」会话不整理：里面的用户消息是定时器的指令，不是主人说的话
const SELF_SESSION_RE = /加载 dream 技能|做一次记忆整合与做梦/

function textOf(content) {
  const parts = Array.isArray(content) ? content : []
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()
}

function readSessionFile(file) {
  const buf = fs.readFileSync(file)
  const raw = zlib.zstdDecompressSync(buf).toString('utf8')
  const records = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      records.push(JSON.parse(text))
    } catch {
      // 半行/坏行跳过
    }
  }
  return records
}

function sessionFiles() {
  const out = []
  if (!fs.existsSync(SESSIONS_ROOT)) return out
  for (const workspace of fs.readdirSync(SESSIONS_ROOT)) {
    const dir = path.join(SESSIONS_ROOT, workspace)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const session of fs.readdirSync(dir)) {
      const sessionDir = path.join(dir, session)
      if (!fs.statSync(sessionDir).isDirectory()) continue
      for (const name of fs.readdirSync(sessionDir)) {
        if (name.endsWith('.jsonl.zstd')) out.push(path.join(sessionDir, name))
      }
    }
  }
  return out
}

/** 把一份会话日志变成 {id, title, updateAt, messages} */
function parseSession(file) {
  let records
  try {
    records = readSessionFile(file)
  } catch {
    return null
  }
  const session = records.find((r) => r.type === 'session')
  if (!session) return null
  // 只整理主对话；子代理会话和别的项目的会话不碰
  if (typeof session.cwd === 'string' && WORKSPACE && !session.cwd.startsWith(WORKSPACE)) return null
  // 子代理会话不是主人在说话
  if (Number(session.delegationDepth || 0) > 0) return null

  let title = ''
  const messages = []
  const toolResults = new Set()
  const pendingCalls = new Map()

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.type === 'session/title' && rec.data && typeof rec.data.title === 'string') {
      title = rec.data.title
      continue
    }
    if (rec.type === 'user/message') {
      const msg = rec.data?.message || rec.data
      const kind = msg?.source?.kind
      if (kind !== 'user') continue
      const text = textOf(msg.content)
      if (!text) continue
      messages.push({ role: 'user', text, time: rec.time || 0 })
      continue
    }
    if (rec.type === 'assistant/message') {
      const msg = rec.data?.message
      if (!msg) continue
      const text = textOf(msg.content)
      const calls = (msg.content || [])
        .filter((p) => p && p.type === 'tool-call')
        .map((p) => ({
          id: p.id || p.callId || p.toolCallId || '',
          name: p.name || '',
          args: p.arguments ?? p.args ?? p.input ?? '',
        }))
        .filter((c) => c.id)
      for (const call of calls) pendingCalls.set(call.id, call)
      if (!text && !calls.length) continue
      messages.push({ role: 'assistant', text, time: rec.time || 0, calls })
      continue
    }
    if (rec.type === 'tool/result') {
      const callId = rec.data?.message?.toolCallId || rec.data?.toolCallId
      if (callId) toolResults.add(callId)
    }
  }

  if (!messages.length) return null
  const firstUser = messages.find((m) => m.role === 'user')
  if (firstUser && SELF_SESSION_RE.test(firstUser.text)) return null

  const st = fs.statSync(file)
  const lastTime = messages[messages.length - 1].time || 0
  return {
    id: session.id || path.basename(path.dirname(file)),
    title: title || firstUser.text.slice(0, 24),
    updateAt: Math.max(st.mtimeMs, lastTime),
    createdAt: session.createdAt || messages[0].time || 0,
    messages,
    toolResults,
    pendingCalls,
  }
}

/** 全部可整理的主对话，按更新时间从新到旧 */
export function loadConversations() {
  const conversations = []
  for (const file of sessionFiles()) {
    try {
      const conv = parseSession(file)
      if (conv) conversations.push(conv)
    } catch {
      // 单个会话读坏了不影响别的
    }
  }
  return conversations.sort((a, b) => b.updateAt - a.updateAt)
}

function isFinishedTurn(conv, turnMessages) {
  const last = turnMessages[turnMessages.length - 1]
  if (!last || last.role !== 'assistant') return false
  for (const msg of turnMessages) {
    for (const call of msg.calls || []) {
      if (!conv.toolResults.has(call.id)) return false
    }
  }
  return true
}

/** 一轮对话：一条用户消息和它之后直到下一条用户消息之前的回复 */
export function turnsOf(conv) {
  const messages = conv.messages
  const starts = []
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') starts.push(i)
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : messages.length
    const turnMessages = messages.slice(start, end)
    const userMessage = turnMessages[0]
    const position = start
    return {
      messages: turnMessages,
      position,
      userMessage,
      hasUserText: Boolean(userMessage.text.trim()),
      isFinished: isFinishedTurn(conv, turnMessages),
    }
  })
}

/** 第一次跟踪一个对话时的进度：只回看最近 12 轮 */
export function initialMemoryProgress(conv) {
  const turns = turnsOf(conv).filter((t) => t.hasUserText)
  const first = turns.slice(-MAX_TURNS_PER_CONVERSATION)[0]
  return first ? first.userMessage.time - 1 : 0
}

function timeOf(message) {
  return Number(message.time || 0)
}

/** 从对话里找出 consolidatedAt 之后新增的轮次 */
export function pendingMemoryTurns(conv, consolidatedAt) {
  const turns = turnsOf(conv)
  let pending = turns.filter((t) => timeOf(t.userMessage) > consolidatedAt)
  let consolidatedThrough = Math.max(
    Number(conv.updateAt || 0),
    turns.length ? timeOf(turns[turns.length - 1].messages.slice(-1)[0]) : 0
  )

  const last = turns[turns.length - 1]
  if (last && !last.isFinished) {
    // 最后一轮还没结束：留到下次，进度停在它前面
    pending = pending.filter((t) => t !== last)
    consolidatedThrough = timeOf(last.userMessage) - 1
  }

  pending = pending.filter((t) => t.hasUserText)
  const batch = pending.slice(0, MAX_TURNS_PER_CONVERSATION)
  if (batch.length) {
    const batchEnd = timeOf(batch[batch.length - 1].userMessage)
    const next = pending.slice(batch.length).find((t) => timeOf(t.userMessage) > batchEnd)
    if (next) consolidatedThrough = timeOf(next.userMessage) - 1
    consolidatedThrough = Math.max(consolidatedThrough, batchEnd)
  }

  return {
    turns: batch,
    totalTurns: pending.length,
    consolidatedThrough: consolidatedThrough > consolidatedAt ? consolidatedThrough : null,
  }
}

function truncate(text, limit) {
  const trimmed = String(text || '').trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) + '...' : trimmed
}

/** 转成给整理器看的文本，每条消息带上位置编号；对话里按用户要求改过的记忆单独标一行 */
export function toMemoryTranscript(indexedMessages) {
  const lines = []
  for (const { position, message } of indexedMessages) {
    const limit = message.role === 'user' ? USER_MESSAGE_LENGTH : ASSISTANT_MESSAGE_LENGTH
    const text = truncate(message.text, limit)
    if (text) lines.push(`[${String(message.role).toUpperCase()} #${position}]: ${text}`)
    for (const call of message.calls || []) {
      const marker = memoryWriteMarker(call)
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

// 主对话里真正写记忆的工具；对话中已经做过的修改，整理器不要再做一遍
const MEMORY_WRITE_TOOLS = new Set(['memory_write', 'memory_str_replace', 'memory_append', 'memory_delete'])

function memoryWriteMarker(call) {
  if (!call || !MEMORY_WRITE_TOOLS.has(call.name)) return ''
  const args = parseArgs(call.args)
  const target = typeof args?.path === 'string' ? args.path : ''
  return target ? `[assistant updated memory: ${call.name} ${target}]` : ''
}

function parseArgs(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

/** 一段对话交给整理器的输入（新轮次 + 之前的最近 6 条上下文） */
export function conversationInput(conv, pending) {
  const firstPosition = pending.turns[0]?.position ?? conv.messages.length
  const context = conv.messages
    .map((message, position) => ({ position, message }))
    .filter(({ position }) => position < firstPosition)
    .slice(-RECENT_CONTEXT_MESSAGES)
    .map(({ position, message }) => ({ position, message: { ...message, text: truncate(message.text, RECENT_CONTEXT_MESSAGE_LENGTH) } }))
  const newTurns = pending.turns.flatMap((turn) =>
    turn.messages.map((message, offset) => ({ position: turn.position + offset, message }))
  )
  return {
    id: conv.id,
    title: conv.title,
    recentContext: toMemoryTranscript(context),
    newTurns: toMemoryTranscript(newTurns),
  }
}

// 超出的对话留在待整理里；至少带上一个
function withinTranscriptBudget(batches) {
  let length = 0
  const kept = []
  batches.slice(0, MAX_CONVERSATIONS_PER_RUN).forEach((batch, index) => {
    length += batch.input.newTurns.length
    if (index === 0 || length <= MAX_TRANSCRIPT_LENGTH) kept.push(batch)
  })
  return kept
}

/** 收集待整理的对话批次：最多 8 段，每段最多 12 轮 */
export function findPendingBatches(conversations, ledger, now = Date.now()) {
  const candidates = conversations
    .filter((conv) => Number(conv.updateAt || 0) >= now - PENDING_WINDOW_MS)
    .slice(0, MAX_SCANNED_CONVERSATIONS)
  const batches = []
  for (const conv of candidates) {
    if (batches.length >= MAX_CONVERSATIONS_PER_RUN) break
    const consolidatedAt =
      ledger.conversations[conv.id] ?? (ledger.conversations[conv.id] = initialMemoryProgress(conv))
    const pending = pendingMemoryTurns(conv, consolidatedAt)
    if (!pending.turns.length) {
      if (pending.consolidatedThrough != null) ledger.conversations[conv.id] = pending.consolidatedThrough
      continue
    }
    batches.push({ conversation: conv, pending, input: conversationInput(conv, pending) })
  }
  return withinTranscriptBudget(batches)
}

/** 只统计待整理轮数（面板状态用） */
export function countPendingTurns(conversations, ledger, now = Date.now()) {
  let turns = 0
  const candidates = conversations
    .filter((conv) => Number(conv.updateAt || 0) >= now - PENDING_WINDOW_MS)
    .slice(0, MAX_SCANNED_CONVERSATIONS)
  for (const conv of candidates) {
    const consolidatedAt =
      ledger.conversations[conv.id] ?? (ledger.conversations[conv.id] = initialMemoryProgress(conv))
    turns += pendingMemoryTurns(conv, consolidatedAt).totalTurns
  }
  return turns
}

/** 今天的对话摘要，给梦境正文用 */
export function todayDigest(conversations, date) {
  const start = new Date(`${date}T00:00:00+08:00`).getTime()
  const end = start + 24 * 60 * 60 * 1000
  const parts = []
  for (const conv of conversations.slice(0, MAX_SCANNED_CONVERSATIONS)) {
    for (const message of conv.messages) {
      if (message.time < start || message.time >= end) continue
      const text = truncate(message.text, message.role === 'user' ? 600 : 300)
      if (text) parts.push(`[${message.role}] ${text}`)
    }
  }
  return parts.join('\n').slice(-20000)
}

// ---------- 进度表 ----------

export function loadLedger() {
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
    if (data && typeof data === 'object' && data.conversations && typeof data.conversations === 'object') {
      return { v: 1, conversations: data.conversations }
    }
  } catch {
    // 没有进度表就从空开始
  }
  return { v: 1, conversations: {} }
}

export function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  const conversations = {}
  for (const [id, at] of Object.entries(ledger.conversations)) {
    conversations[id] = Math.round(Number(at) || 0)
  }
  const tmp = `${LEDGER}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, conversations }), 'utf8')
  fs.renameSync(tmp, LEDGER)
}

export { MAX_CONVERSATIONS_PER_RUN, MAX_TURNS_PER_CONVERSATION }
