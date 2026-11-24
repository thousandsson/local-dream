// 插件用到的所有路径集中在这里，方便换机器 / 发布到插件市场：
//   HOME                     用户主目录
//   DSH_HOME                 DSH 主目录（默认 ~/.dsh），会话日志和凭据都在里面
//   WORKSPACE                工作区（默认 ~/workspace），MEMORY.md 索引落在它下面
//   DSH_DREAM_DIR            记忆库位置，默认 <WORKSPACE>/memory
//   DSH_DREAM_SYNC_TARGET    可选：整理完把记忆同步到 rclone 目标，如 "koofr:backup"
import os from 'node:os'
import path from 'node:path'

export const HOME = process.env.HOME || os.homedir()
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
export const WORKSPACE = process.env.DSH_WORKSPACE || path.join(HOME, 'workspace')
export const MEMORY_DIR = process.env.DSH_DREAM_DIR || path.join(WORKSPACE, 'memory')
export const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
export const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml')
// 可选的外部同步目标；没配置就不同步（发布版默认不依赖 rclone）
export const SYNC_TARGET = (process.env.DSH_DREAM_SYNC_TARGET || '').trim()
