import { Context, Schema, h, segment, Session } from 'koishi'
import { } from 'koishi-plugin-puppeteer'
import { Rettiwt } from 'rettiwt-api'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'

// ============================== 类型定义 ==============================

interface TargetConfig {
  platform: string
  channelId: string
}

// 推送目标分组：一个平台（如 onebot）可添加多个群聊 / 频道
interface TargetGroupConfig {
  platform: string
  channelIds: string[]
}

export interface Config {
  sourceMode: 'rettiwt' | 'rsshub'
  xEnabled: boolean
  intervalMinutes: number
  requestTimeout: number
  excludeRetweets: boolean
  includeFilter: string
  excludeFilter: string
  // Rettiwt 模式（固定使用 apiKey 登录）
  rettiwtApiKey: string
  includeQuote: boolean
  maxTweets: number
  useOriginalImages: boolean
  realGif: boolean
  imageSendMode: 'buffer' | 'url' | 'base64' | 'file'
  videoSendMode: 'buffer' | 'url' | 'base64' | 'file'
  // rsshub 模式
  rssTemplate: string
  rsshubAccessKey: string
  // Discord 登录
  discordEnabled: boolean
  dcAppId: string
  // OpenAI 翻译
  openaiApiKey: string
  openaiBaseURL: string
  openaiModel: string
  systemPrompt: string
  // 推送
  linkStyle: 'original' | 'fxtwitter' | 'vxtwitter'
  notifySkippedMedia: boolean
  pushAsForward: boolean
  // 分批推送（防风控）：每批最多同时发送的群数 / 批次之间的等待毫秒数
  pushBatchSize: number
  pushBatchDelay: number
  // 消息之间的最小间隔（毫秒，防风控）
  pushMsgInterval: number
  // DC 中转时附带 embed 配图与附件媒体
  dcRelayMedia: boolean
  targets: TargetGroupConfig[]
  // 推送板块：各自独立的 DC 推送频道 / X 推送账号 / 推送的群聊
  xpChannels: string[]
  xpAccounts: string[]
  xpTargets: TargetGroupConfig[]
  mfsChannels: string[]
  mfsAccounts: string[]
  mfsTargets: TargetGroupConfig[]
  enableLog: boolean
  // 超级管理员（可使用订阅/取消订阅 XP / MFS（微软）推送指令，权限等同群管理员）
  superAdmins: string[]
  // 推送图片水印
  watermarkText: string
  watermarkSize: number
  watermarkOpacity: number
  // 板块独立日志开关（总开关为 enableLog）
  xLog: boolean
  dcLog: boolean
  xpLog: boolean
  mfsLog: boolean
  aiLog: boolean
}

interface FeedItem {
  id: string
  account: string
  text: string
  link: string
  pubDate: string
  images: string[]
  videos: string[]
  isRetweet: boolean
}

// ============================== 配置 Schema ==============================

const TargetSchema = Schema.object({
  platform: Schema.string().required().description('平台，如 onebot'),
  channelId: Schema.string().required().description('群号 / 频道 ID'),
})

const TargetGroupSchema = Schema.object({
  platform: Schema.string().required().description('平台，如 onebot'),
  channelIds: Schema.array(Schema.string().required()).default([]).description('群号 / 频道 ID 列表（可添加多个）'),
})

// ============================== 配置 Schema ==============================

// 模型名作为变量：通过用户输入的 API KEY 与 API 地址在线获取所有可用模型，
// 重建 Schema 导出后，控制面板「AI 翻译设置」即可下拉选择。
// 模型列表缓存到磁盘，重启后面板与配置校验依然可用。
const modelCacheFile = path.join(process.cwd(), 'data', 'x-relay-monitor', 'models.json')

let availableModels: string[] = []
let lastOpenaiModel = 'gpt-4o-mini'

try {
  const cache = JSON.parse(readFileSync(modelCacheFile, 'utf8'))
  if (Array.isArray(cache?.models)) availableModels = cache.models.map(String).filter(Boolean)
  if (cache?.selected) lastOpenaiModel = String(cache.selected)
} catch { /* 无缓存 */ }

function buildModelSchema(): Schema<string> {
  // 常量分支为在线获取的模型（下拉选择）；最后的 string 分支兜底，
  // 既保证配置校验永不失败，也允许手输自定义模型名。
  const branches = availableModels.map(id => Schema.const(id).description(id))
  branches.push(Schema.string().description('自定义模型名（手动输入）'))
  return Schema.union(branches) as unknown as Schema<string>
}

function buildConfigSchema(): Schema<Config> {
  return Schema.intersect([
  // ============ 主设置 ============
  Schema.object({
    intervalMinutes: Schema.number().min(1).max(1440).step(1).default(10).description('轮询间隔（分钟，X 账号与 DC 频道共用）'),
    requestTimeout: Schema.number().min(5000).max(120000).step(1000).default(30000).description('单次请求超时（毫秒）'),
    enableLog: Schema.boolean().default(true).description('输出详细日志'),
    watermarkText: Schema.string().default('本消息由3090的机器人发出').description('推送图片水印文字'),
    watermarkSize: Schema.number().min(10).max(120).step(1).default(40).description('水印字号（像素）'),
    watermarkOpacity: Schema.number().min(5).max(95).step(1).default(70).description('水印透明度（百分比，越大越淡；70 = 70% 透明）'),
    linkStyle: Schema.union([
      Schema.const('original').description('原始 twitter.com 链接'),
      Schema.const('fxtwitter').description('fxtwitter.com（国内可打开）'),
      Schema.const('vxtwitter').description('vxtwitter.com（国内可打开）'),
    ]).default('vxtwitter').description('推文页面地址样式（用于截图推文原文）'),
    notifySkippedMedia: Schema.boolean().default(true).description('媒体被跳过（图片发送失败 / 视频无法附带）时，额外发送一条说明消息'),
    pushAsForward: Schema.boolean().default(false).description('推送时使用 OneBot 合并转发（协议端不支持时回退逐条消息）'),
    pushBatchSize: Schema.number().min(1).max(50).step(1).default(9)
      .description('分批推送：每条消息每批最多「同时」发送到的群数（防风控。默认 9；填 1 则同一条消息内的群也逐条发送）'),
    pushBatchDelay: Schema.number().min(0).max(600000).step(500).default(5000)
      .description('分批推送：同一条消息中，批次之间的等待时间（毫秒，防风控。默认 5000；0 = 不等待）'),
    pushMsgInterval: Schema.number().min(0).max(600000).step(500).default(3000)
      .description('消息间隔：两条推送消息之间的最小间隔时间（毫秒，防风控。默认 3000；0 = 不限制。一轮轮询补发多条推文时按此间隔逐条发出）'),
    dcRelayMedia: Schema.boolean().default(true)
      .description('DC 中转时附带媒体：把 embed 配图与附件图片/视频一并推送（公告类消息的正文摘要与配图不再丢失）'),
    targets: Schema.array(TargetGroupSchema).default([]).description('全局推送目标（未归属任何推送板块的内容使用）'),
    superAdmins: Schema.array(Schema.string()).default([]).description('超级管理员用户 ID 列表（可使用「订阅/取消订阅 XP / MFS（微软）推送」指令，权限等同群管理员）'),
  }).description('主设置'),
  // ============ X 登录 ============
  Schema.object({
    xEnabled: Schema.boolean().default(true).description('启用 X 账号轮询'),
    sourceMode: Schema.union([
      Schema.const('rettiwt').description('Rettiwt 模式（Cookie 登录，固定使用此方式）'),
      Schema.const('rsshub').description('RSS 模式（RSSHub /twitter/user 路由）'),
    ]).default('rettiwt').description('X 数据获取方式'),
    excludeRetweets: Schema.boolean().default(true).description('排除转推（Rettiwt 模式按转推标记判断，RSS 模式按 RT @ 判断）'),
    includeFilter: Schema.string().default('').description('包含过滤（正则，留空不过滤；命中才推送）'),
    excludeFilter: Schema.string().default('').description('排除过滤（正则，留空不过滤；命中则不推送）'),
    rettiwtApiKey: Schema.string().role('secret').default('')
      .description('Rettiwt API_KEY（获取方法：F12 打开开发者工具 → 应用程序 → Cookie，复制 auth_token、ct0、twid 三个字段的值，在控制台执行 btoa("auth_token=<值>;ct0=<值>;twid=<值>;")，输出的字符串即为 API_KEY。也可直接粘贴原始 cookie 串 auth_token=..;ct0=..;twid=..;，插件会自动转换为 base64，升级后无需手动更新配置'),
    includeQuote: Schema.boolean().default(false).description('附带引用推文内容'),
    maxTweets: Schema.number().min(1).max(20).step(1).default(5).description('每次检查的最新推文条数（Rettiwt 上限 20）'),
    useOriginalImages: Schema.boolean().default(false)
      .description('启用原图后会把 pbs.twimg.com/media 图片地址改为 name=orig'),
    realGif: Schema.boolean().default(false)
      .description('可将 Twitter 动图从 MP4 转为真正的 GIF，需启用 koishi-plugin-ffmpeg 服务'),
    imageSendMode: Schema.union([
      Schema.const('buffer').description('下载后以 buffer 发送'),
      Schema.const('url').description('直接传递 URL'),
      Schema.const('base64').description('下载后以 base64 发送'),
      Schema.const('file').description('下载后写入临时文件，以 file:// 发送'),
    ]).default('url').description('图片传递方式'),
    videoSendMode: Schema.union([
      Schema.const('buffer').description('下载后以 buffer 发送'),
      Schema.const('url').description('直接传递 URL'),
      Schema.const('base64').description('下载后以 base64 发送'),
      Schema.const('file').description('下载后写入临时文件，以 file:// 发送'),
    ]).default('url').description('视频传递方式'),
    rssTemplate: Schema.string().default('https://rsshub.app/twitter/user/{account}')
      .description('RSS 源模板，{account} 会被替换为账号名'),
    rsshubAccessKey: Schema.string().role('secret').default('').description('RSSHub accessKey（自建实例可留空）'),
    xLog: Schema.boolean().default(true).description('输出 X 登录与轮询日志（总开关：主设置 → 输出详细日志）'),
  }).description('X 登录'),
  // ============ DC 登录 ============
  Schema.object({
    discordEnabled: Schema.boolean().default(true).description('启用 Discord（通过 DC 机器人定时读取推送板块内配置的频道内容）'),
    dcAppId: Schema.string().default('')
      .description('基础设置：指定 DC 机器人 APP ID（Discord 应用程序 ID / 机器人账号 ID）。存在多个 Discord 机器人时，本插件固定使用该机器人读取频道与去重，避免与其他插件（如 DC-QQ 桥接）的机器人冲突。留空则自动选择'),
    dcLog: Schema.boolean().default(true).description('输出 DC 频道读取日志（总开关：主设置 → 输出详细日志）'),
  }).description('DC 登录'),
  // ============ XP 推送 ============
  Schema.object({
    xpChannels: Schema.array(Schema.string()).default([])
      .description('DC 推送频道：支持完整链接 https://discord.com/channels/服务器ID/频道ID，也支持纯频道 ID'),
    xpAccounts: Schema.array(Schema.string().pattern(/^\S+$/)).default([]).description('X 推送账号（不含 @）'),
    xpTargets: Schema.array(TargetGroupSchema).default([]).description('推送的群聊（一个平台可添加多个群号）'),
    xpLog: Schema.boolean().default(true).description('输出 XP 板块推送日志（总开关：主设置 → 输出详细日志）'),
  }).description('XP 推送'),
  // ============ MFS 推送 ============
  Schema.object({
    mfsChannels: Schema.array(Schema.string()).default([])
      .description('DC 推送频道：支持完整链接 https://discord.com/channels/服务器ID/频道ID，也支持纯频道 ID'),
    mfsAccounts: Schema.array(Schema.string().pattern(/^\S+$/)).default([]).description('X 推送账号（不含 @）'),
    mfsTargets: Schema.array(TargetGroupSchema).default([]).description('推送的群聊（一个平台可添加多个群号）'),
    mfsLog: Schema.boolean().default(true).description('输出 MFS 板块推送日志（总开关：主设置 → 输出详细日志）'),
  }).description('MFS 推送'),
  // ============ AI 翻译设置 ============
  Schema.object({
    openaiApiKey: Schema.string().role('secret').default('').description('OpenAI API Key（留空则只发原文）'),
    openaiBaseURL: Schema.string().default('https://api.openai.com/v1').description('API Base URL（兼容 Chat Completions）'),
    openaiModel: buildModelSchema().description('模型名（配置 API KEY 与地址后自动在线获取，下拉选择；也可手动输入）'),
    systemPrompt: Schema.string().default('你是专业模拟飞行领域翻译。将用户内容准确翻译为简体中文，保留专有名词、呼号、机场代码与数字，只输出译文，不要附加说明。保留原文中的 Markdown 格式（如 **粗体**、# 标题、列表、- 项目、引用 >、行内代码 ` 与链接 [文字](url)），译文沿用相同 Markdown 语法。').description('翻译系统提示词'),
    aiLog: Schema.boolean().default(true).description('输出 AI 翻译日志（总开关：主设置 → 输出详细日志）'),
  }).description('AI 翻译设置'),
  ])
}

export let Config: Schema<Config> = buildConfigSchema()

export const name = 'x-relay-monitor'
export const inject = {
  required: ['http'],
  optional: ['puppeteer'],
}

