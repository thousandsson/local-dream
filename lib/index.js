// 记忆插件（仿 RikkaHub 的记忆库）：
//   - 面板「记忆」：做梦状态 + 按目录分组的记忆块（显示中文标题）+ 最近的梦，点开看全文
//   - 输入框上方「立即做梦」胶囊、状态条
//   - 做梦在后台 spawn 一个 worker 进程完成，不打开对话；聊天停下来 2 分钟后、每晚 23:30 也会自己在后台跑
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  MEMORY_DIR,
  BLOCKS,
  listFiles,
  getFile,
  groupByDirectory,
  sectionTitle,
  memoryTitleOf,
  deleteFile,
  rebuildIndexes,
  saveEditedFile,
} from './memory-store.mjs'
import { registerChatMemory } from './chat-memory.mjs'
import { buildEditView, editData, EDIT_BODY_LIMIT } from './edit-view.mjs'
import { SESSIONS_ROOT, WORKSPACE } from './paths.mjs'

export const name = 'local-dream'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'worker.mjs')
const LOG = path.join(MEMORY_DIR, 'dream.log')
const STATUS = path.join(MEMORY_DIR, '.dream-state.json')
const LOCK = path.join(MEMORY_DIR, '.dream.lock')
const DREAMS = path.join(MEMORY_DIR, 'dreams')
const KEY_FILE = path.join(HERE, '..', '.key')

const IDLE_DELAY_MS = 2 * 60 * 1000
const DREAM_AT = '23:30'

let selected = null

function isZh(locale) {
  return !String(locale || '').toLowerCase().startsWith('en')
}

// ---------- 文件读取 ----------

