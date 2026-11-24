// 后台做梦（记忆整理）：照 RikkaHub 的 MemoryConsolidator 走一个带记忆工具的 agent，
// 由模型自己决定「这条事实写进哪个块」，最多 32 步；写完记忆再写当天的梦境、重建索引、同步云端。
//
// 这个进程由插件在后台 spawn，不打开任何对话。用法：
//   node worker.mjs --auto     聊天停下来后自动整理（只增改，不删文件）
//   node worker.mjs --manual   面板上点「立即做梦」：先把待整理的对话处理完，再全库清理一遍
//   node worker.mjs --dream    每晚定时：自动整理 + 写一篇梦境
//   node worker.mjs --check    只算待整理轮数，不调模型
//   node worker.mjs --dry-run  打印这次会整理哪些对话，不写任何东西
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  MEMORY_DIR,
  BLOCKS,
  MEM_INDEX,
  listFiles,
  rebuildIndexes,
  memoryTitleOf,
  writeFileAtomic,
  findForbiddenMemoryContent,
} from './memory-store.mjs'
import {
  buildMemoryConsolidationPrompt,
  buildMemoryConsolidationInput,
  buildDreamPrompt,
  buildDreamInput,
} from './prompts.mjs'
import {
  loadConversations,
  findPendingBatches,
  countPendingTurns,
  loadLedger,
  saveLedger,
  todayDigest,
} from './conversations.mjs'
import { buildMemoryTools, executeMemoryTool, memoryWritePath } from './tools.mjs'
import { isAllowedApiUrl } from './security.mjs'
import { buildConversationTools, executeConversationTool } from './conversation-tools.mjs'
import { CREDENTIALS_FILE as CREDENTIALS, SYNC_TARGET } from './paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KEY_FILE = path.join(HERE, '..', '.key')
const LOG = path.join(MEMORY_DIR, 'dream.log')
const STATUS = path.join(MEMORY_DIR, '.dream-state.json')
const LOCK = path.join(MEMORY_DIR, '.dream.lock')
const DREAMS = path.join(MEMORY_DIR, 'dreams')
const BACKUPS = path.join(MEMORY_DIR, 'backups')

const MAX_STEPS = 32
const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'
const CONFIG_FILE = path.join(MEMORY_DIR, '.dream-config.json')
const LOCK_STALE_MS = 30 * 60 * 1000
const LOCK_HEARTBEAT_MS = 60 * 1000
let warnedBadApiUrl = false
// 模型调用失败的重试：429 / 5xx / 网络错误重试，认证错误直接失败
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 1500
const RETRY_MAX_MS = 20_000

const mode = (process.argv[2] || '--auto').replace(/^--/, '')
const DRY_RUN = mode === 'dry-run'

function log(message) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS, 'utf8'))
  } catch {
    return {}
  }
}

function writeStatus(patch) {
  const next = { ...readStatus(), ...patch, v: 1, updatedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(STATUS), { recursive: true })
  writeFileAtomic(STATUS, JSON.stringify(next, null, 1))
  return next
}

function readKey() {
  try {
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim()
    if (key) return key
  } catch {
    // 没有独立 key 文件
  }
  try {
    const text = fs.readFileSync(CREDENTIALS, 'utf8')
    const m = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
    if (m && m[1]) return m[1].trim()
  } catch {
    // 凭据文件读不到
  }
  return process.env.DEEPSEEK_API_KEY || ''
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
    return true
  } catch {
    try {
      const holder = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
      const stale = !pidAlive(holder.pid) || Date.now() - Number(holder.at || 0) > LOCK_STALE_MS
      if (!stale) return false
      fs.rmSync(LOCK, { force: true })
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }
}

let lockHeartbeat = null

/** 长时间整理时定期续期，避免活着的进程被别的工作者当成过期锁抢走 */
function startLockHeartbeat() {
  if (lockHeartbeat) return
  lockHeartbeat = setInterval(() => {
    try {
      const holder = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
      if (holder.pid !== process.pid) return
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
    } catch {
      // 锁已经没了，不再续期
    }
  }, LOCK_HEARTBEAT_MS)
  lockHeartbeat.unref?.()
}

function stopLockHeartbeat() {
  if (!lockHeartbeat) return
  clearInterval(lockHeartbeat)
  lockHeartbeat = null
}

function releaseLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    if (holder.pid === process.pid) fs.rmSync(LOCK, { force: true })
  } catch {
    // 锁已经没了
  }
}

/**
 * 记忆整理用的模型配置，写在 memory/.dream-config.json，例如：
 *   {
 *     "model": "deepseek-reasoner",
 *     "models": ["deepseek-reasoner", "deepseek-chat"],
 *     "api_url": "https://api.deepseek.com/chat/completions",
 *     "reasoning_effort": "high"
 *   }
 * models 是回退链：前一个模型报错（模型不存在、参数不支持）就换下一个，全挂了才抛错。
 * 没写就用 DeepSeek 的默认对话模型；读坏了也退回默认，不影响做梦。
 */
function readModelConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const models = Array.isArray(data?.models)
      ? data.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim())
      : []
    if (typeof data?.model === 'string' && data.model.trim()) models.unshift(data.model.trim())
    const apiUrl = typeof data?.api_url === 'string' && isAllowedApiUrl(data.api_url) ? data.api_url.trim() : API_URL
    if (typeof data?.api_url === 'string' && data.api_url.trim() && apiUrl === API_URL && !warnedBadApiUrl) {
      warnedBadApiUrl = true
      log('自定义 api_url 不是 HTTPS（本地地址除外），已改用默认地址，避免把 key 发给不可信服务器')
    }
    const reasoningEffort =
      typeof data?.reasoning_effort === 'string' && data.reasoning_effort.trim() ? data.reasoning_effort.trim() : null
    return {
      models: models.length ? [...new Set(models)] : [MODEL],
      apiUrl,
      reasoningEffort,
    }
  } catch {
    return { models: [MODEL], apiUrl: API_URL, reasoningEffort: null }
  }
}