// ============================== 插件主体 ==============================

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('x-relay-monitor')
  const dataFile = path.join(process.cwd(), 'data', 'x-relay-monitor.json')

  // 生命周期与去重状态
  const timers = new Map<string, NodeJS.Timeout>()
  let disposed = false
  let polling = false
  const discordSeen = new Set<string>()
  const lastIds: Record<string, string> = {}
  const lastMessageIds: Record<string, string> = {}

  function log(level: 'info' | 'warn' | 'error', message: string, ...args: any[]) {
    if (level === 'info' && !config.enableLog) return
    logger[level](`[X监控] ${message}`, ...args)
  }

  // ---------------- 板块独立日志 ----------------
  // 除主设置外的组件各自拥有日志开关（总开关为主设置的「输出详细日志」），
  // 日志按板块打标签输出：[X监控][X登录] / [X监控][DC登录] / ...

  type LogLevel = 'info' | 'warn' | 'error'

  function moduleEnabled(module: string): boolean {
    const map: Record<string, boolean | undefined> = {
      'X登录': config.xLog,
      'DC登录': config.dcLog,
      'XP推送': config.xpLog,
      'MFS推送': config.mfsLog,
      'AI翻译': config.aiLog,
      // 共享推送管线（截图/文本卡片/媒体构建）按任一推送板块开启即输出
      '推送': (config.xpLog ?? true) || (config.mfsLog ?? true),
    }
    return map[module] ?? true
  }

  function mlog(module: string, level: LogLevel, message: string, ...args: any[]) {
    if (!config.enableLog || !moduleEnabled(module)) return
    logger[level](`[X监控][${module}] ${message}`, ...args)
  }

  const xlog = (level: LogLevel, message: string, ...args: any[]) => mlog('X登录', level, message, ...args)
  const dclog = (level: LogLevel, message: string, ...args: any[]) => mlog('DC登录', level, message, ...args)
  const ailog = (level: LogLevel, message: string, ...args: any[]) => mlog('AI翻译', level, message, ...args)

  // 推送日志：按内容来源归属板块（XP 推送 / MFS 推送）；未归属任何板块时走「推送」通道
  function plog(level: LogLevel, message: string, account?: string, discordChannelId?: string, ...args: any[]) {
    const boards = pushBoards()
    const matched: string[] = []
    boards.forEach((board, index) => {
      const byAccount = !!account && board.accounts.some(name => name.toLowerCase() === account.toLowerCase())
      const byChannel = !!discordChannelId && board.channels.some(id => extractDiscordChannelId(id) === discordChannelId)
      if (byAccount || byChannel) matched.push(index === 0 ? 'XP推送' : 'MFS推送')
    })
    if (!matched.length) return mlog('推送', level, message, ...args)
    for (const module of matched) mlog(module, level, message, ...args)
  }

  // ---------------- 状态持久化 ----------------

  async function loadState() {
    try {
      const state = JSON.parse(await fs.readFile(dataFile, 'utf8'))
      if (state?.lastIds) Object.assign(lastIds, state.lastIds)
      if (state?.lastMessageIds) Object.assign(lastMessageIds, state.lastMessageIds)
      if (Array.isArray(state?.discordSeen)) state.discordSeen.forEach((id: string) => discordSeen.add(id))
    } catch { /* 首次运行无状态文件 */ }
  }

  async function saveState() {
    await fs.mkdir(path.dirname(dataFile), { recursive: true })
    const seen = [...discordSeen].slice(-200)
    await fs.writeFile(dataFile, JSON.stringify({ lastIds, lastMessageIds, discordSeen: seen }, null, 2))
  }

  // ---------------- 工具函数 ----------------

  function decodeHtml(text: string): string {
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function extractCdata(field: string): string {
    const cdata = field.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    return cdata ? cdata[1] : field
  }

  function buildLink(link: string): string {
    const id = link.match(/status\/(\d+)/)?.[1]
    const user = link.match(/(?:twitter|x)\.com\/([^/]+)\/status/)?.[1]
    if (!id) return link
    const handle = user || 'i'
    if (config.linkStyle === 'fxtwitter') return `https://fxtwitter.com/${handle}/status/${id}`
    if (config.linkStyle === 'vxtwitter') return `https://vxtwitter.com/${handle}/status/${id}`
    return link
  }

  function passesFilters(text: string): boolean {
    if (config.includeFilter) {
      try { if (!new RegExp(config.includeFilter, 'i').test(text)) return false } catch { log('warn', 'includeFilter 正则无效') }
    }
    if (config.excludeFilter) {
      try { if (new RegExp(config.excludeFilter, 'i').test(text)) return false } catch { log('warn', 'excludeFilter 正则无效') }
    }
    return true
  }

  // ---------------- 推送板块路由 ----------------
  //
  // 登录板块（X 登录 / DC 登录）只负责数据源连接；推送板块（XP 推送 / MFS 推送）
  // 各自独立配置 DC 推送频道、X 推送账号与推送的群聊。内容按来源归属板块：
  // X 推文按账号匹配，Discord 中转消息按频道匹配；同一内容可归属多个板块（目标去重并集），
  // 未归属任何板块时回退主设置的全局推送目标。
  // 兼容两种配置形态：旧 { platform, channelId } 单值 与 新 { platform, channelIds[] } 分组，
  // 统一展开为 { platform, channelId } 列表供运行时使用
  function flattenTargetGroups(groups: any[] = []): TargetConfig[] {
    const out: TargetConfig[] = []
    for (const group of groups ?? []) {
      const platform = String(group?.platform || '').trim()
      if (!platform) continue
      const ids: any[] = Array.isArray(group?.channelIds)
        ? group.channelIds
        : (group?.channelId ? [group.channelId] : [])
      for (const id of ids) {
        const channelId = String(id || '').trim()
        if (channelId) out.push({ platform, channelId })
      }
    }
    return out
  }

  const pushBoards = (): Array<{ accounts: string[], channels: string[], targets: TargetConfig[] }> => [
    { accounts: config.xpAccounts, channels: config.xpChannels, targets: flattenTargetGroups(config.xpTargets) },
    { accounts: config.mfsAccounts, channels: config.mfsChannels, targets: flattenTargetGroups(config.mfsTargets) },
  ]

  function mergeTargets(lists: TargetConfig[][]): TargetConfig[] {
    const targets: TargetConfig[] = []
    const seen = new Set<string>()
    for (const list of lists) {
      for (const target of list) {
        const key = `${target.platform}:${target.channelId}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ platform: target.platform, channelId: target.channelId })
      }
    }
    return targets
  }

  function targetsFor(account?: string, discordChannelId?: string): TargetConfig[] {
    const matched: TargetConfig[][] = []
    for (const board of pushBoards()) {
      const byAccount = !!account && board.accounts.some(name => name.toLowerCase() === account.toLowerCase())
      const byChannel = !!discordChannelId && board.channels.some(id => extractDiscordChannelId(id) === discordChannelId)
      if (byAccount || byChannel) matched.push(board.targets)
    }
    const targets = mergeTargets(matched)
    // 全局兜底目标同样去重，防止同一群在全局配置里出现多次导致重复推送
    return targets.length ? targets : mergeTargets([flattenTargetGroups(config.targets)])
  }

  // 两个推送板块的 X 账号并集（去重），作为轮询来源
  function allAccounts(): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    for (const account of [...config.xpAccounts, ...config.mfsAccounts]) {
      const name = account.trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(name)
    }
    return result
  }

  // 两个推送板块的 DC 频道并集（归一化去重），作为读取来源
  function allDiscordChannels(): string[] {
    return mergeBoardsChannelIds(config.xpChannels, config.mfsChannels)
  }

  function mergeBoardsChannelIds(...lists: string[][]): string[] {
    const ids = new Set<string>()
    for (const list of lists) {
      for (const value of list) {
        const id = extractDiscordChannelId(value)
        if (id) ids.add(id)
      }
    }
    return [...ids]
  }

  // cordis-http 的 "fetch ... failed" 会把真实原因（超时/DNS/连接重置等）
  // 藏在 error.cause 里，直接展示 message 无法定位问题。
  function describeHttpError(error: any): string {
    const message = String(error?.message || error || 'unknown error')
    const parts = [message]
    const cause = error?.cause ?? error?.errors?.[0]?.cause ?? error?.errors?.[0]
    if (cause) {
      if (cause?.code && !message.includes(String(cause.code))) parts.push(`(${cause.code})`)
      const causeMessage = String(cause?.message || cause)
      if (causeMessage && causeMessage !== message && !message.includes(causeMessage)) parts.push(causeMessage)
    }
    const status = error?.response?.status ?? error?.status
    if (status && !parts.some(p => p.includes(String(status)))) parts.push(`HTTP ${status}`)
    return parts.filter(Boolean).join(' ').slice(0, 300)
  }

  // OpenAI 标准格式 chat/completions 调用；瞬时网络失败自动重试一次，
  // 4xx（鉴权/参数问题）不重试。最终抛出的错误带根因描述。
  async function postChatCompletion(body: Record<string, any>): Promise<any> {
    const url = `${config.openaiBaseURL.replace(/\/$/, '')}/chat/completions`
    let lastError: any
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await ctx.http.post(url, body, {
          headers: { Authorization: `Bearer ${config.openaiApiKey}` },
          timeout: Math.max(config.requestTimeout, 60000),
        })
      } catch (error: any) {
        lastError = error
        const status = error?.response?.status ?? error?.status
        if (status && status < 500 && status !== 429) break
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
    throw new Error(describeHttpError(lastError))
  }

  async function translate(text: string): Promise<string | null> {
    if (!config.openaiApiKey) return null
    try {
      const res: any = await postChatCompletion({
        model: config.openaiModel,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
      })
      const content = res?.choices?.[0]?.message?.content?.trim()
      return content || null
    } catch (error: any) {
      ailog('warn', `翻译失败，仅发送原文: ${error?.message || error}`)
      return null
    }
  }

  function toOneBotImageFile(src: string): string {
    const markdownLink = src.trim().match(/^!?\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i)
    if (markdownLink) src = markdownLink[1]
    const base64Token = ';base64,'
    const index = src.indexOf(base64Token)
    if (index > -1) return `base64://${src.slice(index + base64Token.length)}`
    return src
  }

  function toOneBotSegments(message: any[]): Array<{ type: string, data: any }> {
    const result: Array<{ type: string, data: any }> = []
    for (const item of segment.normalize(message) as any[]) {
      if (!item || typeof item !== 'object') continue
      const type = String(item.type || '')
      if (type === 'text' && item.attrs?.content) result.push({ type: 'text', data: { text: String(item.attrs.content) } })
      if (type === 'img' || type === 'image') {
        const src = String(item.attrs?.src ?? item.attrs?.url ?? '')
        if (src) result.push({ type: 'image', data: { file: toOneBotImageFile(src) } })
      }
    }
    return result.length ? result : [{ type: 'text', data: { text: ' ' } }]
  }

  function extractOneBotId(value?: string): string | null {
    const matches = String(value ?? '').match(/\d+/g)
    return matches?.at(-1) || null
  }

  async function sendMergedForward(bot: any, channelId: string, nodes: any[][]): Promise<boolean> {
    if (bot?.platform !== 'onebot') return false
    const groupId = extractOneBotId(channelId)
    if (!groupId) return false
    const internal: any = bot.internal
    if (typeof internal?._get !== 'function' && typeof internal?._request !== 'function') return false
    const userId = extractOneBotId(bot.selfId) || '10000'
    const messages = nodes.map(content => ({
      type: 'node',
      data: { user_id: userId, nickname: 'X Relay', content: toOneBotSegments(content) },
    }))
    // 兼容 Go-CQHTTP（send_group_forward_msg）与 NapCat（send_forward_msg）
    const attempts: Array<[string, Record<string, any>]> = [
      ['send_group_forward_msg', { group_id: groupId, messages }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, message: messages }],
      ['send_forward_msg', { message_type: 'group', group_id: groupId, messages }],
    ]
    for (const [action, params] of attempts) {
      try {
        if (typeof internal?._get === 'function') {
          await internal._get(action, params)
          return true
        }
        if (typeof internal?._request === 'function') {
          await internal._request(action, params)
          return true
        }
      } catch (error: any) {
        plog('warn', `合并转发 ${action} 失败: ${error?.message || error}`)
      }
    }
    return false
  }

  // 截图推文原文：优先只截推文卡片元素（article[data-testid="tweet"]，即 Post 详情页的推文本体，
  // 不包含 X 侧边栏与下方推荐流）；找不到推文元素时回退整页截图。
  // 推文自带图片/视频时（hideMedia），截图前移除媒体区域，只保留文本与头部部分。
  async function captureTweetScreenshot(statusUrl: string, hideMedia = false): Promise<Buffer | null> {
    // 使用 koishi-plugin-puppeteer 提供的服务 API
    const puppeteer = ctx.puppeteer
    if (!puppeteer) {
      plog('warn', 'puppeteer 服务未安装，无法截图推文，回退文本推送')
      return null
    }
    const authToken = extractAuthToken(decodeAuthTokenCookie())
    let page: any = null
    try {
      page = await puppeteer.page()
      await page.setViewport({ width: 720, height: 900 })
      if (authToken) {
        await page.setCookie({ name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true }).catch(() => {})
      }
      plog('info', `截图推文页面: ${statusUrl}`)
      await page.goto(statusUrl, { waitUntil: 'networkidle2', timeout: Math.max(config.requestTimeout, 20000) })
      // 推文自带图片/视频时，截图前移除页面中的媒体区域，只保留文本与头部部分
      if (hideMedia) {
        await page.evaluate(() => {
          const selectors = [
            'img[src*="pbs.twimg.com/media"]',
            'img[src*="ton.twimg.com"]',
            'video',
            '[data-testid="tweetPhoto"]',
            '[data-testid="videoPlayer"]',
            '[data-testid="gifPlayable"]',
          ]
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(el => el.remove())
          }
        }).catch(() => {})
        await new Promise(res => setTimeout(res, 300))
      }
      // 只截推文卡片元素（Post 详情页本体），避免截到侧边栏与推荐内容
      const article = await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => null)
      if (article) {
        await new Promise(res => setTimeout(res, 800))
        const screenshot = await article.screenshot({ type: 'png' }) as Buffer
        if (screenshot.length >= 5000) {
          plog('info', '推文截图完成（仅推文卡片）', undefined, undefined, { size: screenshot.length })
          return screenshot
        }
        plog('warn', '推文卡片截图过小，回退整页截图', undefined, undefined, { size: screenshot.length })
      } else {
        plog('warn', '未找到推文卡片元素，回退整页截图')
      }
      // 回退：整页截图
      await new Promise(res => setTimeout(res, 1500))
      const screenshot = await page.screenshot({ type: 'png', fullPage: true }) as Buffer
      if (screenshot.length < 5000) {
        plog('warn', '推文截图过小，疑似空白页面，回退文本推送', undefined, undefined, { size: screenshot.length })
        return null
      }
      plog('info', '推文截图完成（整页）', undefined, undefined, { size: screenshot.length })
      return screenshot
    } catch (error: any) {
      plog('warn', `推文截图失败，回退文本推送: ${error?.message || error}`)
      return null
    } finally {
      if (page) await page.close().catch((error: any) => plog('warn', `关闭截图页面失败: ${error?.message || error}`))
    }
  }

  // 原图策略：pbs.twimg.com/media 图片地址改为 name=orig
  function toOriginalImageUrl(url: string): string {
    if (!config.useOriginalImages) return url
    if (!/^https?:\/\/pbs\.twimg\.com\/media\//i.test(url)) return url
    if (/[?&]name=[^&]+/.test(url)) return url.replace(/([?&])name=[^&]+/, '$1name=orig')
    return url + (url.includes('?') ? '&' : '?') + 'name=orig'
  }

  async function downloadMedia(url: string): Promise<Buffer | null> {
    try {
      const res = await ctx.http.get(url, {
        responseType: 'arraybuffer',
        timeout: Math.max(config.requestTimeout, 30000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Koishi/4.18' },
      })
      return Buffer.from(res as ArrayBuffer)
    } catch (error: any) {
      plog('warn', `媒体下载失败: ${url} ${error?.message || error}`)
      return null
    }
  }

  function mimeFromUrl(url: string, fallback: string): string {
    const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase() || ''
    const table: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4',
    }
    return table[ext] || fallback
  }

  let tempMediaSeq = 0
  async function writeTempMedia(buffer: Buffer, ext: string): Promise<string | null> {
    try {
      const dir = path.join(process.cwd(), 'data', 'x-relay-monitor', 'media')
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${Date.now()}-${tempMediaSeq++}.${ext}`)
      await fs.writeFile(file, buffer)
      return file
    } catch (error: any) {
      plog('warn', `媒体写入临时文件失败: ${error?.message || error}`)
      return null
    }
  }

  // 文件发送策略：图片按 imageSendMode 选择 buffer / url / base64 / file 传递方式
  // url 模式直传链接（无法加水印）；其余模式由服务器下载后加水印再发送
  async function buildImageSegment(url: string): Promise<any | null> {
    const target = toOriginalImageUrl(url)
    const mode = config.imageSendMode
    try {
      if (mode === 'url') return h.image(target)
      const buffer = await downloadMedia(target)
      if (!buffer) return null
      const mime = mimeFromUrl(target, 'image/png')
      const marked = await addWatermark(buffer, mime)
      if (mode === 'buffer') return h.image(marked, mime)
      if (mode === 'base64') return h.image(`data:${mime};base64,${marked.toString('base64')}`)
      const file = await writeTempMedia(marked, mime.split('/')[1] || 'png')
      return file ? h.image(`file://${file.replace(/\\/g, '/')}`) : null
    } catch (error: any) {
      plog('warn', `图片分段构建失败: ${error?.message || error}`)
      return null
    }
  }

  // 文件发送策略：视频按 videoSendMode 选择 buffer / url / base64 / file 传递方式
  async function buildVideoSegment(url: string): Promise<any | null> {
    const mode = config.videoSendMode
    try {
      if (mode === 'url') return h.video(url)
      const buffer = await downloadMedia(url)
      if (!buffer) return null
      if (mode === 'buffer') return h.video(buffer, 'video/mp4')
      if (mode === 'base64') return h.video(`data:video/mp4;base64,${buffer.toString('base64')}`)
      const file = await writeTempMedia(buffer, 'mp4')
      return file ? h.video(`file://${file.replace(/\\/g, '/')}`) : null
    } catch (error: any) {
      plog('warn', `视频分段构建失败: ${error?.message || error}`)
      return null
    }
  }

  // 真 GIF 可选：将 Twitter 动图（MP4）转为真正的 GIF，需 koishi-plugin-ffmpeg 服务
  async function convertGifVideo(url: string): Promise<Buffer | null> {
    const ffmpeg = (ctx as any).ffmpeg
    if (!ffmpeg?.builder) {
      plog('warn', '未检测到 koishi-plugin-ffmpeg 服务，无法将动图转为真 GIF')
      return null
    }
    const buffer = await downloadMedia(url)
    if (!buffer) return null
    try {
      return await ffmpeg.builder()
        .input(buffer)
        .outputOption('-vf', 'fps=12,scale=480:-1:flags=lanczos:force_original_aspect_ratio=decrease')
        .outputOption('-loop', '0')
        .run('buffer')
    } catch (error: any) {
      plog('warn', `GIF 转换失败: ${error?.message || error}`)
      return null
    }
  }

  // 将 Markdown 安全地转为 HTML，供文本卡片渲染（原文 / 译文支持 MD 格式）。
  // 先转义 HTML 实体防注入，再做行内与块级 MD 解析；链接仅允许 http(s)/mailto。
  function mdToHtml(md: string): string {
    const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const inline = (raw: string): string => {
      let t = escapeHtml(raw)
      t = t.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`)
      t = t.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      t = t.replace(/__([^_]+?)__/g, '<strong>$1</strong>')
      t = t.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
      t = t.replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/g, (_m, pre, c) => `${pre}<em>${c}</em>`)
      t = t.replace(/~~([^~]+?)~~/g, '<del>$1</del>')
      t = t.replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?\)/g, (_m, txt, url) => {
        const safe = /^(https?:\/\/|mailto:)/i.test(url) ? url : '#'
        return `<a href="${escAttr(safe)}" target="_blank" rel="noopener">${txt}</a>`
      })
      return t
    }
    const lines = (md || '').replace(/\r\n/g, '\n').split('\n')
    const out: string[] = []
    let i = 0
    let para: string[] = []
    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join('\n'))}</p>`)
        para = []
      }
    }
    while (i < lines.length) {
      const line = lines[i]
      const fence = line.match(/^```(.*)$/)
      if (fence) {
        flushPara()
        const code: string[] = []
        i++
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++ }
        i++ // 跳过闭合 fence
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        continue
      }
      if (/^\s*$/.test(line)) { flushPara(); i++; continue }
      const h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) { flushPara(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue }
      if (/^\s*>\s?/.test(line)) {
        flushPara()
        const q: string[] = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
        out.push(`<blockquote>${inline(q.join('\n'))}</blockquote>`)
        continue
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flushPara()
        const items: string[] = []
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++ }
        out.push(`<ul>${items.map(it => `<li>${inline(it)}</li>`).join('')}</ul>`)
        continue
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushPara()
        const items: string[] = []
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++ }
        out.push(`<ol>${items.map(it => `<li>${inline(it)}</li>`).join('')}</ol>`)
        continue
      }
      para.push(line)
      i++
    }
    flushPara()
    return out.join('')
  }

  // 原文/翻译强制以图片发送：把来源、原文、译文、时间渲染成文本卡片图，不允许使用文字消息
  async function renderTextCard(source: string, text: string, translated: string | null, pubDate: string, avatarUrl?: string): Promise<Buffer | null> {
    // 使用 koishi-plugin-puppeteer 提供的服务 API
    const puppeteer = ctx.puppeteer
    if (!puppeteer) {
      plog('warn', 'puppeteer 服务未安装，无法渲染文本卡片')
      return null
    }
    const esc = (value: string) => value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const avatarHtml = avatarUrl
      ? `<img class="avatar" src="${esc(avatarUrl)}" onerror="this.style.display='none'">`
      : ''
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin:0; background:transparent; font-family:'Microsoft YaHei','PingFang SC',sans-serif; }
      #card { display:inline-block; background:#15202b; color:#e7e9ea; padding:20px 24px; border-radius:16px; max-width:660px; box-sizing:border-box; position:relative; overflow:hidden; }
      .src { display:flex; align-items:center; gap:10px; font-size:15px; color:#8b98a5; margin-bottom:10px; }
      .avatar { width:44px; height:44px; border-radius:50%; object-fit:cover; flex:0 0 auto; }
      .text { font-size:17px; line-height:1.65; white-space:pre-wrap; word-break:break-word; }
      .text p { margin:0 0 6px; }
      .text h1, .text h2, .text h3, .text h4, .text h5, .text h6 { margin:8px 0 4px; line-height:1.3; }
      .text h1 { font-size:23px; } .text h2 { font-size:21px; } .text h3 { font-size:19px; } .text h4, .text h5, .text h6 { font-size:17px; }
      .text ul, .text ol { margin:6px 0; padding-left:22px; } .text li { margin:2px 0; }
      .text blockquote { margin:6px 0; padding:6px 12px; border-left:3px solid #38444d; color:#aab8c2; }
      .text code { background:#22303c; padding:1px 5px; border-radius:4px; font-family:Consolas,Menlo,monospace; font-size:15px; }
      .text pre { background:#22303c; padding:10px 12px; border-radius:8px; overflow:auto; margin:6px 0; white-space:pre-wrap; }
      .text pre code { background:none; padding:0; }
      .text a { color:#1d9bf0; text-decoration:none; }
      .text del { opacity:0.7; }
      .text strong { font-weight:700; }
      .trans { margin-top:14px; padding-top:14px; border-top:1px solid #38444d; color:#6cc4ff; }
      .trans-label { font-size:13px; color:#8b98a5; margin-bottom:6px; }
      .time { margin-top:14px; font-size:13px; color:#8b98a5; }
      #wm { position:absolute; left:50%; top:50%; overflow:hidden; pointer-events:none; transform:translate(-50%,-50%) rotate(-30deg); }
      #wm span { position:absolute; font-family:'Microsoft YaHei','PingFang SC',sans-serif; font-size:${config.watermarkSize}px; font-weight:bold; color:rgba(255,255,255,${watermarkAlpha()}); white-space:nowrap; }
    </style></head><body><div id="card">
      <div class="src">${avatarHtml}<span>${esc(source)}</span></div>
      <div class="text">${mdToHtml(text)}</div>
      ${translated ? `<div class="trans"><div class="trans-label">📄 译文</div><div class="text">${mdToHtml(translated)}</div></div>` : ''}
      ${pubDate ? `<div class="time">🕒 ${esc(pubDate)}</div>` : ''}
      <div id="wm"></div>
    </div></body></html>`
    let page: any = null
    try {
      page = await puppeteer.page()
      await page.setViewport({ width: 720, height: 200 })
      await page.setContent(html, { waitUntil: 'load' })
      // 等待头像等外链图片加载完成（失败不阻塞，由 onerror 隐藏坏图）
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})
      // 注入斜向平铺水印：整个网格随容器旋转 -30°，行距/列距固定，间距均匀且同斜线不会重叠
      await page.evaluate((text: string, size: number) => {
        const card = document.getElementById('card') as HTMLElement
        const wm = document.getElementById('wm') as HTMLElement
        if (!card || !wm) return
        const w = card.offsetWidth, h = card.offsetHeight
        // 实测渲染宽度：必须先设置与水印样式一致的字体，否则 measureText 按默认 10px 计算导致步长过小、水印重叠
        const c2d = document.createElement('canvas').getContext('2d')
        if (c2d) c2d.font = `bold ${size}px 'Microsoft YaHei', 'PingFang SC', sans-serif`
        const textWidth = c2d
          ? Math.max(size * 4, Math.ceil(c2d.measureText(text).width))
          : Math.max(size * 4, size * text.length)
        const stepX = Math.round(textWidth + size * 4)
        const stepY = Math.round(size * 3.5)
        // 旋转后的网格需覆盖整个卡片（按对角线长度计算），多留一列补偿奇数行错位
        const diag = Math.ceil(Math.sqrt(w * w + h * h))
        const gridW = diag + stepX * 3
        const gridH = diag + stepY * 2
        wm.style.width = gridW + 'px'
        wm.style.height = gridH + 'px'
        const cols = Math.ceil(gridW / stepX)
        const rows = Math.ceil(gridH / stepY)
        for (let r = 0; r < rows; r++) {
          // 奇数行向右错开半个步长，上下左右交错排布，避免同斜线连成一片
          const offsetX = (r % 2 === 1 ? stepX / 2 : 0) - stepX
          for (let c = 0; c < cols; c++) {
            const s = document.createElement('span')
            s.textContent = text
            s.style.left = offsetX + c * stepX + 'px'
            s.style.top = r * stepY + 'px'
            wm.appendChild(s)
          }
        }
      }, config.watermarkText, config.watermarkSize).catch(() => {})
      const card: any = await page.$('#card')
      const buffer: Buffer = card
        ? await card.screenshot({ type: 'png' })
        : await page.screenshot({ type: 'png', fullPage: true })
      if (buffer.length < 2000) {
        plog('warn', '文本卡片渲染过小，疑似空白')
        return null
      }
      return buffer
    } catch (error: any) {
      plog('warn', `文本卡片渲染失败: ${error?.message || error}`)
      return null
    } finally {
      if (page) await page.close().catch((error: any) => plog('warn', `关闭文本卡片页面失败: ${error?.message || error}`))
    }
  }

  // 不推送原始链接：移除文本中内嵌的推文链接（x.com / twitter.com / fx/vx 变体）与 t.co 短链，
  // 同时清理可能混入正文的消息元素序列化标记（<img>/<at>/<video> 等，防止发送时被再次解析）
  // 其他外部链接保留
  function stripTweetLinks(text: string): string {
    return text
      .replace(/https?:\/\/(?:\w+\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx|vxtwitter)\.com\/\S+/gi, '')
      .replace(/https?:\/\/t\.co\/\S+/gi, '')
      .replace(/<(img|at|video|record|audio|face|message|quote)\b[^>]*\/?>/gi, '')
      .replace(/<\/(img|at|video|record|audio|face|message|quote)>/gi, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // 按出现顺序提取文本中的全部链接（支持 Discord markdown [文字](<链接>) / [文字](链接) 与裸 URL），
  // markdown 链接保留链接文字（稍后翻译成中文拼进「原文链接」）；
  // 去重并过滤 x.com / twitter.com / t.co（推文自身链接已在消息头部单独附带）
  interface LinkItem { url: string, label?: string }
  function extractLinkItems(text: string): LinkItem[] {
    const items: LinkItem[] = []
    const seen = new Set<string>()
    const push = (url: string, label?: string) => {
      const clean = url.trim().replace(/^<|>$/g, '')
      if (!/^https?:\/\//i.test(clean)) return
      if (/(?:^|\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com|t\.co/i.test(clean)) return
      if (seen.has(clean)) return
      seen.add(clean)
      items.push({ url: clean, label: (label || '').trim() || undefined })
    }
    const re = /\[([^\]]*)\]\(\s*<([^>]+)>\s*\)|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()\[\]]+)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m[2]) push(m[2], m[1])
      else if (m[4]) push(m[4], m[3])
      else if (m[5]) push(m[5])
    }
    return items
  }

  // 批量翻译 markdown 链接文字（如 [SimBridge Guides] → simbridge指南），失败或行数不匹配时回退原文
  async function translateLinkLabels(labels: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    // 去重并跳过已含中文的文字（AI 译文中的 markdown 链接文字已是中文，无需再翻）
    const pending = [...new Set(labels.filter(l => l && !/[\u4e00-\u9fff]/.test(l)))]
    if (!config.openaiApiKey || !pending.length) return map
    try {
      const res: any = await postChatCompletion({
        model: config.openaiModel,
        messages: [
          {
            role: 'system',
            content: '你是链接文字翻译器。把用户提供的每一行链接文字翻译成简体中文；按原行序输出，每行只输出一个译文，不要输出编号、引号或其他内容。专有名词（如 SimBridge、A32NX）可保留原文。',
          },
          { role: 'user', content: pending.join('\n') },
        ],
        temperature: 0.3,
      })
      const content = String(res?.choices?.[0]?.message?.content || '').trim()
      if (!content) return map
      const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length !== pending.length) return map
      pending.forEach((label, i) => map.set(label, lines[i]))
    } catch (error: any) {
      ailog('warn', `链接文字翻译失败，使用原文: ${error?.message || error}`)
    }
    return map
  }

  // 从文本中移除链接（markdown 形式保留链接文字，裸 URL 整段移除），用于把链接单独拆出后清理正文
  function removeUrls(text: string): string {
    return text
      .replace(/\[([^\]]*)\]\(\s*<([^>]+)>\s*\)/g, '$1')
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '$1')
      .replace(/https?:\/\/[^\s<>()\[\]]+/gi, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .trim()
  }

  // 水印：斜向平铺，字号/透明度/文字在「主设置」中配置（透明度百分比越大越淡）
  function watermarkAlpha(): number {
    return Math.min(0.95, Math.max(0.05, 1 - config.watermarkOpacity / 100))
  }
  async function addWatermark(buffer: Buffer, mime = 'image/png'): Promise<Buffer> {
    const puppeteer = ctx.puppeteer
    if (!puppeteer) return buffer
    let page: any = null
    try {
      page = await puppeteer.page()
      await page.setViewport({ width: 1600, height: 1200 })
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
      const alpha = watermarkAlpha()
      const fontSize = config.watermarkSize
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body { margin: 0; }
        #wrap { position: relative; display: inline-block; }
        #wrap img { display: block; }
        #wm { position: absolute; left: 50%; top: 50%; overflow: hidden; pointer-events: none; transform: translate(-50%, -50%) rotate(-30deg); }
        #wm span { position: absolute; font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; font-size: ${fontSize}px; font-weight: bold; color: rgba(0, 0, 0, ${alpha}); text-shadow: 0 0 3px rgba(255, 255, 255, 0.55); white-space: nowrap; }
      </style></head><body><div id="wrap"><img id="pic" src="${dataUrl}"><div id="wm"></div></div></body></html>`
      await page.setContent(html, { waitUntil: 'load' })
      await page.waitForFunction("document.getElementById('pic') && document.getElementById('pic').naturalWidth > 0", { timeout: 15000 }).catch(() => {})
      // 斜向平铺水印：整个网格随容器旋转 -30°，行距/列距固定，间距均匀且同斜线不会重叠
      await page.evaluate((text: string, size: number) => {
        const img = document.getElementById('pic') as HTMLImageElement
        const wm = document.getElementById('wm') as HTMLElement
        if (!img || !wm) return
        const w = img.naturalWidth, hgt = img.naturalHeight
        img.width = w; img.height = hgt
        // 实测渲染宽度：必须先设置与水印样式一致的字体，否则 measureText 按默认 10px 计算导致步长过小、水印重叠
        const c2d = document.createElement('canvas').getContext('2d')
        if (c2d) c2d.font = `bold ${size}px 'Microsoft YaHei', 'PingFang SC', sans-serif`
        const textWidth = c2d
          ? Math.max(size * 4, Math.ceil(c2d.measureText(text).width))
          : Math.max(size * 4, size * text.length)
        const stepX = Math.round(textWidth + size * 4)
        const stepY = Math.round(size * 3.5)
        // 旋转后的网格需覆盖整张图片（按对角线长度计算），多留一列补偿奇数行错位
        const diag = Math.ceil(Math.sqrt(w * w + hgt * hgt))
        const gridW = diag + stepX * 3
        const gridH = diag + stepY * 2
        wm.style.width = gridW + 'px'
        wm.style.height = gridH + 'px'
        const cols = Math.ceil(gridW / stepX)
        const rows = Math.ceil(gridH / stepY)
        for (let r = 0; r < rows; r++) {
          // 奇数行向右错开半个步长，上下左右交错排布，避免同斜线连成一片
          const offsetX = (r % 2 === 1 ? stepX / 2 : 0) - stepX
          for (let c = 0; c < cols; c++) {
            const s = document.createElement('span')
            s.textContent = text
            s.style.left = offsetX + c * stepX + 'px'
            s.style.top = r * stepY + 'px'
            wm.appendChild(s)
          }
        }
      }, config.watermarkText, config.watermarkSize).catch(() => {})
      const wrap: any = await page.$('#wrap')
      if (!wrap) {
        plog('warn', `水印注入失败：未找到图片容器（原图 ${buffer.length} 字节），返回无水印图片`)
        return buffer
      }
      const shot: Buffer = await wrap.screenshot({ type: 'png' })
      if (shot.length <= 2000) {
        plog('warn', `水印截图过小（${shot.length} 字节），返回无水印图片`)
        return buffer
      }
      return shot
    } catch (error: any) {
      plog('warn', `图片加水印失败，返回无水印图片: ${error?.message || error}（原图 ${buffer.length} 字节）`)
      return buffer
    } finally {
      if (page) await page.close().catch((error: any) => plog('warn', `关闭水印页面失败: ${error?.message || error}`))
    }
  }

  // 内容指纹 + 目标群 维度的近期推送记录，用于跨链路去重
  const recentPushKeys = new Map<string, number>()
  const PUSH_DEDUP_WINDOW = 10 * 60 * 1000

  // 上一条推送「发完」的时刻，用于保证消息之间至少间隔 pushMsgInterval 毫秒
  let lastPushSentAt = 0

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function pushContentKey(account: string, text: string, link: string, id?: string): string | null {
    // 带推文链接的内容直接按推文 ID 归一（X 轮询与 DC 中转指向同一条推文时必然相同）
    const tweetId = `${link} ${text}`.match(/(?:x|twitter)\.com\/\w+\/status\/(\d+)/i)?.[1]
    if (tweetId) return `tweet:${tweetId}`
    const base = text
      .replace(/^RT @\S+?:?\s*/i, '')
      .replace(new RegExp(`^@?${account}\\s*[:：]\\s*`, 'i'), '')
      .replace(/\s+/g, ' ').trim()
    if (base) return `text:${base.slice(0, 160)}`
    // 纯图片 / 无文本消息（如 Discord 图片消息）回退到来源消息 ID，
    // 保证同一条消息仍能在「内容 + 目标群」维度去重，不会因为 contentKey 为 null 而漏掉去重
    if (id) return `id:${id}`
    return null
  }

  async function push(account: string, source: string, text: string, link: string, pubDate: string, images: string[] = [], videos: string[] = [], gifs: string[] = [], pushTargets?: TargetConfig[], avatarUrl?: string, dedupId?: string): Promise<number> {
    // Discord 中转内容按频道归属推送板块，X 推文按账号归属；pushTargets 优先
    const targets = pushTargets?.length ? pushTargets : targetsFor(account)
    if (!targets.length) {
      plog('warn', `来源 ${account} 没有可用推送目标，跳过`, account)
      return 0
    }

    // 内容级去重：同一条内容可能同时来自 X 轮询与 Discord 中转两条链路，
    // 两边的判重（lastIds / discordSeen）互不相通，同时命中两个板块的群会被重复推送。
    // 这里按内容指纹 + 目标群做窗口去重：优先取推文 ID，否则用归一化正文前缀。
    const contentKey = pushContentKey(account, text, link, dedupId)

    const translated = await translate(text)

    // 推送组装：
    // 1) 消息头部附带推文链接（linkStyle 决定原始 / fx / vx 形式）；
    // 2) 原文 + AI 译文渲染成文本卡片图发送（用户名左侧带头像）；
    // 3) 推文截图包含推文完整内容（含图片），不再屏蔽推文中的图片；
    // 4) 媒体（图片 / GIF / 视频）始终随消息单独发送，可保存原图。
    const bodyText = stripTweetLinks(removeUrls(text))
    // 链接提取与清理同时覆盖原文和译文（AI 翻译会把链接文字翻译成中文并保留裸 URL）；
    // markdown 链接保留链接文字，翻译后拼进「原文链接」（如 simbridge指南：https://...）
    const linkItems = extractLinkItems(`${text}\n${translated || ''}`)
    const linkLabelMap = await translateLinkLabels(linkItems.map(i => i.label!).filter(Boolean))
    const translatedClean = translated ? stripTweetLinks(removeUrls(translated)) : ''
    const screenshot = link ? await captureTweetScreenshot(link) : null
    const textCard = await renderTextCard(`@${account}`, bodyText, translatedClean, pubDate, avatarUrl)

    let mediaSkipped = 0
    const buildMediaSegments = async (): Promise<any[]> => {
      const out: any[] = []
      // 静态图片始终单独发送（截图无法保存原图、清晰度受限），与截图并存
      for (const image of images) {
        const seg = await buildImageSegment(image)
        if (seg) out.push(seg)
        else mediaSkipped++
      }
      // 真 GIF：动图 MP4 转为真正的 GIF 图片发送
      for (const gif of gifs) {
        if (config.realGif) {
          const buffer = await convertGifVideo(gif)
          if (buffer) {
            out.push(h.image(buffer, 'image/gif'))
            continue
          }
        }
        const seg = await buildVideoSegment(gif)
        if (seg) out.push(seg)
        else mediaSkipped++
      }
      for (const video of videos) {
        const seg = await buildVideoSegment(video)
        if (seg) out.push(seg)
        else mediaSkipped++
      }
      return out
    }

    // 组装：头部链接（文字）→ 文本卡片图（原文+译文）→ 推文截图 → 媒体
    const segments: any[] = []
    if (link) segments.push(buildLink(link))
    if (textCard) {
      segments.push(h.image(textCard, 'image/png'))
    } else {
      // 文本卡片不可用（puppeteer 渲染失败）时的文字兜底
      plog('warn', '文本卡片不可用，回退文字发送', account)
      const lines: string[] = []
      if (source) lines.push(source)
      if (bodyText) lines.push(bodyText)
      if (translatedClean) lines.push('', '📝 译文：', translatedClean)
      if (pubDate) lines.push('', `🕒 ${pubDate}`)
      segments.push(lines.join('\n'))
    }
    if (screenshot) {
      const marked = await addWatermark(screenshot, 'image/png')
      segments.push(h.image(marked, 'image/png'))
    }
    segments.push(...await buildMediaSegments())

    // 原文包含的链接单独一条（正文里已移除，方便点击）；
    // markdown 链接显示为「翻译后的链接文字：URL」（如 [SimBridge Guides](url) → simbridge指南：url），
    // 裸 URL 无链接文字，保持原样
    if (linkItems.length) {
      const lines = linkItems.map((item, i) => {
        const label = item.label ? (linkLabelMap.get(item.label) || item.label) : ''
        return `${i + 1}. ${label ? `${label}：` : ''}${item.url}`
      })
      segments.push(`🔗 原文链接：\n${lines.join('\n')}`)
    }

    // ---------------- 分批推送（防风控） ----------------
    // 两个维度限速：
    // ① 消息间隔：距上一条消息「发完」不足 pushMsgInterval 毫秒时先等待（一轮轮询补发多条推文时逐条拉开）；
    // ② 单条消息分批：目标群切成若干批，批内并发发送（每批最多同时发到 pushBatchSize 个群 = 默认 9），
    //    批与批之间等待 pushBatchDelay 毫秒，避免瞬时集中外发被平台判定为刷屏。
    const batchSize = Math.max(1, Math.min(50, Math.floor(config.pushBatchSize ?? 9) || 9))
    const batchDelay = Math.max(0, Math.floor(config.pushBatchDelay ?? 5000) || 0)
    const msgInterval = Math.max(0, Math.floor(config.pushMsgInterval ?? 3000) || 0)

    // 先做前置过滤与跨链路去重，得到本次真正要发送的目标
    const sendTargets: TargetConfig[] = []
    for (const target of targets) {
      // 防回环：推送板块内的 DC 频道本身不作为推送目标（频道 ID 归一化后比较）
      if (target.platform === 'discord' && allDiscordChannels().includes(extractDiscordChannelId(target.channelId) || '')) continue
      const dedupKey = contentKey ? `${contentKey}|${target.platform}:${target.channelId}` : null
      if (dedupKey) {
        const now = Date.now()
        const seenAt = recentPushKeys.get(dedupKey)
        if (seenAt != null) {
          if (now - seenAt < PUSH_DEDUP_WINDOW) {
            plog('info', `内容 ${Math.round((now - seenAt) / 1000)}s 前已推送过，跳过目标 ${target.platform}:${target.channelId}`, account)
            continue
          }
          recentPushKeys.delete(dedupKey)
        }
      }
      sendTargets.push(target)
    }
    if (!sendTargets.length) return 0

    // 消息间隔：每条消息发送前先等待 pushMsgInterval 毫秒（进程启动后的第一条不等待），
    // 保证相邻两条推送之间存在固定间隔，避免一轮轮询补发多条推文 / DC 连续多条消息时被判定为刷屏
    if (msgInterval > 0 && lastPushSentAt > 0) {
      plog('info', `推送间隔：等待 ${msgInterval}ms 后发送本条消息（防风控）`, account)
      await sleep(msgInterval)
      if (disposed) return 0
    }

    let sent = 0
    for (let offset = 0; offset < sendTargets.length; offset += batchSize) {
      const batch = sendTargets.slice(offset, offset + batchSize)
      const results = await Promise.all(batch.map(async (target) => {
        // Status 是数字枚举（ONLINE = 1），与字符串 'online' 比较永远为 false
        const bot = ctx.bots.find(b => b.platform === target.platform && (b.status as number) === 1) || ctx.bots.find(b => b.platform === target.platform)
        if (!bot) {
          plog('warn', `平台 ${target.platform} 没有可用机器人，无法推送到 ${target.channelId}`, account)
          return 0
        }
        try {
          let forwarded = false
          if (config.pushAsForward) {
            forwarded = await sendMergedForward(bot, target.channelId, segments.map(item => [item]))
          }
          if (!forwarded) await bot.sendMessage(target.channelId, segments)
          if (contentKey) {
            const dedupKey = `${contentKey}|${target.platform}:${target.channelId}`
            recentPushKeys.set(dedupKey, Date.now())
            if (recentPushKeys.size > 1000) {
              const now = Date.now()
              for (const [key, at] of recentPushKeys) {
                if (now - at > PUSH_DEDUP_WINDOW) recentPushKeys.delete(key)
              }
            }
          }
          if (config.notifySkippedMedia && mediaSkipped > 0) {
            try {
              await bot.sendMessage(target.channelId,
                `⚠️ 本条推文有 ${mediaSkipped} 个媒体未能随消息发送（视频或图片加载失败），请前往原推文查看。`)
            } catch (error: any) {
              plog('warn', `发送媒体跳过说明失败: ${error?.message || error}`, account)
            }
          }
          return 1
        } catch (error: any) {
          plog('warn', `推送到 ${target.platform}:${target.channelId} 失败: ${error?.message || error}`, account)
          return 0
        }
      }))
      sent += results.reduce((sum, value) => sum + value, 0)
      // 批间延迟：最后一批之后不再等待；插件卸载时立即中止剩余批次
      if (disposed) break
      if (batchDelay > 0 && offset + batchSize < sendTargets.length) {
        plog('info', `本批 ${batch.length} 个目标已发送，等待 ${batchDelay}ms 后继续（剩余 ${sendTargets.length - offset - batchSize} 个）`, account)
        await sleep(batchDelay)
        if (disposed) break
      }
    }
    // 记录本条消息「发完」的时刻，供下一条消息计算最小间隔
    lastPushSentAt = Date.now()
    return sent
  }

  // ---------------- Rettiwt 模式（API_KEY 登录，固定使用此方式） ----------------

  // API_KEY 即 base64("auth_token=<值>;ct0=<值>;twid=<值>;")，等同账号完整授权。
  // 兼容旧版配置：若填的是原始 cookie 串，自动转换为 base64，升级后无需手动更新配置。
  let rettiwt: Rettiwt | null = null
  let rettiwtKeyAt = ''

  function normalizeRettiwtApiKey(raw: string): string {
    const key = raw.trim()
    if (!key) return ''
    if (/^auth_token=/i.test(key)) return Buffer.from(key, 'utf8').toString('base64')
    try {
      if (/^auth_token=/i.test(Buffer.from(key, 'base64').toString('utf8'))) return key
    } catch { /* 非 base64，原样返回 */ }
    return key
  }

  function getRettiwt(): Rettiwt {
    const apiKey = normalizeRettiwtApiKey(config.rettiwtApiKey)
    if (!apiKey) throw new Error('未配置 Rettiwt API_KEY（获取方法见配置页说明）')
    if (!rettiwt || rettiwtKeyAt !== apiKey) {
      rettiwt = new Rettiwt({ apiKey, timeout: config.requestTimeout })
      rettiwtKeyAt = apiKey
      xlog('info', '已创建 Rettiwt 客户端（API_KEY 登录）')
    }
    return rettiwt
  }

  interface RettiwtTweet {
    id: string
    text: string
    images: string[]
    videos: string[]
    gifs: string[]
    author: string
    avatarUrl?: string
    createdAt: string
    isRetweet: boolean
  }

  function mapRettiwtTweet(tweet: any, account: string): RettiwtTweet | null {
    const id = String(tweet?.id ?? '')
    if (!id) return null
    let text = String(tweet?.fullText ?? '')
    if (config.includeQuote && tweet?.quoted?.fullText) {
      text += `\n\n引用 @${tweet.quoted?.tweetBy?.userName || ''}: ${tweet.quoted.fullText}`
    }
    const images: string[] = []
    const videos: string[] = []
    const gifs: string[] = []
    for (const item of (Array.isArray(tweet?.media) ? tweet.media : [])) {
      const type = String(item?.type || '').toUpperCase()
      const url = String(item?.url || '')
      if (!url) continue
      if (type === 'IMAGE') images.push(url)
      else if (type === 'GIF') gifs.push(url)
      else if (type === 'VIDEO') videos.push(url)
    }
    return {
      id,
      text,
      images,
      videos,
      gifs,
      author: String(tweet?.tweetBy?.userName || account),
      avatarUrl: String(tweet?.tweetBy?.avatarUrl || '') || undefined,
      createdAt: String(tweet?.createdAt || ''),
      isRetweet: !!tweet?.retweetedTweet || /^RT @/.test(text),
    }
  }

  // 错误详情化：rettiwt-api 对非 HTTP 错误只抛「Unknown error」，这里补充 code/status 与调用来源
  function describeRettiwtError(error: any): string {
    const parts: string[] = [String(error?.message || error || '未知错误')]
    if (error?.code) parts.push(`code=${error.code}`)
    if (error?.status) parts.push(`status=${error.status}`)
    const origin = String(error?.stack || '')
      .split('\n')
      .slice(1, 4)
      .map((line: string) => line.trim())
      .filter(Boolean)[0]
    if (origin) parts.push(origin)
    return parts.join('；')
  }

  // 先把账号解析为数字用户 ID 再拉时间线，避开 v7 用户名解析路径的兼容问题，并缓存结果
  const rettiwtUserIdCache = new Map<string, string>()

  async function resolveRettiwtUserId(account: string): Promise<string> {
    const cached = rettiwtUserIdCache.get(account)
    if (cached) return cached
    const client = getRettiwt()
    const user: any = await client.user.details(account)
    const id = String(user?.id ?? '')
    if (!id) throw new Error(`未返回用户 ID（账号不存在、已封禁或 API_KEY 权限不足）`)
    rettiwtUserIdCache.set(account, id)
    return id
  }

  async function fetchTimelineTweets(account: string): Promise<RettiwtTweet[]> {
    const client = getRettiwt()
    let userId: string
    try {
      userId = await resolveRettiwtUserId(account)
    } catch (error: any) {
      throw new Error(`解析账号 ${account} 失败：${describeRettiwtError(error)}（可运行「x诊断 ${account}」排查）`)
    }
    let res: any
    try {
      res = await client.user.timeline(userId, config.maxTweets)
    } catch (error: any) {
      throw new Error(`拉取 @${account} 时间线失败：${describeRettiwtError(error)}`)
    }
    const items: any[] = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : []
    const seen = new Set<string>()
    const out: RettiwtTweet[] = []
    for (const item of items) {
      const tweet = mapRettiwtTweet(item, account)
      // 时间线可能包含置顶推文，按 id 去重
      if (!tweet || seen.has(tweet.id)) continue
      seen.add(tweet.id)
      out.push(tweet)
    }
    return out
  }

  // ---------------- 浏览器回退（参考 koishi-plugin-twitter-fetcher v2 的获取方式） ----------------
  // rettiwt 的 GraphQL 时间线被 X 风控静默返回空时，用 Puppeteer 访问用户主页
  // 拿最新推文链接，再经 vxtwitter 解析正文与媒体，保证转发功能继续可用。

  function decodeAuthTokenCookie(): string {
    const raw = config.rettiwtApiKey.trim()
    if (!raw) return ''
    try {
      return /^auth_token=/i.test(raw) ? raw : Buffer.from(raw, 'base64').toString('utf8')
    } catch { return '' }
  }

  function extractAuthToken(cookie: string): string {
    return cookie.match(/auth_token=([^;]+)/i)?.[1] || ''
  }

  async function fetchLatestTweetUrlViaBrowser(account: string): Promise<{ url: string; avatar: string } | null> {
    const puppeteer = (ctx as any).puppeteer
    if (!puppeteer?.page) return null
    const authToken = extractAuthToken(decodeAuthTokenCookie())
    const page = await puppeteer.page()
    try {
      if (authToken) {
        await page.setCookie({ name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true })
      }
      await page.goto(`https://x.com/${account}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 20000 })
      // 同时取最新推文链接与作者头像（头像 = 选中推文卡片内的 profile_images 图片，
      // 对应主页时间线上第一条符合条件的推文，如 XPath .../article/.../a/div/img 所指）
      const latest = await page.evaluate((noRt: boolean) => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]')
        for (const article of articles) {
          const socialContextEl = article.querySelector('[data-testid="socialContext"]')
          if (socialContextEl) {
            const contextText = socialContextEl.textContent || ''
            if (/(pinned|已置顶|置顶|固定|置頂)/i.test(contextText)) continue
            if (noRt && /(retweeted|reposted|retweet|repost|转推|轉推|转发|已转帖)/i.test(contextText)) continue
          }
          const link = article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null
          if (link) {
            const avatarEl = article.querySelector('img[src*="profile_images"]') as HTMLImageElement | null
            return { url: link.href, avatar: avatarEl?.src || '' }
          }
        }
        return null
      }, config.excludeRetweets)
      return latest
    } finally {
      await page.close().catch(() => {})
    }
  }

  async function fetchTweetViaVxTwitter(account: string, tweetUrl: string): Promise<RettiwtTweet | null> {
    const tweetId = tweetUrl.match(/status\/(\d+)/)?.[1]
    if (!tweetId) return null
    const apiUrl = `https://api.vxtwitter.com/${account}/status/${tweetId}`
    const data: any = await ctx.http.get(apiUrl, {
      headers: { 'User-Agent': 'Koishi-X-Relay-Monitor' },
      responseType: 'text',
    })
    const parsed: any = typeof data === 'string' ? JSON.parse(data) : data
    if (!parsed || !parsed.text) return null
    const images: string[] = []
    const videos: string[] = []
    const gifs: string[] = []
    for (const item of (Array.isArray(parsed.media_extended) ? parsed.media_extended : [])) {
      const type = String(item?.type || '').toLowerCase()
      const url = String(item?.url || '')
      if (!url) continue
      if (type === 'image') images.push(url)
      else if (type === 'gif') gifs.push(url)
      else videos.push(url)
    }
    return {
      id: tweetId,
      text: String(parsed.text || ''),
      images,
      videos,
      gifs,
      author: String(parsed.user_screen_name || parsed.screen_name || account),
      // vxtwitter 响应没有固定的头像字段，尝试多个候选；通常为空，头像由 rettiwt user.details 的 profileImage 兜底
      avatarUrl: String(parsed.avatar_url || parsed.user_avatar_url || parsed.user_profile_image_url || parsed.profile_image_url || '') || undefined,
      createdAt: String(parsed.created_at || parsed.createdAt || ''),
      isRetweet: false,
    }
  }

  async function pollAccountViaRettiwt(account: string): Promise<string> {
    // 说明：X 当前对非浏览器主页返回精简页，rettiwt 内部 x-client-transaction-id 无法解析
    // ondemand chunk，主路径已整体失效（每次都抛 Unknown error）。因此这里直接走 Puppeteer
    // 浏览器回退获取最新一条推文，避免无意义的失败重试与告警刷屏。
    let tweets: RettiwtTweet[] = []
    try {
      const latest = await fetchLatestTweetUrlViaBrowser(account)
      if (latest?.url) {
        const tweet = await fetchTweetViaVxTwitter(account, latest.url)
        if (tweet) {
          tweet.avatarUrl = tweet.avatarUrl || latest.avatar || undefined
          tweets = [tweet]
          xlog('info', `已通过浏览器获取最新推文 ${tweet.id}`, account)
        }
      }
    } catch (error: any) {
      xlog('warn', `浏览器获取失败: ${error?.message || error}`, account)
    }
    if (!tweets.length) return `${account}: 时间线为空或拉取失败`

    const candidates = tweets.filter(tweet => !config.excludeRetweets || !tweet.isRetweet)
    const newest = candidates[0]?.id || tweets[0].id
    const last = lastIds[account]
    if (!last) {
      // 首次见到该账号：只记录基线，不补发历史
      lastIds[account] = newest
      await saveState()
      return `${account}: 首次采集，已记录基线 ${newest}（不补发历史）`
    }

    // 时间线为最新在前；仅推送基线之后的新推文
    const fresh = candidates.filter(tweet => tweet.id > last).sort((a, b) => a.id.localeCompare(b.id))
    lastIds[account] = newest
    let sent = 0
    let pushed = 0
    for (const tweet of fresh) {
      if (!passesFilters(tweet.text)) continue
      pushed++
      sent += await push(account, `@${tweet.author}`, tweet.text, `https://x.com/${account}/status/${tweet.id}`, tweet.createdAt, tweet.images, tweet.videos, tweet.gifs, undefined, tweet.avatarUrl, tweet.id)
    }
    await saveState()
    return `${account}: 新推文 ${fresh.length} 条（推送 ${pushed} 条），发送成功 ${sent} 群次`
  }

  // ---------------- RSS 模式 ----------------

  function parseFeed(xml: string, account: string): FeedItem[] {
    const items: FeedItem[] = []
    for (const raw of xml.split('<item>').slice(1)) {
      const body = raw.split('</item>')[0]
      const grab = (tag: string) => {
        const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
        return m ? m[1] : ''
      }
      const link = decodeHtml(grab('link')) || decodeHtml(grab('guid'))
      const id = link.match(/status\/(\d+)/)?.[1]
      if (!id) continue
      const title = decodeHtml(extractCdata(grab('title')))
      const description = decodeHtml(extractCdata(grab('description')))
      const images = [...description.matchAll(/<img[^>]+src="([^"]+)"/g)]
        .map(m => m[1])
        .filter(src => !/emoji|profile_images|\.svg/.test(src))
      const text = description || title
      const isRetweet = /^RT @/.test(title) || /^RT @/.test(description)
      items.push({ id, account, text, link, pubDate: decodeHtml(grab('pubDate')), images, videos: [], isRetweet })
    }
    return items
  }

  async function pollAccountViaRss(account: string): Promise<string> {
    let url = config.rssTemplate.replace('{account}', encodeURIComponent(account))
    if (config.rsshubAccessKey) url += (url.includes('?') ? '&' : '?') + `key=${encodeURIComponent(config.rsshubAccessKey)}`
    const res = await ctx.http.get(url, {
      responseType: 'text',
      timeout: config.requestTimeout,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Koishi/4.18' },
    })
    const xml = typeof res === 'string' ? res : String(res)
    const items = parseFeed(xml, account)
    if (!items.length) return `${account}: 源为空或解析失败`

    items.sort((a, b) => a.id.localeCompare(b.id))
    const newest = items[items.length - 1].id
    const last = lastIds[account]
    if (!last) {
      lastIds[account] = newest
      await saveState()
      return `${account}: 首次采集，已记录基线 ${newest}（${items.length} 条，不补发历史）`
    }

    const fresh = items.filter(item => item.id > last)
    lastIds[account] = newest
    let sent = 0
    let pushed = 0
    for (const item of fresh) {
      if (config.excludeRetweets && item.isRetweet) {
        xlog('info', `跳过转推 ${item.id}`)
        continue
      }
      if (!passesFilters(item.text)) continue
      pushed++
      sent += await push(account, `@${account}`, item.text, item.link, item.pubDate, item.images, item.videos, undefined, undefined, undefined, item.id)
    }
    await saveState()
    return `${account}: 新内容 ${fresh.length} 条（推送 ${pushed} 条），发送成功 ${sent} 群次`
  }

  async function pollAccount(account: string): Promise<string> {
    return config.sourceMode === 'rsshub'
      ? pollAccountViaRss(account)
      : pollAccountViaRettiwt(account)
  }

  async function pollOnce(manual: boolean): Promise<string> {
    if (polling) return '上一轮轮询尚未结束'
    const accounts = allAccounts()
    const discordChannels = allDiscordChannels()
    if (!accounts.length && !(config.discordEnabled && discordChannels.length)) return '未配置 X 推送账号或 DC 推送频道'
    polling = true
    const results: string[] = []
    try {
      for (const account of accounts) {
        if (disposed) break
        try {
          results.push(await pollAccount(account))
        } catch (error: any) {
          results.push(`${account}: 拉取失败 ${error?.message || error}`)
          xlog('warn', `拉取 ${account} 失败: ${error?.message || error}`)
        }
      }
      // 通过 DC 机器人读取推送板块内配置的中转频道内容
      if (config.discordEnabled && discordChannels.length) {
        try {
          results.push(await pollDiscord())
        } catch (error: any) {
          results.push(`Discord 中转读取失败: ${error?.message || error}`)
          dclog('warn', `Discord 中转读取失败: ${error?.message || error}`)
        }
      }
    } finally {
      polling = false
    }
    const summary = results.join('\n')
    log('info', `轮询完成${manual ? '（手动）' : ''}:\n${summary}`)
    return summary
  }

  // ---------------- Discord 中转（通过 DC 机器人读取指定频道内容） ----------------

  // 频道配置支持完整链接（discord.com/channels/服务器ID/频道ID）或纯频道 ID
  function extractDiscordChannelId(value: string): string | null {
    const text = String(value ?? '').trim()
    if (!text) return null
    const link = text.match(/discord(?:\.com|app\.com)\/channels\/\d+\/(\d+)/i)
    if (link) return link[1]
    const ids = text.match(/\d+/g)
    return ids?.at(-1) || null
  }

  function extractTwitterAccount(text: string): string {
    // 中转消息若以 @handle: 开头，则视为该账号的内容（用于账号级推送映射）
    const m = text.match(/^\s*@?([A-Za-z0-9_]{1,15})\s*[:：]\s*/)
    return m?.[1] || ''
  }

  async function relayMessage(message: any, channelId: string, botSelfId: string, markSeen = true, media?: DiscordRawMedia): Promise<number> {
    const messageId = String(message?.id || '')
    if (!messageId) return 0
    if (markSeen) {
      if (discordSeen.has(messageId)) return 0
      discordSeen.add(messageId)
      if (discordSeen.size > 400) {
        for (const id of [...discordSeen].slice(0, 200)) discordSeen.delete(id)
      }
    }
    // 跳过机器人自己发送的消息
    if (message.author?.id && String(message.author.id) === String(botSelfId)) return 0

    const text = String(message.content || '').trim()
    if (!text) {
      dclog('info', `跳过 Discord 消息 ${messageId}：内容为空（type=${message.type ?? '未知'}）`)
      return 0
    }
    if (config.excludeRetweets && /^RT @/.test(text)) {
      dclog('info', `跳过 Discord 消息 ${messageId}：命中排除转推`)
      return 0
    }
    if (!passesFilters(text)) {
      dclog('info', `跳过 Discord 消息 ${messageId}：命中包含/排除过滤`)
      return 0
    }

    const account = extractTwitterAccount(text)
    const authorName = String(message.author?.username || message.author?.user?.username || '')
    const source = account ? `@${account}（Discord 中转）` : authorName ? `@${authorName}（Discord 中转）` : `Discord 中转 #${channelId}`
    // emoji 短代码转真 emoji（无 embed 的消息在这里兜底转换；有 embed 时已在 mergeDiscordEmbeds 里处理过，重复执行幂等）
    const body = cleanDiscordText(text)
    // 按来源频道归属推送板块（XP 推送 / MFS 推送）
    const boardTargets = targetsFor(undefined, extractDiscordChannelId(channelId) || channelId)
    if (!boardTargets.length) {
      dclog('warn', `Discord 消息 ${messageId} 所在频道 ${channelId} 未匹配到任何推送目标（请确认该频道已加入 XP/MFS 板块的「DC 推送频道」，且板块配置了「推送的群聊」）`)
    }
    // DC 中转的媒体（embed 配图 / 附件）按开关决定是否随消息附带
    const images = config.dcRelayMedia ? (media?.images ?? []) : []
    const videos = config.dcRelayMedia ? (media?.videos ?? []) : []
    const sent = await push(account || authorName || `dc:${channelId}`, source, body, '', '', images, videos, [], boardTargets, undefined, messageId)
    dclog('info', `Discord 中转内容已推送 ${sent} 群次${images.length || videos.length ? `（附带 ${images.length} 图 / ${videos.length} 视频）` : ''}`)
    return sent
  }

  async function fetchChannelMessages(bot: any, channelId: string, after?: string, limit = 50, order: 'asc' | 'desc' = 'asc'): Promise<any[]> {
    const internal: any = bot.internal
    // satori v3 通用接口：getMessageList(channelId, next, direction, limit, order)
    if (typeof internal?.getMessageList === 'function') {
      const res: any = await internal.getMessageList(channelId, after, after ? 'after' : undefined, limit, order)
      return Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    }
    // 旧版 discord 适配器：getChannelMessages(channelId, config)
    if (typeof internal?.getChannelMessages === 'function') {
      const res: any = await internal.getChannelMessages(channelId, { after, limit })
      return Array.isArray(res) ? res : []
    }
    throw new Error('当前 Discord 适配器不支持读取频道消息')
  }

  // satori 适配器不解析 embed.description（公告 bot 常用 embed 发正文，content 为空），
  // 对 content 为空的轮询消息回源 REST 原始数据补全正文；
  // 同时兼容 Discord「转发」消息（本体 content 为空，读取 message_reference 指向的原消息）
  // ---------------- Discord embed 补全 ----------------
  // 公告 / 新闻类 Bot（如 FSNews）常把自己正文截断成「标题...」，完整标题、正文摘要与该条消息的
  // 配图都放在 embed 里。旧逻辑只在「正文为空」时才读 embed，导致这类消息推出去的卡片只有半句话。
  // 现在正文非空也会把 embed 的补充信息并入，并取出 embed 配图与附件媒体。

  interface DiscordRawMedia { images: string[], videos: string[] }

  // Discord 常见 emoji 短代码 → 真 emoji（未收录的短代码原样保留，不误删内容）
  const DISCORD_EMOJI: Record<string, string> = {
    newspaper: '📰', airplane: '✈️', airplane_arriving: '🛬', flight_departure: '🛫', luggage: '🧳',
    warning: '⚠️', information_source: 'ℹ️', mega: '📣', bell: '🔔', pushpin: '📌',
    round_pushpin: '📍', calendar: '📅', link: '🔗', memo: '📝', globe_with_meridians: '🌐',
    sparkles: '✨', rocket: '🚀', tada: '🎉', gift: '🎁', bulb: '💡', fire: '🔥',
    red_circle: '🔴', large_blue_circle: '🔵', white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌',
    hourglass: '⌛', alarm_clock: '⏰', package: '📦', computer: '💻', video_game: '🎮',
    joystick: '🕹️', camera: '📷', mag: '🔍', moneybag: '💰', map: '🗺️', cloud: '☁️',
    sun: '☀️', snowflake: '❄️', droplet: '💧', zap: '⚡', hammer_and_wrench: '🛠️',
    pencil: '✏️', book: '📖', clipboard: '📋', star: '⭐', ticket: '🎫', construction: '🚧',
    no_entry: '⛔', question: '❓', exclamation: '❗', triangular_flag_on_post: '🚩', tools: '🧰',
  }

  // DC 正文收尾清理：
  // ① 正文的标题被 Bot 截断成「标题...」、而 embed 给出了完整标题时，去掉省略号（否则卡片看起来少了一截）；
  // ② :newspaper: 这类 Discord emoji 短代码转成真 emoji，未收录的短代码保持原样。
  function cleanDiscordText(text: string, titles: string[] = []): string {
    const known = titles.map(normalizeForCompare).filter(Boolean)
    const lines = String(text || '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]
      if (known.length && /(?:\.{2,}|…)\s*$/.test(line)) {
        const head = line.replace(/\s*(?:\.{2,}|…)\s*$/, '')
        const normalized = normalizeForCompare(head)
        if (normalized && known.some(title => normalized.endsWith(title))) line = head
      }
      lines[i] = line.replace(/:([a-z0-9_+-]+):/gi, (raw, name: string) => DISCORD_EMOJI[name.toLowerCase()] || raw)
    }
    return lines.join('\n')
  }

  // 归一化：抹掉 emoji 短代码、链接、markdown 标记与截断省略号，用于「正文里是否已有这段文字」的判断
  function normalizeForCompare(value: string): string {
    return String(value || '')
      .replace(/:\w+:/g, ' ')                 // Discord emoji 短代码 :newspaper:
      .replace(/https?:\/\/\S+/gi, ' ')       // 链接（正文与 embed 中的写法可能不同）
      .replace(/[*_`~|>#]/g, ' ')             // markdown 标记
      .replace(/\.{2,}|…/g, ' ')              // 截断省略号
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  }

  // 正文为空，或像被 Bot 自身截断的预告（剔除末尾链接后以省略号收尾）→ 需要回源 REST 读 embed
  function needsEmbedLookup(content: string): boolean {
    const value = String(content || '').trim()
    if (!value) return true
    const head = value.replace(/(?:\s*<?https?:\/\/\S+>?)+\s*$/i, '').trim()
    return /(?:\.{2,}|…)\s*$/.test(head)
  }

  // 把 embed 的标题 / 摘要 / 字段并入正文（正文中已出现的不重复添加），并收集 embed 配图
  function mergeDiscordEmbeds(message: any, embeds: any[]): DiscordRawMedia {
    const media: DiscordRawMedia = { images: [], videos: [] }
    const body = String(message?.content || '').trim()
    const haystack = normalizeForCompare(body)
    const extras: string[] = []
    let bodyHasUrl = /https?:\/\//i.test(body)
    for (const embed of embeds ?? []) {
      const title = String(embed?.title || '').trim()
      const description = String(embed?.description || '').trim()
      const url = String(embed?.url || '').trim()
      if (title && !haystack.includes(normalizeForCompare(title))) extras.push(`**${title}**`)
      if (description && !haystack.includes(normalizeForCompare(description))) extras.push(description)
      for (const field of (Array.isArray(embed?.fields) ? embed.fields : [])) {
        const name = String(field?.name || '').trim()
        const value = String(field?.value || '').trim()
        const line = [name, value].filter(Boolean).join('：')
        if (line && !haystack.includes(normalizeForCompare(line))) extras.push(line)
      }
      // embed 自带的原文地址：正文里没有任何链接时补上，否则这条链接会整条丢掉
      if (url && !bodyHasUrl) {
        extras.push(url)
        bodyHasUrl = true
      }
      const image = String(embed?.image?.url || embed?.thumbnail?.url || '').trim()
      if (image) media.images.push(image)
    }
    if (extras.length) message.content = [body, ...extras].filter(Boolean).join('\n\n')
    message.content = cleanDiscordText(String(message.content || ''), embeds.map((e: any) => String(e?.title || '').trim()).filter(Boolean))
    return media
  }

  // 附件媒体（REST 原始 attachments）：图片入 images，视频入 videos
  function collectAttachmentMedia(attachments: any[]): DiscordRawMedia {
    const media: DiscordRawMedia = { images: [], videos: [] }
    for (const attachment of attachments ?? []) {
      const src = String(attachment?.url || '').trim()
      if (!src) continue
      const type = String(attachment?.content_type || '')
      if (type.startsWith('image/')) media.images.push(src)
      else if (type.startsWith('video/')) media.videos.push(src)
      else if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(src)) media.images.push(src)
      else if (/\.(mp4|webm|mov)(\?|$)/i.test(src)) media.videos.push(src)
    }
    return media
  }

  // 回源 REST 补全 DC 消息：用 embed 的完整标题 / 摘要 / 字段补全正文，并取出配图与附件媒体
  async function enrichDiscordMessage(bot: any, channelId: string, message: any): Promise<DiscordRawMedia> {
    const empty: DiscordRawMedia = { images: [], videos: [] }
    try {
      let raw: any = await bot.internal.getChannelMessage(channelId, String(message.id))
      if (raw && !String(raw.content || '').trim() && !(Array.isArray(raw.embeds) && raw.embeds.length) && raw.message_reference?.message_id) {
        // Discord「转发」消息：本体无正文，回源被转发的原消息
        const refChannelId = String(raw.message_reference.channel_id || channelId)
        try {
          const orig: any = await bot.internal.getChannelMessage(refChannelId, String(raw.message_reference.message_id))
          if (orig) {
            dclog('info', `Discord 转发消息 ...${String(message.id).slice(-6)} 已从原消息取得内容（轮询兜底）`)
            raw = orig
          }
        } catch (error: any) {
          // 降级：原内容不可得（bot 无原频道权限），推送占位说明 + 原消息直链，不再静默跳过
          const ref = raw.message_reference
          dclog('warn', `Discord 转发消息 ...${String(message.id).slice(-6)} 的原内容读取失败（原频道 ${refChannelId}，bot 可能无权访问该频道）：${error?.message || error}，已降级为链接推送`)
          message.content = `📎 该消息为 Discord「转发」，正文不随消息传输且机器人无权读取原频道，请点开链接在 Discord 查看：\nhttps://discord.com/channels/${String(ref.guild_id || '')}/${refChannelId}/${String(ref.message_id)}`
          return empty
        }
      }
      if (!raw) return empty
      // 正文为空（satori 未解出 / 转发消息回源）→ 先用回源到的 content
      if (!String(message.content || '').trim() && String(raw.content || '').trim()) {
        message.content = String(raw.content).trim()
      }
      const before = String(message.content || '').trim()
      const media = mergeDiscordEmbeds(message, Array.isArray(raw.embeds) ? raw.embeds : [])
      const after = String(message.content || '').trim()
      if (after !== before) {
        dclog('info', `Discord 消息 ...${String(message.id).slice(-6)} 已用 embed 补全内容（${before.length} → ${after.length} 字）`)
      }
      const attachment = collectAttachmentMedia(raw.attachments)
      return {
        images: [...media.images, ...attachment.images],
        videos: [...media.videos, ...attachment.videos],
      }
    } catch (error: any) {
      dclog('warn', `Discord 消息 ...${String(message.id).slice(-6)} 回源补全失败：${error?.message || error}`)
      return empty
    }
  }

  async function pollDiscordChannel(bot: any, channelId: string): Promise<string> {
    // 首次读取：只记录基线，不补发历史
    if (!lastMessageIds[channelId]) {
      const latest = await fetchChannelMessages(bot, channelId, undefined, 1, 'desc')
      lastMessageIds[channelId] = String(latest[0]?.id || '')
      await saveState()
      return `Discord #${channelId}: 首次读取，已记录基线 ${lastMessageIds[channelId] || '（频道为空）'}`
    }

    // 逐页读取基线之后的新消息（最多 5 页）
    const collected: any[] = []
    const seenIds = new Set<string>()
    let after: string | undefined = lastMessageIds[channelId]
    let maxId = lastMessageIds[channelId]
    for (let page = 0; page < 5; page++) {
      const batch = await fetchChannelMessages(bot, channelId, after, 50, 'asc')
      if (!batch.length) break
      for (const message of batch) {
        const id = String(message?.id || '')
        if (!id || seenIds.has(id)) continue
        seenIds.add(id)
        collected.push(message)
        if (id > maxId) maxId = id
      }
      if (batch.length < 50) break
      after = maxId
    }

    collected.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    lastMessageIds[channelId] = maxId
    let sent = 0
    for (const message of collected) {
      // 回源 REST 补全内容：正文被截断的用 embed 完整标题/摘要补齐，并取出 embed 配图与附件媒体
      const media = await enrichDiscordMessage(bot, channelId, message)
      sent += await relayMessage(message, channelId, bot.selfId, true, media)
    }
    await saveState()
    return `Discord #${channelId}: 新消息 ${collected.length} 条，推送成功 ${sent} 群次`
  }

  async function pollDiscord(): Promise<string> {
    // 通过 DC 机器人读取指定频道内容；基础设置指定了 APP ID 时固定使用该机器人，
    // 避免多个 Discord 机器人并存时与其他插件（如 DC-QQ 桥接）冲突。
    const candidates = ctx.bots.filter(b => b.platform === 'discord')
    const bot = (config.dcAppId
      ? candidates.find(b => b.selfId === config.dcAppId && (b.status as number) === 1)
        || candidates.find(b => b.selfId === config.dcAppId)
      : undefined)
      ?? candidates.find(b => (b.status as number) === 1)
      ?? candidates[0]
    if (!bot) return config.dcAppId
      ? `未找到 APP ID 为 ${config.dcAppId} 的 Discord 机器人`
      : 'Discord 没有可用机器人'
    const results: string[] = []
    const channelIds = allDiscordChannels()
    if (!channelIds.length) return '推送板块内未配置有效的 DC 推送频道'
    for (const channelId of channelIds) {
      if (disposed) break
      try {
        results.push(await pollDiscordChannel(bot, channelId))
      } catch (error: any) {
        results.push(`Discord #${channelId}: 读取失败 ${error?.message || error}`)
        dclog('warn', `读取 Discord 频道 ${channelId} 失败: ${error?.message || error}`)
      }
    }
    return results.join('\n') || 'Discord 中转频道列表为空'
  }

  // ---------------- Discord 实时推送（不等轮询周期） ----------------
  // Discord 机器人在线时通过 message-created 事件即时中转新消息，收到即推；
  // 定时轮询仍保留作为兜底（接收离线 / 事件错过期间的消息），discordSeen 去重避免重复推送。
  ctx.on('message-created', async (session) => {
    if (disposed || !config.discordEnabled) return
    const bot = session.bot
    if (!bot || bot.platform !== 'discord') return
    // 固定使用配置的 DC 机器人（与轮询一致），其它机器人（如 DC-QQ 桥接）的频道事件不处理
    if (config.dcAppId && String(bot.selfId) !== String(config.dcAppId)) {
      dclog('info', `收到 Discord 消息事件，但机器人 selfId=${bot.selfId} 与配置的 dcAppId 不一致，忽略（频道 ${session.channelId}）`)
      return
    }
    const channelId = String(session.channelId || '')
    if (!allDiscordChannels().includes(channelId)) {
      dclog('info', `Discord 消息 ...${String(session.messageId || '').slice(-6)} 来自未监听的频道 ${channelId}，忽略`)
      return
    }
    const messageId = String(session.messageId || '')
    if (!messageId || discordSeen.has(messageId)) return
    // 跳过机器人自身消息
    if (String(session.userId || '') === String(bot.selfId)) return
    dclog('info', `Discord 实时消息到达：频道 ${channelId}，消息 ...${messageId.slice(-6)}，作者 ${session.userId}`)

    // Discord 系统消息处理：API 的 content 不含客户端显示的完整文案（如频道跟随提示
    // 「XX 将 YY 加入了此频道」只有 YY），按消息类型拼装完整文案后再推送
    const rawD: any = (session as any).discord?.d || {}
    const rawType = Number(rawD.type ?? 0)
    let preText = ''
    if (rawType === 12) {
      // 频道跟随提示：content 为被加入的频道名，按客户端样式拼装
      const follower = String(rawD.author?.username || session.username || session.userId || '有人')
      preText = `${follower} 将「${String(rawD.content || '').trim()}」加入了此频道，最重要的更新都将显示在这里。`
      dclog('info', `Discord 频道跟随系统消息，已拼装完整文案（${preText.length} 字）`)
    } else if (rawType !== 0) {
      dclog('info', `跳过 Discord 系统消息（type=${rawType}，无实质正文）`)
      return
    }

    // 从事件元素中提取文本 / 图片 / 视频
    // 注意：Discord 消息里的 <https://...> 链接会被 h.parse 误解析为未知容器元素，
    // img/at 等真实元素可能嵌套其中 —— 必须递归提取，绝不能把元素 toString 塞进正文
    //（否则序列化标记会混入文本，发送时被再次解析成图片/@消息段，造成内容错乱）
    const textParts: string[] = []
    const images: string[] = []
    const videos: string[] = []
    // 跨发（crosspost）/引用消息的原文可能被 satori 包进 quote 元素，单独收集作为兜底
    const quoteParts: string[] = []
    const quoteImages: string[] = []
    const collectElements = (el: any, texts: string[], imgs: string[], vids: string[]): void => {
      if (!el || typeof el !== 'object') return
      const type = String(el.type || '')
      if (type === 'text') {
        texts.push(String(el.attrs?.content ?? ''))
        return
      }
      if (type === 'img' || type === 'image') {
        const src = String(el.attrs?.src || el.attrs?.url || '')
        if (src) imgs.push(src)
        return
      }
      if (type === 'video') {
        const src = String(el.attrs?.src || el.attrs?.url || '')
        if (src) vids.push(src)
        return
      }
      if (type === 'face' || type === 'at' || type === 'sharp' || type === 'author') return
      // 未知容器元素（如被误解析的 <https://...> 链接）：递归提取子元素，不输出序列化串
      for (const child of el.children ?? []) collectElements(child, texts, imgs, vids)
    }
    for (const el of session.elements ?? []) {
      const type = String(el.type || '')
      if (type === 'quote') {
        for (const child of el.children ?? []) collectElements(child, quoteParts, quoteImages, videos)
      } else {
        collectElements(el, textParts, images, videos)
      }
    }
    let text = preText || textParts.join('').trim()
    let images2 = images
    // 正文为空但引用里有内容（公告跨发的常见形态）→ 使用引用内容作为正文
    if (!text && !images2.length && (quoteParts.join('').trim() || quoteImages.length)) {
      text = quoteParts.join('').trim()
      images2 = [...quoteImages, ...images]
    }
    // 需要回源 REST 的三种情况：
    // ① 正文为空（embed 公告）；② 正文被公告 Bot 自己截断成「标题...」（完整标题/摘要/配图都在 embed 里）；
    // ③ 事件元素没解出任何媒体，但 gateway 原始数据表明这条消息带附件 / embed（否则配图会丢）
    const gatewayAttachments = Array.isArray(rawD.attachments) ? rawD.attachments.length : 0
    const gatewayEmbeds = Array.isArray(rawD.embeds) ? rawD.embeds.length : 0
    if (needsEmbedLookup(text) || (!images2.length && (gatewayAttachments > 0 || gatewayEmbeds > 0))) {
      dclog('info', `Discord 实时消息 ...${messageId.slice(-6)} 正文为空/被截断或媒体缺失，尝试回源 REST 获取原始消息...`)
      try {
        const raw: any = await bot.internal.getChannelMessage(channelId, messageId)
        dclog('info', `回源 REST 响应：content ${String(raw?.content ?? '').length} 字、embeds ${Array.isArray(raw?.embeds) ? raw.embeds.length : 0} 条、attachments ${Array.isArray(raw?.attachments) ? raw.attachments.length : 0} 个`)
        if (raw) {
          const rawText = String(raw.content || '').trim()
          if (!text && rawText) {
            text = rawText
            dclog('info', `Discord 实时消息 ...${messageId.slice(-6)} 已回源 REST 取得正文（${text.length} 字）`)
          }
          // embed 的标题 / 摘要 / 字段并入正文（正文已有的不重复添加）
          const shell: any = { content: text }
          const embedMedia = mergeDiscordEmbeds(shell, Array.isArray(raw.embeds) ? raw.embeds : [])
          if (String(shell.content || '').trim().length > text.trim().length) {
            const added = String(shell.content).trim().length - text.trim().length
            text = String(shell.content).trim()
            dclog('info', `Discord 实时消息 ...${messageId.slice(-6)} 已用 embed 补全正文（新增 ${added} 字）`)
          }
          if (!images2.length) {
            // embed 配图 + 附件图片/视频
            images2.push(...embedMedia.images)
            const attachment = collectAttachmentMedia(raw.attachments)
            images2.push(...attachment.images)
            videos.push(...attachment.videos)
          }
          // Discord「转发」消息：本体 content 为空，只有 message_reference 指回原消息
          const ref = raw.message_reference
          if (!text && ref?.message_id) {
            const refChannelId = String(ref.channel_id || channelId)
            try {
              const orig: any = await bot.internal.getChannelMessage(refChannelId, String(ref.message_id))
              const origEmbedText = (Array.isArray(orig?.embeds) ? orig.embeds : [])
                .map((e: any) => [String(e.title || '').trim(), String(e.description || '').trim()]
                  .filter(Boolean).join('\n'))
                .filter(Boolean).join('\n\n')
              text = String(orig?.content || '').trim() || origEmbedText
              if (!images2.length) {
                for (const e of (Array.isArray(orig?.embeds) ? orig.embeds : [])) {
                  const src = String(e.image?.url || e.thumbnail?.url || '')
                  if (src) images2.push(src)
                }
                for (const a of (Array.isArray(orig?.attachments) ? orig.attachments : [])) {
                  const type = String(a.content_type || '')
                  const src = String(a.url || '')
                  if (!src) continue
                  if (type.startsWith('image/')) images2.push(src)
                  else if (type.startsWith('video/')) videos.push(src)
                }
              }
              if (text) {
                dclog('info', `Discord 实时消息 ...${messageId.slice(-6)} 为转发消息，已从原消息取得正文（${text.length} 字）`)
              } else {
                dclog('warn', `Discord 转发消息 ...${messageId.slice(-6)} 的原消息（频道 ${refChannelId}）也没有可提取的正文`)
              }
            } catch (error: any) {
              // 降级：原内容不可得（bot 无原频道权限），推送占位说明 + 原消息直链
              dclog('warn', `Discord 转发消息 ...${messageId.slice(-6)} 的原内容读取失败（原频道 ${refChannelId}，bot 可能无权访问该频道）：${error?.message || error}，已降级为链接推送`)
              const refGuildId = String(raw?.message_reference?.guild_id || '')
              text = `📎 该消息为 Discord「转发」，正文不随消息传输且机器人无权读取原频道，请点开链接在 Discord 查看：\nhttps://discord.com/channels/${refGuildId}/${refChannelId}/${String(ref?.message_id || '')}`
            }
          }
        }
      } catch (error: any) {
        dclog('warn', `Discord 实时消息 ...${messageId.slice(-6)} 回源 REST 失败：${error?.message || error}`)
      }
    }
    if (!text && !images2.length) {
      const rawInfo = (() => {
        try {
          const d = (session as any)?.discord?.d
          return d ? `gateway原始：content ${String(d.content ?? '').length} 字、embeds ${Array.isArray(d.embeds) ? d.embeds.length : 0} 条、attachments ${Array.isArray(d.attachments) ? d.attachments.length : 0} 个、webhook_id=${d.webhook_id ?? '无'}` : 'session.discord 原始数据不可用'
        } catch { return '原始数据读取失败' }
      })()
      dclog('warn', `Discord 实时消息 ...${messageId.slice(-6)} 无有效正文与媒体，跳过。元素类型=[${(session.elements ?? []).map(el => String(el.type || '')).join(',') || '（无元素）'}]，${rawInfo}`)
      return
    }

    // 记入去重集合（正式轮询读到同一条消息时会跳过）
    discordSeen.add(messageId)
    if (discordSeen.size > 400) {
      for (const id of [...discordSeen].slice(0, 200)) discordSeen.delete(id)
    }

    if (config.excludeRetweets && /^RT @/.test(text)) {
      dclog('info', `跳过 Discord 实时消息 ...${messageId.slice(-6)}：命中排除转推`)
      return
    }
    if (!passesFilters(text)) {
      dclog('info', `跳过 Discord 实时消息 ...${messageId.slice(-6)}：命中包含/排除过滤`)
      return
    }

    const authorName = String(session.author?.username || session.username || '')
    const account = extractTwitterAccount(text)
    const source = account ? `@${account}（Discord 中转）` : authorName ? `@${authorName}（Discord 中转）` : `Discord 中转 #${channelId}`
    const boardTargets = targetsFor(undefined, channelId)
    if (!boardTargets.length) {
      dclog('warn', `Discord 实时消息 ${messageId} 所在频道 ${channelId} 未匹配到任何推送目标（请确认该频道已加入 XP/MFS 板块的「DC 推送频道」）`)
      return
    }
    dclog('info', `开始推送 Discord 实时消息 ...${messageId.slice(-6)}：正文 ${text.length} 字、图 ${images2.length}、视频 ${videos.length}，目标 ${boardTargets.length} 个`)
    // DC 中转的媒体按开关决定是否随消息附带；正文里残留的 emoji 短代码一并转成真 emoji
    const relayText = cleanDiscordText(text)
    const relayImages = config.dcRelayMedia ? images2 : []
    const relayVideos = config.dcRelayMedia ? videos : []
    try {
      const sent = await push(account || authorName || `dc:${channelId}`, source, relayText, '', '', relayImages, relayVideos, [], boardTargets, undefined, messageId)
      dclog('info', `Discord 实时消息已推送 ${sent} 群次（频道 ${channelId}，消息 ...${messageId.slice(-6)}）`)
    } catch (error: any) {
      dclog('warn', `Discord 实时消息推送失败: ${error?.message || error}`)
    }
  })

  // ---------------- 在线获取可用模型 ----------------

  async function refreshModels(): Promise<string[] | null> {
    if (!config.openaiApiKey || !config.openaiBaseURL) return null
    try {
      const base = config.openaiBaseURL.replace(/\/$/, '')
      const res: any = await ctx.http.get(`${base}/models`, {
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        timeout: config.requestTimeout,
      })
      const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
      const mapped: string[] = list
        .map((item: any): string => String(item?.id ?? item?.name ?? item ?? '').trim())
        .filter((id): id is string => !!id)
      const models = [...new Set<string>(mapped)].sort((a, b) => a.localeCompare(b))
      if (!models.length) {
        ailog('warn', '模型接口返回空列表')
        return null
      }
      availableModels = models
      lastOpenaiModel = config.openaiModel || lastOpenaiModel
      // 缓存到磁盘，重启后面板与配置校验依然可用
      await fs.mkdir(path.dirname(modelCacheFile), { recursive: true })
      await fs.writeFile(modelCacheFile, JSON.stringify({ models, selected: config.openaiModel || lastOpenaiModel }, null, 2))
      // 重建 Schema 导出，控制面板重新打开配置页即可看到下拉列表
      Config = buildConfigSchema()
      ailog('info', `已获取 ${models.length} 个可用模型，可在「AI 翻译设置」下拉选择`)
      return models
    } catch (error: any) {
      ailog('warn', `获取可用模型列表失败: ${error?.message || error}`)
      return null
    }
  }

  // ---------------- 指令 ----------------

  ctx.command('x频道测试 [channel:text]', '读取指定 Discord 频道的最新一条消息并按推送版式发送（验证 DC 中转链路，不占用正式推送的去重记录）')
    .action(async ({ session }, channel?: string) => {
      if (!session) return '❌ 无法获取会话信息，请稍后重试。'
      const channelId = extractDiscordChannelId((channel || allDiscordChannels()[0] || '').trim())
      if (!channelId) return '未提供有效的频道 ID / 频道链接，且插件未配置任何 DC 推送频道。'
      const candidates = ctx.bots.filter(b => b.platform === 'discord')
      const bot = (config.dcAppId ? candidates.find(b => b.selfId === config.dcAppId) : undefined) ?? candidates.find(b => (b.status as number) === 1) ?? candidates[0]
      if (!bot) return config.dcAppId ? `未找到 APP ID 为 ${config.dcAppId} 的 Discord 机器人` : 'Discord 没有可用机器人'
      let messages: any[] = []
      try {
        messages = await fetchChannelMessages(bot, channelId, undefined, 5, 'desc')
      } catch (error: any) {
        return `✘ 读取频道 ${channelId} 失败：${error?.message || error}（请确认机器人已加入该频道所在服务器并有读取权限）`
      }
      const message = messages.find(m => String(m?.author?.id || '') !== String(bot.selfId))
      if (!message) return `Discord #${channelId} 最新的 ${messages.length} 条消息均为机器人自身发送，无可测试内容。`
      await session.send(`正在读取频道 ${channelId} 的最新消息（ID ...${String(message.id).slice(-6)}）并按推送版式发送...`)
      const sent = await relayMessage(message, channelId, bot.selfId, false)
      return sent > 0
        ? `✔ 测试完成：已按推送版式发送该消息（消息 ID ...${String(message.id).slice(-6)}）。`
        : '✘ 消息被跳过，未发送（原因见「DC 推送」日志：自身消息 / 空内容 / 命中过滤 / 无匹配推送目标）。'
    })

  ctx.command('x模型刷新', '在线获取翻译 API 的可用模型列表（用于控制面板下拉选择）')
    .action(async () => {
      const models = await refreshModels()
      if (!models) return '获取模型列表失败：请先在「AI 翻译设置」中配置 API Key 与 API 地址，并检查网络。'
      return `已获取 ${models.length} 个可用模型，请重新打开控制面板「AI 翻译设置」在下拉列表中选择。\n${models.join('、')}`
    })

  // ---------------- XP / MFS（微软）推送订阅指令（仅群管理员 / 超级管理员，其他用户不输出） ----------------

  // 是否本群群主/群管理员：优先用会话自带角色，OneBot 下兜底查询群成员信息
  async function isGroupAdmin(session: any): Promise<boolean> {
    const userId = String(session?.userId || '')
    const guildId = String(session?.guildId || session?.channelId || '')
    if (!userId || !guildId) return false
    // satori 会话自带角色（onebot 适配器填充 owner/admin/member）
    const roles: any = (session as any)?.author?.roles ?? (session as any)?.user?.roles
    if (Array.isArray(roles) && roles.some((r: any) => r === 'owner' || r === 'admin')) return true
    // OneBot 兜底：查群成员信息（getGroupMemberInfo 返回 { data: { role } } 形态）
    try {
      const internal: any = session?.bot?.internal
      if (typeof internal?.getGroupMemberInfo === 'function') {
        const res = await internal.getGroupMemberInfo(guildId, userId)
        const role = res?.data?.role || res?.role
        return role === 'owner' || role === 'admin'
      }
    } catch { /* 查询失败视为无权限 */ }
    return false
  }

  // 订阅指令权限：超级管理员 或 本群群主/群管理员
  async function canUseSubscribeCommand(session: any): Promise<boolean> {
    if (!session) return false
    const userId = String(session.userId || '')
    if (userId && (config.superAdmins || []).map(String).includes(userId)) return true
    return isGroupAdmin(session)
  }

  // 板块推送目标分组键：XP → xpTargets，MFS（微软）→ mfsTargets
  type BoardTargetsKey = 'xpTargets' | 'mfsTargets'

  // 把当前群加入指定板块的推送目标（兼容旧 { platform, channelId } 单值形态）
  function upsertBoardTarget(key: BoardTargetsKey, platform: string, channelId: string) {
    const list: any[] = Array.isArray((config as any)[key]) ? (config as any)[key] : []
    ;(config as any)[key] = list
    let group: any = list.find(g => String(g?.platform || '') === platform)
    if (!group) {
      group = { platform, channelIds: [] }
      list.push(group)
    }
    if (!Array.isArray(group.channelIds)) {
      group.channelIds = group.channelId ? [String(group.channelId)] : []
      delete group.channelId
    }
    if (!group.channelIds.map(String).includes(channelId)) group.channelIds.push(channelId)
  }

  function removeBoardTarget(key: BoardTargetsKey, platform: string, channelId: string): boolean {
    const groups: any[] = Array.isArray((config as any)[key]) ? (config as any)[key] : []
    let removed = false
    const next: any[] = []
    for (const group of groups) {
      const ids: string[] = Array.isArray(group?.channelIds)
        ? group.channelIds.map(String)
        : (group?.channelId ? [String(group.channelId)] : [])
      const filtered = ids.filter(id => !(String(group.platform) === platform && id === channelId))
      if (filtered.length !== ids.length) removed = true
      if (filtered.length) next.push({ platform: String(group.platform), channelIds: filtered })
    }
    ;(config as any)[key] = next
    return removed
  }

  // 把修改后的运行时配置写回 koishi.yml（loader 不可写 / 写入失败时仅运行时生效）
  async function persistPluginConfig(): Promise<boolean> {
    try {
      const loader: any = (ctx as any).loader
      if (!loader?.writable) return false
      const kRecord = Symbol.for('koishi.loader.record')
      const parentScope: any = ctx.scope.parent.scope
      const record = parentScope[kRecord] || {}
      const key = Object.keys(record).find(k => record[k] === ctx.scope)
      if (!key) return false
      parentScope.config[key] = config
      await loader.writeConfig()
      return true
    } catch {
      return false
    }
  }

  // 订阅/取消订阅指令通用实现：boardName 用于提示文案，key 指向板块推送目标
  async function subscribeAction(session: any, key: BoardTargetsKey, boardName: string): Promise<string> {
    const platform = String(session.platform)
    const channelId = String(session.channelId)
    const existed = flattenTargetGroups((config as any)[key]).some(t => t.platform === platform && t.channelId === channelId)
    if (existed) return `ℹ️ 本群已在${boardName}推送目标中，无需重复订阅。`
    upsertBoardTarget(key, platform, channelId)
    const saved = await persistPluginConfig()
    const savedNote = saved ? '' : '\n⚠️ 配置文件写入失败，本次订阅仅运行时生效（重启后丢失），详情见日志。'
    return `✅ 本群已订阅${boardName}推送，后续${boardName}板块内容将推送到本群。${savedNote}`
  }

  async function unsubscribeAction(session: any, key: BoardTargetsKey, boardName: string): Promise<string> {
    const platform = String(session.platform)
    const channelId = String(session.channelId)
    const removed = removeBoardTarget(key, platform, channelId)
    if (!removed) return `ℹ️ 本群未订阅${boardName}推送，无需取消。`
    const saved = await persistPluginConfig()
    const savedNote = saved ? '' : '\n⚠️ 配置文件写入失败，本次取消仅运行时生效（重启后丢失），详情见日志。'
    return `✅ 本群已取消订阅${boardName}推送，后续不再向本群推送。${savedNote}`
  }

  ctx.command('x订阅XP推送', '将本群加入 XP 推送目标（仅群管理员/超级管理员可用）')
    .alias('订阅XP')
    .action(async ({ session }) => {
      if (!session?.channelId || !session?.platform) return
      // 非超管/群管理：不输出任何提示
      if (!(await canUseSubscribeCommand(session))) return
      return subscribeAction(session, 'xpTargets', 'XP')
    })

  ctx.command('x取消XP推送', '将本群移出 XP 推送目标（仅群管理员/超级管理员可用）')
    .alias('取消订阅XP')
    .action(async ({ session }) => {
      if (!session?.channelId || !session?.platform) return
      // 非超管/群管理：不输出任何提示
      if (!(await canUseSubscribeCommand(session))) return
      return unsubscribeAction(session, 'xpTargets', 'XP')
    })

  ctx.command('x订阅MFS推送', '将本群加入微软（MFS）新闻推送目标（仅群管理员/超级管理员可用）')
    .alias('订阅MFS')
    .alias('订阅微软')
    .action(async ({ session }) => {
      if (!session?.channelId || !session?.platform) return
      // 非超管/群管理：不输出任何提示
      if (!(await canUseSubscribeCommand(session))) return
      return subscribeAction(session, 'mfsTargets', '微软（MFS）')
    })

  ctx.command('x取消MFS推送', '将本群移出微软（MFS）新闻推送目标（仅群管理员/超级管理员可用）')
    .alias('取消订阅MFS')
    .alias('取消订阅微软')
    .action(async ({ session }) => {
      if (!session?.channelId || !session?.platform) return
      // 非超管/群管理：不输出任何提示
      if (!(await canUseSubscribeCommand(session))) return
      return unsubscribeAction(session, 'mfsTargets', '微软（MFS）')
    })

  ctx.command('用户推送测试 [account:text]', '测试指定 X 账号：按推送版式发送最新推文（文本卡片图 + 截图 + 媒体，正文 API 翻译）')
    .action(async ({ session }, account?: string) => {
      const target = (account || allAccounts()[0] || '').trim()
      const lines: string[] = []
      if (!session) return '❌ 无法获取会话信息，请稍后重试。'

      // 正在查询提示（测试结束后撤回）
      let statusMessageIds: any[] = []
      try {
        statusMessageIds = await session.send(`正在查询 ${target || '默认账号'} 的最新推文...`)
      } catch {}

      try {
        // 1. API_KEY 格式校验（不输出任何 Cookie 值）
        const raw = config.rettiwtApiKey.trim()
        if (!raw) { await session.send('✘ 未配置 Rettiwt API_KEY（X 登录板块）。'); return }
        let cookie = ''
        try {
          cookie = /^auth_token=/i.test(raw) ? raw : Buffer.from(raw, 'base64').toString('utf8')
        } catch { cookie = '' }
        if (!/^auth_token=/i.test(cookie)) {
          await session.send('✘ API_KEY 不是有效的 base64 cookie 串（解码后应包含 auth_token=...），请按配置页说明重新生成。')
          return
        }
        const hasField = (name: string) => new RegExp(`${name}=([^;]*)`, 'i').test(cookie)
        if (!hasField('auth_token') || !hasField('ct0')) {
          lines.push('⚠ 缺少必要 Cookie 字段，请重新从浏览器复制并生成 API_KEY。')
          return lines.join('\n')
        }
        if (!target) {
          lines.push('未提供账号：可运行「用户推送测试 账号名」。')
          return lines.join('\n')
        }

        // 2. API_KEY 格式已校验通过；rettiwt 主路径因 X 反爬已失效，不再用它做网络校验，
        //    下面直接走浏览器回退验证账号可达性（与正式推送通道一致）。
        let avatarFallback: string | undefined
        lines.push('✓ API_KEY 格式有效（rettiwt 主路径已因 X 反爬失效，实际抓取走浏览器回退）。')

        // 4. 浏览器回退获取最新一条推文（与推送实际可用的通道一致），并取作者头像
        let tweet: RettiwtTweet | null = null
        let browserAvatar = ''
        try {
          const latest = await fetchLatestTweetUrlViaBrowser(target)
          if (!latest?.url) {
            lines.push('✘ 浏览器回退未能获取到最新推文（请确认服务器可访问 x.com 且 Puppeteer 服务可用）。')
            return lines.join('\n')
          }
          browserAvatar = latest.avatar || ''
          tweet = await fetchTweetViaVxTwitter(target, latest.url)
          if (!tweet) {
            lines.push('✘ 浏览器回退拿到了推文链接，但 vxtwitter 解析失败。')
            return lines.join('\n')
          }
        } catch (error: any) {
          lines.push(`✘ 浏览器回退失败：${error?.message || error}`)
          return lines.join('\n')
        }

        // 5. 按推送版式组装并发送：
        //    文本卡片图（正文调用 API 翻译后一起渲染成图）+ 推文截图（含图片）+ 媒体
        const translated = await translate(tweet.text)
        if (!translated) lines.push('⚠ API 翻译未返回内容（请检查「AI 翻译设置」），文本卡片仅含原文。')
        const bodyText = stripTweetLinks(tweet.text)
        const pubDate = tweet.createdAt && !Number.isNaN(Date.parse(tweet.createdAt))
          ? new Date(tweet.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
          : ''

        const parts: any[] = []
        const textCard = await renderTextCard(`@${tweet.author || target}`, bodyText, translated, pubDate, tweet.avatarUrl || browserAvatar || avatarFallback)
        if (textCard) {
          parts.push(h.image(textCard, 'image/png'))
        } else {
          plog('warn', '文本卡片渲染失败，回退文字输出', target)
          const textLines = [`@${tweet.author || target}`, bodyText]
          if (translated) textLines.push('', '📝 译文：', translated)
          if (pubDate) textLines.push('', `🕒 ${pubDate}`)
          parts.push(textLines.join('\n'))
        }

        const tweetUrl = `https://x.com/${target}/status/${tweet.id}`
        const screenshot = await captureTweetScreenshot(tweetUrl)
        if (screenshot) parts.push(h.image(screenshot, 'image/png'))

        // 静态图片始终单独发送，与截图并存
        for (const image of tweet.images) {
          const seg = await buildImageSegment(image)
          if (seg) parts.push(seg)
        }
        for (const gif of tweet.gifs) {
          if (config.realGif) {
            const buffer = await convertGifVideo(gif)
            if (buffer) { parts.push(h.image(buffer, 'image/gif')); continue }
          }
          const seg = await buildVideoSegment(gif)
          if (seg) parts.push(seg)
        }
        for (const video of tweet.videos) {
          const seg = await buildVideoSegment(video)
          if (seg) parts.push(seg)
        }

        try {
          await session.send(parts)
        } catch (error: any) {
          lines.push(`⚠ 推文测试发送失败：${error?.message || error}`)
        }
      } finally {
        // 撤回「正在查询」提示
        for (const id of statusMessageIds) {
          try { await session.bot.deleteMessage(session.channelId, id) } catch {}
        }
      }
      return lines.length ? lines.join('\n') : undefined
    })

  // ---------------- 启动与清理 ----------------

  ctx.on('ready', () => {
    log('info', `插件启动: 模式 ${config.sourceMode}, X 推送账号 ${allAccounts().length} 个, DC 推送频道 ${allDiscordChannels().length} 个, 全局推送目标 ${flattenTargetGroups(config.targets).length} 个`)
    // 模型名作为变量：根据配置的 API KEY 与地址在线获取可用模型，重建面板下拉选项
    refreshModels().catch(() => {})
    loadState().then(() => {
      const discordActive = config.discordEnabled && allDiscordChannels().length > 0
      if (!config.xEnabled && !discordActive) return
      const interval = Math.max(1, config.intervalMinutes) * 60 * 1000
      timers.set('x-poll', setInterval(() => { if (!disposed) pollOnce(false).catch(() => {}) }, interval))
      // 启动后 15 秒执行首轮采集
      timers.set('x-first', setTimeout(() => { if (!disposed) pollOnce(false).catch(() => {}) }, 15000))
    }).catch(() => {})
  })

  ctx.on('dispose', () => {
    disposed = true
    timers.forEach(timer => { clearTimeout(timer); clearInterval(timer) })
    timers.clear()
    log('info', '插件卸载，定时器已全部清理')
  })
}