/** 面板交互的轻量日志，只记结构不记内容 */
function logUi(message) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ui: ${message}\n`)
  } catch {
    // 日志失败不影响交互
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function statusInfo() {
  const status = readJson(STATUS) || {}
  let running = false
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    running = Boolean(holder?.pid) && pidAlive(holder.pid)
  } catch {
    running = false
  }
  return { ...status, running }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readKey() {
  try {
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim()
    if (key) return key
  } catch {
    // 没有独立 key 文件
  }
  return process.env.DEEPSEEK_API_KEY || ''
}

function listDreams() {
  try {
    return fs
      .readdirSync(DREAMS)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function dreamPreview(file) {
  try {
    const text = fs.readFileSync(path.join(DREAMS, file), 'utf8')
    const line = text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>'))
    return (line || '').trim().slice(0, 48)
  } catch {
    return ''
  }
}

// ---------- 文案（中文文案照 RikkaHub 的 values-zh） ----------

function relativeTime(ms) {
  const diff = Date.now() - Number(ms || 0)
  if (!Number.isFinite(diff) || diff < 0) return '刚刚'
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  const date = new Date(Number(ms))
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function formatTokens(count) {
  const n = Number(count || 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(Math.round(n))
}

function durationText(ms) {
  const seconds = Math.max(1, Math.round(Number(ms || 0) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function runText(run) {
  if (!run) return ''
  if (run.error) return `做梦失败：${run.error}`
  if (!run.changedPaths?.length && !run.deletedPaths?.length) return '没有新的内容需要记住'
  const titles = [
    ...(run.changedPaths || []).map((p) => run.titles?.[p] || memoryTitleOf(path.basename(p, '.md'))),
    ...(run.deletedPaths || []).map((p) => `已移除 ${memoryTitleOf(path.basename(p, '.md'))}`),
  ]
  return `记忆已更新：${titles.join(', ')}`
}

function statusItems(status) {
  const items = []
  if (status.running) return [['做梦', '做梦中…']]
  if (status.pendingTurns > 0) items.push(['待整理的对话', `${status.pendingTurns} 轮`])
  const run = status.lastRun
  if (run?.error) {
    items.push(['做梦', runText(run)])
  } else if (run?.finishedAt) {
    items.push(['上次', `${relativeTime(run.finishedAt)}：${runText(run)}（${durationText(run.durationMs)}）`])
  }
  const usage = status.usageTotals
  if (usage?.runs) {
    const tokens = Number(usage.promptTokens || 0) + Number(usage.completionTokens || 0)
    items.push(['累计', `${usage.runs} 次 · ${formatTokens(tokens)} tokens${usage.lastModel ? ` · ${usage.lastModel}` : ''}`])
  }
  if (!items.length) items.push(['做梦', '聊天停下来后，把对话整理成记忆'])
  return items
}

// ---------- 后台做梦 ----------

function startDream(mode) {
  const key = readKey()
  if (mode !== 'check' && !key) return false
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    const fd = fs.openSync(LOG, 'a')
    fs.writeSync(fd, `\n===== ${new Date().toISOString()} ${mode} start =====\n`)
    const child = spawn(process.execPath || 'node', [WORKER, `--${mode}`], {
      cwd: WORKSPACE,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, DEEPSEEK_API_KEY: key },
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function latestSessionMtime() {
  let latest = 0
  try {
    for (const workspace of fs.readdirSync(SESSIONS_ROOT)) {
      const dir = path.join(SESSIONS_ROOT, workspace)
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const sessionDir = path.join(dir, entry.name)
        let files
        try {
          files = fs.readdirSync(sessionDir)
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.endsWith('.jsonl.zstd')) continue
          try {
            const st = fs.statSync(path.join(sessionDir, file))
            if (st.mtimeMs > latest) latest = st.mtimeMs
          } catch {
            // 文件没了就跳过
          }
        }
      }
    }
  } catch {
    return latest
  }
  return latest
}

function hhmm() {
  const text = new Date().toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
  return text.slice(0, 5)
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

/** 纯后台触发：聊天空闲 2 分钟后自动整理，每天 23:30 整理并写梦；都不开新对话 */
function startScheduler() {
  let lastMtime = latestSessionMtime()
  let lastActivityAt = 0
  let lastSpawnAt = 0
  let lastCheckAt = 0
  let lastCheckedMtime = 0
  let lastDreamAttemptAt = 0

  const tick = () => {
    try {
      const status = statusInfo()
      if (status.running) return

      // 1) 聊天有动静：记下时间，等停下来
      const mtime = latestSessionMtime()
      if (mtime > lastMtime) {
        lastMtime = mtime
        lastActivityAt = Date.now()
      }

      // 上次整理失败后不再自动重试，等下一轮对话结束或用户手动触发（照 RikkaHub 的 failed 集合）
      const failed = Boolean(status.lastRun?.error)
      const failedAt = Number(status.lastRun?.finishedAt || 0)
      // 失败之后又有新的对话轮次，才允许再自动跑一次
      const blockedByFailure = failed && !(mtime > failedAt)

      // 2) 攒够 6 轮就直接整理（照 RikkaHub 的 maxPendingTurns）
      if (!blockedByFailure && (status.pendingTurns || 0) >= 6 && Date.now() - lastSpawnAt >= 60_000) {
        lastSpawnAt = Date.now()
        lastActivityAt = 0
        startDream('auto')
        return
      }

      // 3) 停下来 2 分钟 → 后台整理（worker 自己判断有没有待整理的轮次）
      const idleEnough = lastActivityAt > 0 && Date.now() - lastActivityAt >= IDLE_DELAY_MS
      if (idleEnough && !blockedByFailure && Date.now() - lastSpawnAt >= IDLE_DELAY_MS) {
        lastSpawnAt = Date.now()
        lastActivityAt = 0
        startDream('auto')
        return
      }

      // 4) 聊天有过新动静、且距上次查超过 3 分钟时，轻量算一次待整理轮数（不调模型）
      if (mtime > lastCheckedMtime && Date.now() - lastCheckAt >= 3 * 60 * 1000) {
        lastCheckAt = Date.now()
        lastCheckedMtime = mtime
        startDream('check')
        return
      }

      // 5) 每天 23:30 做一次「整理 + 写梦」；错过了就在启动后补一次
      const nowHM = hhmm()
      const afterDreamTime = nowHM >= DREAM_AT
      const alreadyDreamed = status.lastDreamDate === todayStr()
      const coolDown = Date.now() - lastDreamAttemptAt > 30 * 60 * 1000
      if (afterDreamTime && !alreadyDreamed && coolDown) {
        lastDreamAttemptAt = Date.now()
        startDream('dream')
      }
    } catch {
      // 调度出错不影响 App
    }
  }

  const timer = setInterval(tick, 30_000)
  timer.unref?.()
  // 引擎启动时补一次待整理状态和错过的每日做梦
  const boot = setTimeout(tick, 15_000)
  boot.unref?.()
  return () => {
    clearInterval(timer)
    clearTimeout(boot)
  }
}

// ---------- 视图 ----------

function memoryListItems(files) {
  return files.map((file) => ({
    title: file.title,
    subtitle: file.description || '',
    trailing: `更新于 ${relativeTime(file.updatedAt)}`,
    action: { id: 'open-block', args: { path: file.path } },
  }))
}

function memoryPanelView(caps) {
  const zh = isZh(caps.locale)
  const files = listFiles()
  const groups = groupByDirectory(files)
  const dreams = listDreams()
  const status = statusInfo()
  const children = [
    {
      type: 'keyValue',
      items: statusItems(status).map(([label, value]) => [
        zh ? label : { 做梦: 'Dream', 上次: 'Last', 累计: 'Total', 待整理的对话: 'Pending' }[label] || label,
        value,
      ]),
    },
    {
      type: 'actions',
      items: [
        { label: status.running ? (zh ? '做梦中…' : 'Dreaming…') : status.lastRun?.error ? (zh ? '重试' : 'Retry') : zh ? '立即做梦' : 'Dream now', action: 'dream-now', style: 'primary' },
        { label: zh ? '新建记忆' : 'New memory', action: 'open-new' },
        { label: zh ? '刷新' : 'Refresh', action: 'refresh' },
      ],
    },
  ]

  if (!files.length) {
    children.push({ type: 'text', text: zh ? '暂无记忆' : 'No memories yet', tone: 'muted' })
    children.push({
      type: 'text',
      text: zh ? '聊天时，助手会记住你告诉它的内容' : 'Memories are written in the background after chats pause',
      tone: 'muted',
    })
  } else {
    for (const [directory, group] of groups) {
      children.push({ type: 'text', text: sectionTitle(directory), tone: 'muted' })
      children.push({ type: 'list', items: memoryListItems(group.slice(0, 20)) })
    }
  }

  if (dreams.length) {
    children.push({ type: 'text', text: zh ? '最近的梦' : 'Recent dreams', tone: 'muted' })
    children.push({
      type: 'list',
      items: dreams.slice(0, 6).map((file) => ({
        title: file.replace(/\.md$/, ''),
        subtitle: dreamPreview(file),
        action: { id: 'open-dream', args: { file } },
      })),
    })
  }

  return { type: 'stack', title: zh ? '记忆' : 'Memory', children }
}

function detailView(scope, caps) {
  const zh = isZh(caps.locale)
  if (!selected) {
    return {
      type: 'stack',
      title: zh ? '记忆详情' : 'Memory',
      children: [{ type: 'text', text: zh ? '还没有选中内容' : 'Nothing selected' }],
    }
  }
  if (selected.kind === 'dream') {
    let body = ''
    try {
      body = fs.readFileSync(path.join(DREAMS, selected.file), 'utf8')
    } catch {
      body = zh ? '读不到这一篇' : 'Cannot read this dream'
    }
    return {
      type: 'stack',
      title: selected.file.replace(/\.md$/, ''),
      children: [
        { type: 'text', text: body.slice(0, 3000) },
        { type: 'actions', items: [{ label: zh ? '回记忆' : 'Back', action: 'back' }] },
        // 梦只是当天的记录，删掉不影响记忆块
        {
          type: 'confirm',
          id: 'delete-dream',
          confirmLabel: zh ? '删除这篇梦' : 'Delete',
          cancelLabel: zh ? '取消' : 'Cancel',
        },
      ],
    }
  }
  const file = getFile(selected.path)
  if (!file) {
    return {
      type: 'stack',
      title: zh ? '记忆详情' : 'Memory',
      children: [
        { type: 'text', text: zh ? '此记忆已不存在' : 'This memory does not exist' },
        { type: 'actions', items: [{ label: zh ? '回记忆' : 'Back', action: 'back' }] },
      ],
    }
  }
  return {
    type: 'stack',
    title: file.title,
    children: [
      {
        type: 'keyValue',
        items: [
          [zh ? '摘要' : 'Summary', file.description || '—'],
          [zh ? '路径' : 'Path', file.path],
          ...(file.aliases.length ? [[zh ? '别名' : 'Aliases', file.aliases.join(', ')]] : []),
          [zh ? '最后更新' : 'Updated', relativeTime(file.updatedAt)],
        ],
      },
      { type: 'text', text: (file.displayBody || '').trim().slice(0, 3500) || '—' },
      {
        type: 'actions',
        items: [
          { label: zh ? '编辑' : 'Edit', action: 'open-edit', style: 'primary' },
          { label: zh ? '回记忆' : 'Back', action: 'back' },
        ],
      },
      // 删除要再确认一次；确认后由 delete-block 处理
      {
        type: 'confirm',
        id: 'delete-block',
        confirmLabel: zh ? '删除' : 'Delete',
        cancelLabel: zh ? '取消' : 'Cancel',
      },
      {
        type: 'text',
        text: zh
          ? '长按删除会把这一条记忆整篇删掉；只忘掉一件事就在聊天里让助手改。'
          : 'Deleting removes the whole file; to forget one line, ask the assistant in chat.',
        tone: 'muted',
      },
    ],
  }
}

/**
 * 表单提交的值：App 把输入框的内容包在 value.values 里，个别版本还会再包一层 data。
 * 键可能是 title，也可能是 data.title，统一成短名字。
 */
function unwrapFormValue(event) {
  const raw = event?.value
  if (!raw || typeof raw !== 'object') return {}
  let values = raw.values && typeof raw.values === 'object' ? raw.values : raw
  if (values.data && typeof values.data === 'object') values = values.data
  const out = {}
  for (const [key, item] of Object.entries(values)) {
    const short = String(key).replace(/^data\./, '').split('.').pop()
    if (short) out[short] = item
  }
  return out
}

/** 编辑表单当前要编辑的内容：新建给空模板，编辑读盘上的块 */
function currentEditEntry() {
  if (!selected) return null
  if (selected.kind === 'new') {
    return { mode: 'new', file: { path: '', title: '', description: '', aliases: [], body: '' } }
  }
  if (selected.kind !== 'block') return null
  const file = getFile(selected.path)
  if (!file) return null
  return {
    mode: 'edit',
    file: {
      path: file.path,
      title: file.title,
      description: file.description,
      aliases: file.aliases,
      body: file.body,
    },
  }
}

// ---------- 插件入口 ----------

export function apply(ctx) {
  // 主对话侧的记忆：system prompt 片段 + memory_* 工具（引擎侧服务缺失时这步静默跳过）
  registerChatMemory(ctx)

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('dream-now', (scope, event) => {
      const zh = isZh(event.locale)
      const status = statusInfo()
      if (status.running) return { toast: zh ? '正在做梦，稍等' : 'Already dreaming' }
      if (!readKey()) return { toast: zh ? '还没有可用的 API key' : 'No API key available' }
      return startDream('manual')
        ? { toast: zh ? '开始做梦，好了看记忆面板' : 'Dreaming in the background' }
        : { toast: zh ? '后台任务没起来，稍后再试' : 'Could not start the background job' }
    })

    ctx.dshGo.strip('memory-state', (scope, emit, caps) => {
      const tick = () => {
        const zh = isZh(caps.locale)
        const status = statusInfo()
        const files = listFiles()
        let text
        if (status.running) text = zh ? '做梦中…' : 'Dreaming…'
        else if (status.pendingTurns > 0) text = zh ? `记忆 ${files.length} 篇 · 待整理 ${status.pendingTurns} 轮` : `Blocks ${files.length} · ${status.pendingTurns} pending`
        else text = zh ? `记忆 ${files.length} 篇` : `${files.length} memory files`
        emit({ text: text.slice(0, 24), icon: 'book' })
      }
      tick()
      const timer = setInterval(tick, 60_000)
      return () => clearInterval(timer)
    })

    ctx.dshGo.panel('memory', {
      view: (scope, caps) => memoryPanelView(caps),
      data: (scope, emit) => {
        emit({ at: Date.now() })
        return () => {}
      },
      actions: {
        'open-block': (scope, event) => {
          const rel = event?.value?.path
          if (!rel) return { toast: isZh(event.locale) ? '读不到这个块' : 'Cannot find this block' }
          selected = { kind: 'block', path: rel }
          return { open: 'panel:memory-detail' }
        },
        'open-dream': (scope, event) => {
          const file = event?.value?.file
          if (!file) return { toast: isZh(event.locale) ? '读不到这一篇' : 'Cannot find this dream' }
          selected = { kind: 'dream', file }
          return { open: 'panel:memory-detail' }
        },
        'dream-now': (scope, event) => {
          const zh = isZh(event.locale)
          const status = statusInfo()
          if (status.running) return { toast: zh ? '正在做梦，稍等' : 'Already dreaming' }
          return startDream('manual')
            ? { toast: zh ? '开始做梦，好了看记忆面板' : 'Dreaming in the background' }
            : { toast: zh ? '还没有可用的 API key' : 'No API key available' }
        },
        'open-new': () => {
          selected = { kind: 'new' }
          return { open: 'panel:memory-edit' }
        },
        refresh: () => ({ refresh: true }),
      },
    })

    ctx.dshGo.panel('memory-detail', {
      view: detailView,
      data: (scope, emit) => {
        emit({ at: Date.now() })
        return () => {}
      },
      actions: {
        back: () => ({ open: 'panel:memory' }),
        'open-edit': () => {
          if (!selected || selected.kind !== 'block') return { toast: '读不到这个块' }
          return { open: 'panel:memory-edit' }
        },
        'edit-in-chat': (scope, event) => {
          const zh = isZh(event.locale)
          if (!selected || selected.kind !== 'block') return { toast: zh ? '读不到这个块' : 'Cannot find this block' }
          return {
            insert: zh ? `修改记忆 ${selected.path}：` : `Change memory ${selected.path}: `,
            toast: zh ? '在输入框里补要改的内容' : 'Finish the text in the composer',
          }
        },
        'delete-block': (scope, event) => {          const zh = isZh(event.locale)
          if (!event?.value?.confirmed) return { toast: zh ? '已取消' : 'Cancelled' }
          if (!selected || selected.kind !== 'block') return { toast: zh ? '读不到这个块' : 'Cannot find this block' }
          const file = getFile(selected.path)
          if (!file) return { toast: zh ? '此记忆已不存在' : 'This memory does not exist' }
          const result = deleteFile(selected.path, file.version)
          if (result?.error) return { toast: zh ? '删除失败，稍后再试' : 'Delete failed' }
          try {
            rebuildIndexes()
          } catch {
            // 索引重建失败不影响删除
          }
          selected = null
          return { toast: zh ? `已删除「${file.title}」` : `Deleted ${file.title}`, open: 'panel:memory' }
        },
        'delete-dream': (scope, event) => {
          const zh = isZh(event.locale)
          if (!event?.value?.confirmed) return { toast: zh ? '已取消' : 'Cancelled' }
          if (!selected || selected.kind !== 'dream') return { toast: zh ? '读不到这一篇' : 'Cannot find this dream' }
          try {
            fs.rmSync(path.join(DREAMS, selected.file), { force: true })
          } catch {
            return { toast: zh ? '删除失败，稍后再试' : 'Delete failed' }
          }
          selected = null
          return { toast: zh ? '已删除这篇梦' : 'Dream deleted', open: 'panel:memory' }
        },
      },
    })

    ctx.dshGo.panel('memory-edit', {
      view: (scope, caps) => {
        const zh = isZh(caps.locale)
        const entry = currentEditEntry()
        if (!entry) {
          return {
            type: 'stack',
            title: zh ? '编辑记忆' : 'Edit memory',
            children: [{ type: 'text', text: zh ? '先从记忆列表点一条再进来' : 'Pick a memory from the list first' }],
          }
        }
        return buildEditView({ mode: entry.mode, entry: entry.file, zh })
      },
      data: (scope, emit) => {
        const entry = currentEditEntry()
        const data = editData({ mode: entry?.mode || 'new', entry: entry?.file || null })
        // 正文太长时不往面板里推，省得一次推几十 KB；保存时本来就保留原文
        if (data.body.length > EDIT_BODY_LIMIT) data.body = ''
        emit(data)
        return () => {}
      },
      actions: {
        'save-edit': (scope, event) => {
          const zh = isZh(event.locale)
          // App 提交表单时把输入值包在 value.values 里（实际回传结构：{"values":{...}}）
          const value = unwrapFormValue(event)
          // 只记字段名和长度，不把记忆内容写进日志
          const shape = Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, typeof item === 'string' ? item.length : typeof item])
          )
          logUi(`保存编辑：字段 ${JSON.stringify(shape)}`)
          const hasFields = ['path', 'title', 'description', 'aliases', 'body'].some((key) => key in value)
          if (!hasFields) return { toast: zh ? 'App 没把表单内容传回来，先别用这个页面' : 'The app returned no form values' }
          if (!selected) return { toast: zh ? '没有选中要编辑的记忆' : 'Nothing selected' }

          const isNew = selected.kind === 'new'
          const targetPath = isNew ? String(value.path || '').trim() : selected.path
          if (isNew && !targetPath) return { toast: zh ? '先填路径，例如 /topics/food.md' : 'Fill in a path first' }
          const current = isNew ? null : getFile(selected.path)
          if (!isNew && !current) return { toast: zh ? '这条记忆已经不在了' : 'This memory no longer exists' }
          // 正文超过编辑框上限时不动正文，避免保存把原文截断
          const bodyTooLong = Boolean(current && current.body.length > EDIT_BODY_LIMIT)
          const saved = saveEditedFile({
            path: targetPath,
            title: value.title,
            description: value.description,
            aliases: value.aliases,
            body: isNew ? value.body : bodyTooLong ? undefined : value.body,
            isNew,
          })
          if (saved.error) return { toast: zh ? `保存失败：${saved.error}` : `Save failed: ${saved.error}` }
          try {
            rebuildIndexes()
          } catch {
            // 索引重建失败不影响保存
          }
          selected = { kind: 'block', path: saved.path }
          return { toast: zh ? `已保存「${saved.title}」` : `Saved ${saved.title}`, open: 'panel:memory' }
        },
        'cancel-edit': () => ({ open: 'panel:memory' }),
      },
    })

    startScheduler()
  })
}