class ApiError extends Error {
  constructor(message, { status = 0, retryAfterMs = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Retry-After 可能是秒数，也可能是 HTTP 日期 */
function parseRetryAfter(value) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/** 模型不存在 / 参数不支持这类错误才换下一个模型 */
function isModelLevelError(error) {
  return [400, 404, 422].includes(Number(error?.status))
}

/** key 不对就别重试了，直接报错 */
function isAuthError(error) {
  return [401, 403].includes(Number(error?.status))
}

/** 限流、服务端错误、断网 / 超时才值得重试 */
function isRetryable(error) {
  const status = Number(error?.status || 0)
  if (status === 429 || status >= 500) return true
  if (status) return false
  return ['TypeError', 'AbortError', 'FetchError'].includes(String(error?.name))
}

function retryDelay(error, attempt) {
  const server = Number(error?.retryAfterMs)
  if (Number.isFinite(server) && server > 0) return Math.min(server, 60_000)
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function chatOnce(key, model, config, messages, tools) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const body = {
      model,
      temperature: 0.3,
      max_tokens: 8000,
      messages,
    }
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort
    if (tools && tools.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    const res = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new ApiError(`API ${res.status}: ${(await res.text()).slice(0, 300)}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      })
    }
    const data = await res.json()
    const message = data?.choices?.[0]?.message
    if (!message) throw new Error('API 没有返回 message')
    return { message, usage: data.usage, model }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调一次模型：429 / 5xx / 网络错误按指数退避重试（429 遵守 Retry-After），
 * key 错误直接抛，模型不存在或参数不支持时换回退链里的下一个模型。
 * 重试用尽仍然失败就抛出去，整理进度不会推进，下次触发连同新轮次一起重来。
 */
async function chat(key, messages, tools) {
  const config = readModelConfig()
  let lastError
  for (const [index, model] of config.models.entries()) {
    const isLastModel = index === config.models.length - 1
    for (let attempt = 0; ; attempt++) {
      try {
        return await chatOnce(key, model, config, messages, tools)
      } catch (error) {
        lastError = error
        if (isAuthError(error)) throw error
        if (isRetryable(error) && attempt < MAX_ATTEMPTS - 1) {
          const wait = retryDelay(error, attempt)
          log(`模型 ${model} 调用失败（${error.message}），${Math.round(wait / 1000)}s 后重试 ${attempt + 1}/${MAX_ATTEMPTS - 1}`)
          await sleep(wait)
          continue
        }
        break
      }
    }
    if (isLastModel) throw lastError
    if (isModelLevelError(lastError) || isRetryable(lastError)) {
      log(`模型 ${model} 不可用，回退到 ${config.models[index + 1]}：${lastError.message}`)
      continue
    }
    throw lastError
  }
  throw lastError
}

/** 带记忆工具的整理 agent：最多 32 步 */
async function runConsolidationAgent(key, files, conversations, fullReview, allConversations) {
  const system = buildMemoryConsolidationPrompt(fullReview)
  const input = buildMemoryConsolidationInput(files, conversations)
  const tools = [...buildMemoryTools(fullReview), ...buildConversationTools(allConversations)]
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: input },
  ]
  const touched = []
  let summary = ''
  let steps = 0
  let finishReason = 'stop'
  let promptTokens = 0
  let completionTokens = 0
  const modelsUsed = new Set()

  for (let step = 0; step < MAX_STEPS; step++) {
    steps = step + 1
    const { message, usage, model } = await chat(key, messages, tools)
    if (model) modelsUsed.add(model)
    if (usage) {
      promptTokens += usage.prompt_tokens || 0
      completionTokens += usage.completion_tokens || 0
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (!toolCalls.length) {
      summary = (message.content || '').trim().split('\n')[0].slice(0, 120)
      finishReason = 'stop'
      break
    }
    messages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function?.name, arguments: call.function?.arguments || '{}' },
      })),
    })
    for (const call of toolCalls) {
      const name = call.function?.name || ''
      const args = call.function?.arguments || '{}'
      let result
      try {
        result = name.startsWith('conversation_')
          ? executeConversationTool(name, args, allConversations)
          : executeMemoryTool(name, args)
      } catch (e) {
        result = JSON.stringify({ error: e.message })
      }
      const touchedPath = memoryWritePath(name, result)
      if (touchedPath) touched.push(touchedPath)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
    if (step === MAX_STEPS - 1) finishReason = 'step_limit'
  }

  return {
    summary,
    steps,
    finishReason,
    touched,
    promptTokens,
    completionTokens,
    models: [...modelsUsed],
  }
}

/** 写当天的梦境（插件额外功能，不是 RikkaHub 的一部分） */
async function writeDream(key, files, digest) {
  const date = today()
  const { message, usage, model } = await chat(
    key,
    [
      { role: 'system', content: buildDreamPrompt() },
      { role: 'user', content: buildDreamInput(files, digest) },
    ],
    null
  )
  const dream = (message.content || '').trim()
  if (!dream) return null
  // 梦境也是用户数据落盘，同样过一遍敏感内容兜底
  const forbidden = findForbiddenMemoryContent(dream)
  if (forbidden) {
    log(`梦境里出现 ${forbidden}，这次不写梦`)
    return null
  }
  fs.mkdirSync(DREAMS, { recursive: true })
  const file = path.join(DREAMS, `${date}.md`)
  fs.writeFileSync(file, `# ${date}\n\n> 记下今天最值得留下的三件事。\n\n${dream}\n`, 'utf8')
  return { date, dream, usage, model }
}

function backupBlocks(date) {
  try {
    fs.mkdirSync(BACKUPS, { recursive: true })
    const dir = path.join(BACKUPS, `blocks-${date}-${Date.now()}`)
    if (fs.existsSync(BLOCKS)) fs.cpSync(BLOCKS, dir, { recursive: true })
    // 只留最近 20 份
    const old = fs
      .readdirSync(BACKUPS)
      .filter((name) => name.startsWith('blocks-'))
      .sort()
    for (const name of old.slice(0, Math.max(0, old.length - 20))) {
      fs.rmSync(path.join(BACKUPS, name), { recursive: true, force: true })
    }
  } catch (e) {
    log(`备份失败：${e.message}`)
  }
}

// 可选的异地同步：设置 DSH_DREAM_SYNC_TARGET（rclone 目标，如 "koofr:backup"）才启用
function syncRemote(date) {
  if (!SYNC_TARGET) return
  try {
    execFileSync('rclone', ['copy', BLOCKS, `${SYNC_TARGET}/memory/blocks`], { timeout: 120_000 })
    execFileSync('rclone', ['copyto', MEM_INDEX, `${SYNC_TARGET}/MEMORY.md`], { timeout: 120_000 })
    execFileSync('rclone', ['copy', DREAMS, `${SYNC_TARGET}/memory/dreams`], { timeout: 120_000 })
    log(`${date} 已同步到 ${SYNC_TARGET}`)
  } catch (e) {
    log(`${date} 同步失败：${e.message}`)
  }
}

function formatResult(run) {
  if (run.error) return `做梦失败：${run.error}`
  if (!run.changedPaths.length && !run.deletedPaths.length) return '没有新的内容需要记住'
  const changed = run.changedPaths.map((p) => run.titles?.[p] || memoryTitleOf(path.basename(p, '.md')))
  const removed = run.deletedPaths.map((p) => `已移除 ${memoryTitleOf(path.basename(p, '.md'))}`)
  return `记忆已更新：${[...changed, ...removed].join(', ')}`
}

function addUsageTotals(previous, runInfo, dream) {
  const base = previous?.usageTotals || { runs: 0, promptTokens: 0, completionTokens: 0 }
  const ranAnything = Boolean(runInfo?.steps) || Boolean(dream)
  return {
    runs: Number(base.runs || 0) + (ranAnything ? 1 : 0),
    promptTokens:
      Number(base.promptTokens || 0) + (runInfo?.promptTokens || 0) + (dream?.usage?.prompt_tokens || 0),
    completionTokens:
      Number(base.completionTokens || 0) + (runInfo?.completionTokens || 0) + (dream?.usage?.completion_tokens || 0),
    lastModel: runInfo?.models?.[0] || dream?.model || base.lastModel || null,
  }
}

async function main() {
  const date = today()
  if (!acquireLock()) {
    log(`${date} 另一次做梦还在跑，跳过`)
    return
  }
  const hold = { status: true }
  startLockHeartbeat()

  try {
    const ledger = loadLedger()
    const conversations = loadConversations()
    const files = listFiles()
    const batches = findPendingBatches(conversations, ledger)
    const pendingTurns = countPendingTurns(conversations, ledger)

    if (DRY_RUN) {
      console.log(
        JSON.stringify(
          {
            mode,
            pendingTurns,
            conversations: conversations.length,
            blocks: files.length,
            batches: batches.map((b) => ({
              id: b.conversation.id,
              title: b.conversation.title,
              turns: b.pending.turns.length,
              totalTurns: b.pending.totalTurns,
              chars: b.input.newTurns.length,
            })),
            fullReview: mode === 'manual',
          },
          null,
          2
        )
      )
      return
    }

    // 第一次见到某个对话会定下进度，先存下来
    saveLedger(ledger)

    // 只查状态：不调模型
    if (mode === 'check') {
      writeStatus({ running: false, pendingTurns, lastCheckedAt: new Date().toISOString() })
      log(`${date} 检查：待整理 ${pendingTurns} 轮，对话 ${conversations.length} 段`)
      return
    }

    writeStatus({ running: true, startedAt: new Date().toISOString(), mode, pendingTurns })
    const started = Date.now()
    const fullReview = mode === 'manual'
    const nothingToDo = !batches.length && !(fullReview && files.length)
    const wantsDream = mode === 'dream' || mode === 'manual'

    const key = readKey()
    if (!key) throw new Error('没有可用的 API key')

    if (nothingToDo) {
      // 每晚那次即使没有新对话，也照常从记忆库写一篇梦
      if (mode === 'dream' && files.length) {
        const startedAt = Date.now()
        const dream = await writeDream(key, files, '')
        const runInfo = {
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          fullReview: false,
          changedPaths: [],
          deletedPaths: [],
          titles: {},
          error: null,
          summary: '没有新的对话轮次，只写了梦',
          steps: 0,
        }
        writeStatus({
          running: false,
          pendingTurns: 0,
          lastCheckedAt: new Date().toISOString(),
          lastRun: runInfo,
          ...(dream ? { lastDreamDate: dream.date } : {}),
          usageTotals: addUsageTotals(readStatus(), runInfo, dream),
          lastSummaryText: '没有新的内容需要记住',
        })
        log(`${date} 没有新的轮次，只写了梦`)
        syncRemote(date)
        return
      }
      writeStatus({ running: false, pendingTurns: 0, lastCheckedAt: new Date().toISOString() })
      log(`${date} 没有新的轮次，跳过`)
      return
    }

    backupBlocks(date)

    // 手动整理时接着跑，直到没有待整理的对话（照 RikkaHub organize 的循环）；
    // 自动整理一次只跑一批，剩下的交给下一轮触发
    let pendingBatches = batches
    let fullReviewNow = fullReview
    const merged = {
      touched: [],
      steps: 0,
      promptTokens: 0,
      completionTokens: 0,
      summary: '',
      finishReason: 'stop',
    }
    let passNo = 0
    while (pendingBatches.length || (passNo === 0 && fullReview && files.length)) {
      passNo++
      const transcripts = pendingBatches.map((b) => b.input)
      const passFiles = passNo === 1 ? files : listFiles()
      const passTurns = pendingBatches.reduce((n, b) => n + b.pending.turns.length, 0)
      log(
        `${date} 开始整理：${fullReviewNow ? '手动全库' : '自动'}（第 ${passNo} 批），` +
          `对话 ${transcripts.length} 段，待整理 ${passTurns} 轮，块 ${passFiles.length} 个`
      )
      // 只有整批跑完才推进进度；中途失败下次连同新轮次一起重试
      const result = await runConsolidationAgent(key, passFiles, transcripts, fullReviewNow, conversations)
      let advanced = 0
      for (const batch of pendingBatches) {
        const through = batch.pending.consolidatedThrough
        if (through != null) {
          ledger.conversations[batch.conversation.id] = through
          advanced++
        }
      }
      saveLedger(ledger)
      merged.touched.push(...result.touched)
      merged.steps += result.steps
      merged.promptTokens += result.promptTokens
      merged.completionTokens += result.completionTokens
      merged.summary = result.summary || merged.summary
      merged.finishReason = result.finishReason
      if (mode !== 'manual' || !advanced) break
      const next = findPendingBatches(conversations, ledger)
      if (!next.length) break
      fullReviewNow = false
      pendingBatches = next
    }
    const result = merged
    const leftoverPending = countPendingTurns(conversations, ledger)
    saveLedger(ledger)

    const remaining = listFiles()
    const byPath = new Map(remaining.map((f) => [f.path, f]))
    const touched = [...new Set(result.touched)]
    const changedPaths = touched.filter((p) => byPath.has(p))
    const deletedPaths = touched.filter((p) => !byPath.has(p))
    const titles = Object.fromEntries(changedPaths.map((p) => [p, byPath.get(p).title]))

    rebuildIndexes(remaining)

    let runInfo = {
      finishedAt: Date.now(),
      durationMs: Date.now() - started,
      fullReview,
      changedPaths,
      deletedPaths,
      titles,
      error: null,
      summary: result.summary,
      steps: result.steps,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      models: result.models || [],
    }

    let dream = null
    if (wantsDream) {
      try {
        dream = await writeDream(key, remaining, todayDigest(conversations, date))
        if (dream) runInfo.dreamDate = dream.date
      } catch (e) {
        log(`${date} 写梦失败：${e.message}`)
      }
    }

    writeStatus({
      running: false,
      pendingTurns: leftoverPending,
      lastCheckedAt: new Date().toISOString(),
      lastRun: runInfo,
      ...(dream ? { lastDreamDate: dream.date } : {}),
      usageTotals: addUsageTotals(readStatus(), runInfo, dream),
      lastSummaryText: formatResult(runInfo),
    })
    log(
      `${date} 完成：${runInfo.steps} 步，${changedPaths.length} 改 / ${deletedPaths.length} 删，` +
        `${runInfo.promptTokens}+${runInfo.completionTokens} tokens，${Math.round(runInfo.durationMs / 1000)}s` +
        (result.finishReason === 'step_limit' ? '（到步数上限）' : '')
    )
    syncRemote(date)
  } catch (e) {
    const message = e?.message || String(e)
    log(`${date} 失败：${message}`)
    const previous = readStatus()
    writeStatus({
      running: false,
      lastRun: {
        ...(previous.lastRun || {}),
        finishedAt: Date.now(),
        error: message,
      },
    })
    process.exitCode = 1
  } finally {
    stopLockHeartbeat()
    if (hold.status) releaseLock()
  }
}

main().catch((e) => {
  log(`失败：${e?.message || e}`)
  releaseLock()
  process.exit(1)
})
