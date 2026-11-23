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
  // 是否附带推文卡片图（默认本地渲染，完全不访问 x.com，不会被 Cloudflare 拦截）
  screenshotEnabled: boolean
  // 是否改为打开 x.com 推文页截图（官方原版画面；可能被「正在进行安全验证」拦截，失败自动回退本地渲染）
  xPageScreenshot: boolean
  // HTTP 直取主页失败时是否回退浏览器（x.com 对自动化环境常弹人机验证，默认关闭）
  xBrowserFallback: boolean
  excludeRetweets: boolean
  includeFilter: string
  excludeFilter: string
  // Rettiwt 模式（固定使用 apiKey 登录）
  rettiwtApiKey: string
  includeQuote: boolean
  maxTweets: number
  useOriginalImages: boolean
  realGif: boolean
  // 媒体下载失败时的重试次数（网络抖动时自动重试）
  mediaDownloadRetries: number
  // 媒体下载专用代理（仅下载走代理，需启用 proxy-agent 插件；留空直连）
  mediaProxyAgent: string
  imageSendMode: 'buffer' | 'url' | 'base64' | 'file'
  videoSendMode: 'buffer' | 'url' | 'base64' | 'file'
  // rsshub 模式
  rssTemplate: string
  rsshubAccessKey: string
  // Discord 登录
  discordEnabled: boolean
  dcAppId: string
  // DC 兜底轮询间隔（秒）；实时消息走 Discord 网关事件即时转发
  dcIntervalSeconds: number
  // DC 实时转发的翻译等待上限（毫秒）：超时先发原文，避免 AI 慢拖累转发
  dcTranslateBudgetMs: number
  // OpenAI 翻译
  openaiApiKey: string
  openaiBaseURL: string
  openaiModel: string
  openaiFallbackModels: string[]
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
    intervalMinutes: Schema.number().min(1).max(1440).step(1).default(10).description('X 账号轮询间隔（分钟；DC 频道有独立的兜底轮询，不再受此间隔影响）'),
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
    screenshotEnabled: Schema.boolean().default(true)
      .description('推送时附带推文卡片图（默认在本地渲染，完全不访问 x.com，因此不会出现 Cloudflare「正在进行安全验证」；关闭后只发文本卡片与媒体，速度更快）'),
    xPageScreenshot: Schema.boolean().default(false)
      .description('推文卡片改为「打开 x.com 推文页截图」（画面是官方原版，与网页一致）。注意：x.com 会对自动化访问弹「正在进行安全验证」，被拦截时自动回退本地渲染，且拦截后有 10 分钟冷却期不再尝试'),
    xBrowserFallback: Schema.boolean().default(false)
      .description('HTTP 直取主页失败时回退到浏览器抓取（默认关闭：x.com 对自动化环境经常弹人机验证，回退多半白等 20~30 秒）'),
    useOriginalImages: Schema.boolean().default(false)
      .description('启用原图后会把 pbs.twimg.com/media 图片地址改为 name=orig'),
    realGif: Schema.boolean().default(false)
      .description('可将 Twitter 动图从 MP4 转为真正的 GIF，需启用 koishi-plugin-ffmpeg 服务'),
    mediaDownloadRetries: Schema.number().min(1).max(5).step(1).default(3)
      .description('媒体下载失败时的重试次数（网络抖动时自动重试，并在重试间轮换 CDN 地址；默认 3）'),
    mediaProxyAgent: Schema.string().default('')
      .description('媒体下载专用代理（如 http://127.0.0.1:7897）。留空则直连；填写前请先启用「代理服务 (proxy-agent)」插件'),
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
    dcIntervalSeconds: Schema.number().min(5).max(600).step(1).default(10)
      .description('DC 频道兜底轮询间隔（秒）。实时消息由 Discord 网关事件立即转发（不等轮询）；此轮询只用于补收机器人离线 / 事件漏收期间的消息，默认 10 秒'),
    dcTranslateBudgetMs: Schema.number().min(1000).max(120000).step(1000).default(15000)
      .description('DC 实时转发的翻译等待上限（毫秒）：AI 超过这个时间还没返回就先发原文（译文留空），避免翻译通道慢导致转发延迟过大。X 推文推送不受此限制'),
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
    openaiFallbackModels: Schema.array(Schema.string().description('模型名'))
      .default([])
      .description('备用模型（按顺序回退）：主模型返回 5xx / 429 / 超时 / 空内容时自动改用备用模型，全部失败才放弃翻译；留空则只用主模型'),
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
  // X 轮询与 DC 兜底轮询使用独立的重入锁（两者互不阻塞）
  let xPolling = false
  let dcPolling = false
  const discordSeen = new Set<string>()
  const lastIds: Record<string, string> = {}
  const lastMessageIds: Record<string, string> = {}
  // 已推送过的推文 ID（持久化）：即使水位线因镜像解析失败倒退、或插件重启后状态陈旧，
  // 同一条推文也不会被二次推送到群里。超出上限按先进先出淘汰。
  const pushedTweetIds = new Set<string>()
  const PUSHED_IDS_LIMIT = 800

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
      if (Array.isArray(state?.pushedTweetIds)) state.pushedTweetIds.forEach((id: string) => pushedTweetIds.add(id))
    } catch { /* 首次运行无状态文件 */ }
  }

  // X 轮询与 DC 实时转发可能同时触发状态写入：串行化写盘，避免并发写文件互相截断
  let stateSaveQueue: Promise<void> = Promise.resolve()

  async function saveState() {
    const job = stateSaveQueue.then(async () => {
      await fs.mkdir(path.dirname(dataFile), { recursive: true })
      const seen = [...discordSeen].slice(-200)
      const pushed = [...pushedTweetIds].slice(-PUSHED_IDS_LIMIT)
      await fs.writeFile(dataFile, JSON.stringify({ lastIds, lastMessageIds, discordSeen: seen, pushedTweetIds: pushed }, null, 2))
    })
    stateSaveQueue = job.catch(() => {})
    await job
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

  // ---------------- AI 翻译通道 ----------------
  // 中转站（happyapi 等）的翻译接口会偶发 500 / 503 / 超时 / 空内容：
  // 单模型一次失败就把译文丢掉太浪费，这里按「主模型 → 备用模型」链式回退；
  // 全部失败后短暂熔断，避免每条消息都白等一次 60s 超时（还会连带链接文字再等一次）。

  // 单次翻译调用的总时间预算（含重试与换模型）
  const AI_TOTAL_BUDGET = 180000
  // 单次请求的最小超时：推理模型首包慢，按配置的 30s 容易误杀
  const AI_MIN_ATTEMPT_TIMEOUT = 60000
  // 熔断冷却时间
  const AI_COOLDOWN = 90000
  // 后台翻译结局日志的耗时门槛：短于该值说明请求其实很快、只是赶不上 DC 等待上限，不值得记
  const BUDGET_LOG_THRESHOLD = 20000

  let aiCooldownUntil = 0

  function aiReady(): boolean {
    return Date.now() >= aiCooldownUntil
  }

  function aiCooldown(reason: string) {
    aiCooldownUntil = Date.now() + AI_COOLDOWN
    ailog('warn', `AI 翻译通道暂停 ${Math.round(AI_COOLDOWN / 1000)}s（${reason}）`)
  }

  // 主模型 + 备用模型（去空去重）
  function modelChain(): string[] {
    const list = [config.openaiModel, ...(config.openaiFallbackModels || [])]
      .map(model => String(model || '').trim())
      .filter(Boolean)
    return [...new Set(list)]
  }

  function statusOf(error: any): number | undefined {
    const status = error?.response?.status ?? error?.status
    return typeof status === 'number' ? status : undefined
  }

  // 接口返回体：new-api / one-api 系中转站的 5xx、403 都会把真实原因放在 body 里
  // （如「当前分组上游负载已饱和」「该令牌无权访问模型 xxx」），必须解出来才能判断该不该换模型
  function errorBodyText(error: any): string {
    const body = error?.response?.data
    if (body == null) return ''
    if (typeof body === 'string') return body
    if (Buffer.isBuffer(body)) return body.toString('utf8')
    if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8')
    try { return JSON.stringify(body) } catch { return '' }
  }

  // 整条链都没必要继续的错误。注意 403 不能一律视为鉴权失败：
  // 中转站对「令牌无权访问该模型」也返回 403，这种情况换备用模型仍然能翻译成功。
  function fatalError(error: any): boolean {
    const status = statusOf(error)
    if (status === 401) return true
    if (status !== 403) return false
    const text = errorBodyText(error)
    return /invalid[^"]{0,20}(token|api[-_ ]?key)|令牌无效|无效的令牌|未提供令牌|no auth|unauthorized/i.test(text)
  }

  // cordis-http 的 "fetch ... failed" 会把真实原因（超时/DNS/连接重置等）
  // 藏在 error.cause 里，直接展示 message 无法定位问题；
  // 5xx 时接口返回体（限流 / 余额 / 审核 / 上游报错）往往才是关键，一并带上。
  function describeHttpError(error: any): string {
    const message = String(error?.message || error || 'unknown error')
    const parts = [message]
    const cause = error?.cause ?? error?.errors?.[0]?.cause ?? error?.errors?.[0]
    if (cause) {
      if (cause?.code && !message.includes(String(cause.code))) parts.push(`(${cause.code})`)
      const causeMessage = String(cause?.message || cause)
      if (causeMessage && causeMessage !== message && !message.includes(causeMessage)) parts.push(causeMessage)
    }
    const status = statusOf(error)
    if (status && !parts.some(p => p.includes(String(status)))) parts.push(`HTTP ${status}`)
    const body = errorBodyText(error).replace(/\s+/g, ' ').trim()
    // 别把纯文本的 statusText 重复拼一遍
    if (body && !parts.some(p => p.includes(body.slice(0, 40)))) parts.push(`body: ${body}`)
    return parts.filter(Boolean).join(' ').slice(0, 400)
  }

  // 兼容少数中转站的特殊返回：content 可能是分段数组、可能被包在代码块里，
  // qwen 系还会把思考过程放在 <think>…</think> / ```think 中，一并剥掉
  function pickContent(res: any): string | null {
    const choice = res?.choices?.[0]
    const raw = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? res?.content ?? ''
    let text = Array.isArray(raw)
      ? raw.map((part: any) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
      : String(raw ?? '')
    text = text
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
      // 只剥「显式标注为思考过程」的代码块，普通 ``` 包裹的译文不能动
      .replace(/^\s*```(?:think|reasoning)\b[\s\S]*?```\s*/i, '')
      .trim()
    return text || null
  }

  // 单次 chat/completions 请求；只负责一次收发，重试与换模型在 requestChat 里做
  async function postChatCompletion(model: string, messages: any[], timeout: number): Promise<string | null> {
    const url = `${config.openaiBaseURL.replace(/\/$/, '')}/chat/completions`
    const res: any = await ctx.http.post(url, { model, messages, temperature: 0.3 }, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout,
    })
    return pickContent(res)
  }

  // 按模型链请求：主模型失败立刻切备用模型（比在同一条上游上死等更快），
  // 链尾模型多试一次兜底；401（或 403 且确为令牌无效）直接终止整条链。
  async function requestChat(messages: any[]): Promise<string> {
    const models = modelChain()
    if (!models.length) throw new Error('未配置翻译模型')
    const deadline = Date.now() + AI_TOTAL_BUDGET
    const attemptTimeout = Math.max(config.requestTimeout, AI_MIN_ATTEMPT_TIMEOUT)
    let lastError: any
    for (let index = 0; index < models.length; index++) {
      const model = models[index]
      const isLast = index === models.length - 1
      const attempts = isLast ? 2 : 1
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const remaining = deadline - Date.now()
        if (remaining < 5000) {
          throw new Error(`${describeHttpError(lastError)}（已用尽 ${Math.round(AI_TOTAL_BUDGET / 1000)}s 总重试预算）`)
        }
        try {
          const content = await postChatCompletion(model, messages, Math.min(attemptTimeout, remaining))
          if (content) return content
          lastError = new Error(`模型 ${model} 返回空内容`)
        } catch (error: any) {
          lastError = error
          if (fatalError(error)) throw new Error(describeHttpError(error))
        }
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
      }
      if (!isLast) {
        ailog('warn', `模型 ${model} 翻译失败（${describeHttpError(lastError)}），改用备用模型 ${models[index + 1]}`)
      }
    }
    throw new Error(describeHttpError(lastError))
  }

  // 已是中文的内容不再送 AI 翻译：省掉一次最慢的请求（DC 中文公告、中文推文都走这条捷径）
  function isMostlyChinese(text: string): boolean {
    const value = String(text || '')
    const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length
    if (cjk < 8) return false
    const latin = (value.match(/[A-Za-z]/g) || []).length
    return cjk >= latin * 0.6
  }

  // budgetMs > 0 时给翻译加「等待上限」：超时立即返回 null（先发原文），
  // 后台那次请求继续跑完但结果丢弃 —— 避免 AI 通道慢时整条推送被拖住数分钟。
  async function translate(text: string, budgetMs?: number): Promise<string | null> {
    if (!config.openaiApiKey) return null
    if (!String(text || '').trim()) return null
    if (isMostlyChinese(text)) {
      ailog('info', '内容已是中文，跳过 AI 翻译')
      return null
    }
    if (!aiReady()) {
      const seconds = Math.max(1, Math.round((aiCooldownUntil - Date.now()) / 1000))
      ailog('info', `AI 翻译通道冷却中，本条跳过翻译（${seconds}s 后恢复）`)
      return null
    }
    const job = requestChat([
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: text },
    ])
    // 加了等待上限后，超时那一次请求仍会在后台跑完。这里记录它的最终结局：
    // 否则超时告警后无法区分「模型慢但最终成功」还是「网关/模型彻底挂了」，排查没有抓手。
    const jobStartedAt = Date.now()
    job.then(
      (content: string | null) => {
        if (Date.now() - jobStartedAt > BUDGET_LOG_THRESHOLD) {
          ailog('info', `超时后后台翻译才完成（总耗时 ${Math.round((Date.now() - jobStartedAt) / 1000)}s），结果已丢弃`)
        }
        return content
      },
      (error: any) => {
        if (Date.now() - jobStartedAt > BUDGET_LOG_THRESHOLD) {
          ailog('warn', `超时后后台翻译也失败了（${error?.message || error}）`)
        }
      },
    )
    try {
      let content: string | null
      if (budgetMs && budgetMs > 0) {
        const timeout = Symbol('timeout')
        const raced = await Promise.race([
          job,
          new Promise<typeof timeout>(resolve => setTimeout(() => resolve(timeout), budgetMs)),
        ])
        if (raced === timeout) {
          ailog('warn', `翻译超过 ${Math.round(budgetMs / 1000)}s 未返回，先发原文（译文本次留空）`)
          return null
        }
        content = raced
      } else {
        content = await job
      }
      if (aiCooldownUntil) {
        aiCooldownUntil = 0
        ailog('info', 'AI 翻译通道已恢复')
      }
      return content
    } catch (error: any) {
      const reason = error?.message || String(error)
      aiCooldown(reason)
      ailog('warn', `翻译失败，仅发送原文: ${reason}`)
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

  // 推文卡片图：**默认本地渲染**，完全不访问 x.com。
  //
  // 2026-10-24：历史问题——截图靠 Puppeteer 打开 x.com 推文页，X 会对自动化访问弹 Cloudflare
  // 「正在进行安全验证」（早先还把配置里的 auth_token 注入浏览器，被判定为风险会话直接 302 到
  // /account/access），于是转发出去的那张「推文截图」就是验证页本身。
  // 现在主路径改为用 fxtwitter/vxtwitter 已解析到的正文、头像、图片在本地拼一张 X 风格的卡片，
  // 不产生任何对 x.com 的请求 → 不可能再出现安全验证页，也不再受 CF 速率限制影响。
  // 想保留官方原版画面时可在配置里打开 `xPageScreenshot`（那一路径仍带验证页识别 + 冷却）。
  const X_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0'

  function looksLikeXVerification(url: string, title: string, body: string): boolean {
    if (/\/account\/access|\/i\/flow\/login|\/login\b/i.test(String(url || ''))) return true
    const text = `${title || ''}\n${body || ''}`
    return [
      '正在进行安全验证',
      '本网站使用安全服务',
      'Verify you are human',
      'Just a moment',
      'Attention Required',
      'Checking your browser',
    ].some(marker => text.includes(marker))
  }

  interface TweetShotMeta {
    /** 显示名（推文作者名）；缺省用 @账号 */
    author?: string
    /** 账号名（不含 @） */
    account: string
    text: string
    images?: string[]
    avatarUrl?: string
    pubDate?: string
    link?: string
  }

  // 本地渲染推文卡片：头像 + 作者 + @账号 + 正文 + 图片网格（最多 4 张）
  async function renderTweetCard(meta: TweetShotMeta): Promise<Buffer | null> {
    const puppeteer = ctx.puppeteer
    if (!puppeteer) {
      plog('warn', 'puppeteer 服务未安装，无法渲染推文卡片')
      return null
    }
    const esc = (value: string) => String(value || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // 正文只做「转义 + 链接/提及高亮」，不解析 Markdown：X 的正文里 * _ # 都是字面量
    const bodyHtml = esc(meta.text)
      .replace(/(https?:\/\/[^\s<]+)/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
      .replace(/(^|[\s(])(@[A-Za-z0-9_]{1,15})/g, (_m, pre, mention) => `${pre}<a href="https://x.com/${mention.slice(1)}" target="_blank" rel="noopener">${mention}</a>`)
    // 卡片里的缩略图用 name=small（≈680px）：原图（name=orig）单张 3~5MB，
    // 四图卡片光下载就要十几秒，直接用大图只会拖慢推送
    const cardImageUrl = (url: string): string => {
      if (!/^https?:\/\/pbs\.twimg\.com\/media\//i.test(url)) return url
      if (/[?&]name=[^&]+/i.test(url)) return url.replace(/([?&])name=[^&]+/i, '$1name=small')
      return url + (url.includes('?') ? '&' : '?') + 'name=small'
    }
    const media = (meta.images || []).slice(0, 4).map(cardImageUrl)
    const mediaClass = media.length === 1 ? 'one' : media.length === 2 ? 'two' : media.length === 3 ? 'three' : 'four'
    const mediaHtml = media.length
      ? `<div class="media ${mediaClass}">${media
          .map(url => `<img src="${esc(url)}" onerror="this.style.display='none'">`).join('')}</div>`
      : ''
    const avatarHtml = meta.avatarUrl
      ? `<img class="avatar" src="${esc(meta.avatarUrl)}" onerror="this.style.visibility='hidden'">`
      : '<div class="avatar"></div>'
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin:0; background:transparent; font-family:'Microsoft YaHei','PingFang SC',system-ui,sans-serif; }
      #card { width:640px; box-sizing:border-box; background:#000; color:#e7e9ea; padding:18px 20px 14px; border-radius:16px; }
      .head { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
      .avatar { width:48px; height:48px; border-radius:50%; object-fit:cover; background:#2f3336; flex:0 0 auto; }
      .who { display:flex; flex-direction:column; line-height:1.3; }
      .name { font-size:16px; font-weight:700; }
      .handle { font-size:14px; color:#71767b; }
      .body { font-size:17px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
      .body a { color:#1d9bf0; text-decoration:none; }
      .media { margin-top:12px; display:grid; gap:3px; border-radius:14px; overflow:hidden; }
      .media.one { grid-template-columns:1fr; }
      .media.two, .media.three, .media.four { grid-template-columns:1fr 1fr; }
      .media img { width:100%; display:block; object-fit:cover; background:#0b0b0b; }
      .media.one img { max-height:460px; object-fit:contain; }
      .media.two img { aspect-ratio:4/3; }
      .media.three img:first-child { grid-column:1 / -1; aspect-ratio:16/9; }
      .media.three img, .media.four img { aspect-ratio:4/3; }
      .foot { margin-top:12px; display:flex; align-items:center; justify-content:space-between; font-size:13px; color:#71767b; }
      .foot .brand { font-size:17px; font-weight:700; color:#e7e9ea; }
    </style></head><body><div id="card">
      <div class="head">${avatarHtml}<div class="who"><span class="name">${esc(meta.author || `@${meta.account}`)}</span><span class="handle">@${esc(meta.account)}</span></div></div>
      <div class="body">${bodyHtml}</div>
      ${mediaHtml}
      <div class="foot"><span>${esc(meta.pubDate || '')}</span><span class="brand">X</span></div>
    </div></body></html>`
    let page: any = null
    try {
      page = await puppeteer.page()
      await page.setViewport({ width: 700, height: 900, deviceScaleFactor: 2 })
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 })
      // 等图片解码完成（外部图，最多 8s），避免卡片里出现空白图位
      await page.evaluate(() => Promise.race([
        Promise.all(Array.from(document.images).map((img: any) => img.complete
          ? Promise.resolve()
          : new Promise(resolve => { img.onload = resolve; img.onerror = resolve }))),
        new Promise(resolve => setTimeout(resolve, 8000)),
      ])).catch(() => {})
      const card = await page.$('#card')
      if (!card) return null
      const buffer = await card.screenshot({ type: 'png' }) as Buffer
      if (!buffer || buffer.length < 5000) {
        plog('warn', '本地推文卡片过小，疑似渲染失败', undefined, undefined, { size: buffer?.length })
        return null
      }
      plog('info', '推文卡片渲染完成（本地，未访问 x.com）', undefined, undefined, { size: buffer.length })
      return buffer
    } catch (error: any) {
      plog('warn', `本地推文卡片渲染失败: ${error?.message || error}`)
      return null
    } finally {
      if (page) await page.close().catch(() => {})
    }
  }

  // 命中过 Cloudflare 验证页后，10 分钟内不再尝试官方页（否则每条推文都要白等一次跳转）
  let xPageBlockedUntil = 0

  // 官方原版画面：打开 x.com 推文页截推文卡片。可能被 CF 拦截，命中即进入冷却并返回 null。
  async function captureTweetPageScreenshot(statusUrl: string, hideMedia = false): Promise<Buffer | null> {
    if (Date.now() < xPageBlockedUntil) {
      const left = Math.round((xPageBlockedUntil - Date.now()) / 1000)
      plog('info', `x.com 官方页截图处于冷却期（剩余 ${left}s），本条直接用本地渲染`)
      return null
    }
    const puppeteer = ctx.puppeteer
    if (!puppeteer) return null
    let page: any = null
    try {
      page = await puppeteer.page()
      await page.setViewport({ width: 720, height: 900 })
      // 不注入 auth_token / ct0：带登录 Cookie 的自动化会话会被判定为风险并 302 到 /account/access
      await page.setUserAgent(X_BROWSER_UA)
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' })
      plog('info', `截图推文页面: ${statusUrl}`)
      await page.goto(statusUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(config.requestTimeout, 20000) })
      // X 已移除 article[data-testid="tweet"]（A/B 后为普通 <article>），用 article 作为推文本体
      const article = await page.waitForSelector('article', { timeout: 12000 }).catch(() => null)
      const probe: any = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 400),
        challenge: !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-stage, #cf-challenge-running, .cf-turnstile'),
      })).catch(() => null)
      if (probe && (probe.challenge || looksLikeXVerification(probe.url, probe.title, probe.text))) {
        xPageBlockedUntil = Date.now() + 10 * 60 * 1000
        plog('warn', `x.com 官方页被 Cloudflare 安全验证拦截（${probe?.url || statusUrl}），10 分钟内改用本地渲染`)
        return null
      }
      if (!article) return null
      // 等推文里的图片加载完成（最多 4s），否则截出来的卡片会缺图
      await page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {})
      // 推文自带图片/视频时，截图前移除页面中的媒体区域，只保留文本与头部部分
      if (hideMedia) {
        await page.evaluate(() => {
          const root = document.querySelector('article') || document
          const selectors = [
            'img[src*="pbs.twimg.com/media"]',
            'img[src*="ton.twimg.com"]',
            'video',
            '[data-testid="tweetPhoto"]',
            '[data-testid="videoPlayer"]',
            '[data-testid="gifPlayable"]',
            '[data-testid="card.layoutLarge.media"]',
          ]
          for (const sel of selectors) {
            root.querySelectorAll(sel).forEach(el => el.remove())
          }
        }).catch(() => {})
        await new Promise(res => setTimeout(res, 200))
      }
      // 只截推文卡片元素（Post 详情页本体），避免截到侧边栏与推荐内容
      const screenshot = await article.screenshot({ type: 'png' }) as Buffer
      if (!screenshot || screenshot.length < 5000) {
        plog('warn', '推文截图过小，疑似空白页面', undefined, undefined, { size: screenshot?.length })
        return null
      }
      plog('info', '推文截图完成（x.com 官方页，仅推文卡片）', undefined, undefined, { size: screenshot.length })
      return screenshot
    } catch (error: any) {
      plog('warn', `推文页面截图失败: ${error?.message || error}`)
      return null
    } finally {
      if (page) await page.close().catch((error: any) => plog('warn', `关闭截图页面失败: ${error?.message || error}`))
    }
  }

  // 推文卡片入口：本地渲染为默认，官方页截图需显式开启且失败时自动回退本地渲染
  async function captureTweetScreenshot(statusUrl: string, meta: TweetShotMeta): Promise<Buffer | null> {
    if (config.screenshotEnabled === false) return null
    // DC 中转（link 为空）或非推文链接不渲染
    if (!/^https?:\/\/[^/]*(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(statusUrl)) return null
    if (config.xPageScreenshot) {
      const shot = await captureTweetPageScreenshot(statusUrl)
      if (shot) return shot
    }
    return renderTweetCard(meta)
  }

  // 原图策略：pbs.twimg.com/media 图片地址改为 name=orig
  function toOriginalImageUrl(url: string): string {
    if (!config.useOriginalImages) return url
    if (!/^https?:\/\/pbs\.twimg\.com\/media\//i.test(url)) return url
    if (/[?&]name=[^&]+/.test(url)) return url.replace(/([?&])name=[^&]+/, '$1name=orig')
    return url + (url.includes('?') ? '&' : '?') + 'name=orig'
  }

  // 同一媒体在 CDN 上通常有多个等价入口：某个域名 / 参数组合瞬时不可达时，
  // 重试可换用其它入口，避免一次网络抖动就丢掉图片。
  function mediaUrlCandidates(url: string): string[] {
    const list = [url]
    const push = (u: string) => {
      if (u && !list.includes(u)) list.push(u)
    }
    // Twitter 图片：name=orig 失败时退到 large；仍失败则去掉 name 让 CDN 返回默认尺寸
    if (/^https?:\/\/pbs\.twimg\.com\/media\//i.test(url)) {
      const hasName = /[?&]name=[^&]*/.test(url)
      push(url.replace(/([?&])name=[^&]*/, '$1name=large'))
      push((hasName ? url.replace(/([?&])name=[^&]*/, '$1') : url).replace(/[?&]$/, ''))
    }
    // Discord 附件：cdn.discordapp.com 与 media.discordapp.net 是同一资源的两套入口
    if (/^https?:\/\/cdn\.discordapp\.com\//i.test(url)) {
      push(url.replace(/^https?:\/\/cdn\.discordapp\.com\//i, 'https://media.discordapp.net/'))
    } else if (/^https?:\/\/media\.discordapp\.net\//i.test(url)) {
      push(url.replace(/^https?:\/\/media\.discordapp\.net\//i, 'https://cdn.discordapp.com/'))
    }
    return list
  }

  async function downloadMedia(url: string): Promise<Buffer | null> {
    const candidates = mediaUrlCandidates(url)
    const attempts = Math.max(1, Math.min(5, Math.floor(Number(config.mediaDownloadRetries) || 3)))
    const proxyAgent = String(config.mediaProxyAgent || '').trim() || undefined
    let lastError: any
    for (let i = 0; i < attempts; i++) {
      // 每次重试轮换候选地址（次数超过候选数后沿用最后一个）
      const target = candidates[Math.min(i, candidates.length - 1)]
      try {
        const options: any = {
          responseType: 'arraybuffer',
          timeout: Math.max(config.requestTimeout, 30000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Koishi/4.18',
            'Referer': 'https://x.com/',
          },
        }
        if (proxyAgent) options.proxyAgent = proxyAgent
        const res = await ctx.http.get(target, options)
        const buffer = Buffer.from(res as ArrayBuffer)
        if (!buffer.length) throw new Error('响应为空')
        if (i > 0) plog('info', `媒体下载重试成功（第 ${i + 1} 次）: ${target}`)
        return buffer
      } catch (error: any) {
        lastError = error
        if (i < attempts - 1) await sleep(600 * (i + 1))
      }
    }
    plog('warn', `媒体下载失败（已重试 ${attempts} 次）: ${url} ${lastError?.message || lastError}`)
    return null
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
      if (!buffer) {
        // 重试仍失败时不再直接丢图：降级为 URL 直传，由协议端自行拉取（此路径无法加水印）
        plog('info', `媒体下载失败，已降级为 URL 直传: ${target}`)
        return h.image(target)
      }
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
      if (!buffer) {
        // 重试仍失败时降级为 URL 直传，避免整段视频被丢弃
        plog('info', `媒体下载失败，已降级为 URL 直传: ${url}`)
        return h.video(url)
      }
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
  async function translateLinkLabels(labels: string[], budgetMs?: number): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    // 去重并跳过已含中文的文字（AI 译文中的 markdown 链接文字已是中文，无需再翻）
    const pending = [...new Set(labels.filter(l => l && !/[\u4e00-\u9fff]/.test(l)))]
    // 主译文刚失败过（通道冷却中）时不要再白等一轮，链接文字直接保留原文
    if (!config.openaiApiKey || !pending.length || !aiReady()) return map
    const job = requestChat([
      {
        role: 'system',
        content: '你是链接文字翻译器。把用户提供的每一行链接文字翻译成简体中文；按原行序输出，每行只输出一个译文，不要输出编号、引号或其他内容。专有名词（如 SimBridge、A32NX）可保留原文。',
      },
      { role: 'user', content: pending.join('\n') },
    ])
    job.catch(() => {})
    try {
      let content: string | null = null
      if (budgetMs && budgetMs > 0) {
        const timeout = Symbol('timeout')
        const raced = await Promise.race([
          job,
          new Promise<typeof timeout>(resolve => setTimeout(() => resolve(timeout), budgetMs)),
        ])
        content = raced === timeout ? null : raced
        if (raced === timeout) ailog('warn', `链接文字翻译超过 ${Math.round(budgetMs / 1000)}s，保留原文`)
      } else {
        content = await job
      }
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
    // 水印文字为空时直接返回：省掉一次 puppeteer 往返（约 1~2s），推送更快
    if (!String(config.watermarkText || '').trim()) return buffer
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

  // 推送队列分道：'x' = X 推文轮询，'dc' = Discord 中转（实时事件 + 兜底轮询）
  type PushLane = 'x' | 'dc'

  // 上一条推送「发完」的时刻，用于保证消息之间至少间隔 pushMsgInterval 毫秒。
  // 按来源分道：X 推文与 DC 中转各走一条队列，DC 实时消息不会被 X 的批量补发堵在后面。
  const lastPushSentAt: Record<PushLane, number> = { x: 0, dc: 0 }

  // 发送闸门：DC 实时事件可能在同一瞬间到达多条，若并发进入「等待间隔 → 发送」，
  // 多批消息会同时外发（既失去防刷屏间隔，也可能乱序）。这里把真正的发送阶段串行排队。
  const pushSlots: Record<PushLane, Promise<void>> = { x: Promise.resolve(), dc: Promise.resolve() }

  function withPushSlot<T>(lane: PushLane, task: () => Promise<T>): Promise<T> {
    const run = pushSlots[lane].then(task, task)
    pushSlots[lane] = run.then(() => { }, () => { })
    return run
  }

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

  async function push(account: string, source: string, text: string, link: string, pubDate: string, images: string[] = [], videos: string[] = [], gifs: string[] = [], pushTargets?: TargetConfig[], avatarUrl?: string, dedupId?: string, lane: PushLane = 'x'): Promise<number> {
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

    // 翻译、卡片图、链接文字翻译互相独立：并行执行，避免 DC 实时转发在多次串行 AI / 浏览器请求上白白等待。
    // DC 实时通道给翻译加等待上限（dcTranslateBudgetMs）：AI 慢就先发原文，不让整条转发卡住。
    const aiBudget = lane === 'dc' ? Math.max(1000, Number(config.dcTranslateBudgetMs) || 0) : undefined
    const translatedPromise = translate(text, aiBudget)
    const sourceLinkItems = extractLinkItems(text)
    const linkLabelsPromise = translateLinkLabels(sourceLinkItems.map(i => i.label!).filter(Boolean), aiBudget)
    // 推文卡片：默认本地渲染（不访问 x.com），因此不会再出现「正在进行安全验证」的截图
    const screenshotPromise = link
      ? captureTweetScreenshot(link, { account, author: `@${account}`, text, images, avatarUrl, pubDate, link })
      : Promise.resolve(null)

    const translated = await translatedPromise

    // 推送组装：
    // 1) 消息头部附带推文链接（linkStyle 决定原始 / fx / vx 形式）；
    // 2) 原文 + AI 译文渲染成文本卡片图发送（用户名左侧带头像）；
    // 3) 推文截图包含推文完整内容（含图片），不再屏蔽推文中的图片；
    // 4) 媒体（图片 / GIF / 视频）始终随消息单独发送，可保存原图。
    const bodyText = stripTweetLinks(removeUrls(text))
    // 链接提取与清理同时覆盖原文和译文（AI 翻译会把链接文字翻译成中文并保留裸 URL）；
    // markdown 链接保留链接文字，翻译后拼进「原文链接」（如 simbridge指南：https://...）
    const linkItems = extractLinkItems(`${text}\n${translated || ''}`)
    const linkLabelMap = await linkLabelsPromise
    // 译文里新增的链接文字（一般已是中文，translateLinkLabels 会跳过）按需补翻
    const pendingLabels = linkItems
      .map(item => item.label!)
      .filter(label => label && !/[\u4e00-\u9fff]/.test(label) && !linkLabelMap.has(label))
    if (pendingLabels.length) {
      const extra = await translateLinkLabels(pendingLabels, aiBudget)
      for (const [label, value] of extra) linkLabelMap.set(label, value)
    }
    const translatedClean = translated ? stripTweetLinks(removeUrls(translated)) : ''

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

    // 文本卡片、媒体、截图水印同时准备（互不依赖）
    const [textCard, mediaSegments, markedScreenshot] = await Promise.all([
      renderTextCard(`@${account}`, bodyText, translatedClean, pubDate, avatarUrl),
      buildMediaSegments(),
      screenshotPromise.then(shot => shot ? addWatermark(shot, 'image/png') : null),
    ])

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
    if (markedScreenshot) {
      segments.push(h.image(markedScreenshot, 'image/png'))
    }
    segments.push(...mediaSegments)

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

    // 发送阶段串行排队（按 lane 分队列，X 与 DC 互不阻塞）：
    // 消息间隔：每条消息发送前先等待 pushMsgInterval 毫秒（该队列的第一条不等待），
    // 保证相邻两条推送之间存在固定间隔，避免轮询补发多条推文 / DC 连续多条消息时被判定为刷屏。
    return withPushSlot(lane, async () => {
      if (msgInterval > 0 && lastPushSentAt[lane] > 0) {
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
                const hint = link ? `：${link}` : ''
                await bot.sendMessage(target.channelId,
                  `⚠️ 本条推文有 ${mediaSkipped} 个媒体未能随消息发送（视频或图片加载失败），请前往原推文查看${hint}`)
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
      // 记录本条消息「发完」的时刻，供同队列的下一条消息计算最小间隔
      lastPushSentAt[lane] = Date.now()
      return sent
    })
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

  // 2026-10-20：浏览器回退被 Cloudflare Turnstile 拦截（x.com 对自动化环境强制人机验证），
  // 带 auth_token 的请求（无论纯 HTTP 还是浏览器）会被 302 到 /account/access。
  // 实测未登录（无 cookie）的纯 HTTP 请求可拿到完整 SSR 主页，页内嵌有最新数条推文的 status 链接，
  // 据此新增 HTTP 直取路径作为首选，浏览器路径降级为兜底。

  // 无 cookie 纯 HTTP 拉取未登录版主页，提取页内嵌的推文 ID（文档顺序）与头像。
  // 偶发被 Cloudflare 判风险时会直接返回「正在进行安全验证」页（HTTP 200 但没推文），
  // 这种情况下换一个 UA / 语言头立即重试一次通常就能过，而且必须明确报错，不能静默当成「没有新推文」。
  const HTTP_FETCH_ATTEMPTS = [
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  ]

  function looksLikeCloudflarePage(html: string): boolean {
    return /Just a moment|正在进行安全验证|cf-chl|challenge-platform|Enable JavaScript and cookies/i.test(String(html || ''))
  }

  async function fetchLatestTweetIdsViaHttp(account: string): Promise<{ ids: string[]; avatar: string }> {
    let lastHtml = ''
    let lastError: any = null
    for (let i = 0; i < HTTP_FETCH_ATTEMPTS.length; i++) {
      try {
        const html: any = await ctx.http.get(`https://x.com/${account}`, {
          responseType: 'text',
          timeout: config.requestTimeout,
          headers: HTTP_FETCH_ATTEMPTS[i],
        })
        lastHtml = typeof html === 'string' ? html : String(html)
        const ids: string[] = []
        for (const m of lastHtml.matchAll(/status\/(\d{15,})/g)) {
          if (!ids.includes(m[1])) ids.push(m[1])
        }
        if (ids.length) {
          const avatar = lastHtml.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || ''
          return { ids, avatar }
        }
        if (looksLikeCloudflarePage(lastHtml)) {
          lastError = new Error('x.com 返回了 Cloudflare「正在进行安全验证」页（HTTP 直取被拦截）')
        } else {
          lastError = new Error(`主页未包含任何推文链接（可能账号受保护/不存在，或 X 返回了精简页，长度 ${lastHtml.length}）`)
        }
      } catch (error: any) {
        lastError = error
      }
      // 第一次失败后稍等再换 UA 重试，避免连续同 IP 同指纹请求
      if (i === 0) await new Promise(resolve => setTimeout(resolve, 1200))
    }
    throw lastError || new Error('HTTP 直取失败')
  }

  // 浏览器兜底：匿名访问用户主页。
  // 2026-10-24：此前会给页面注入 auth_token，X 随即重定向到 /account/access 并弹出
  // Cloudflare 人机验证，兜底路径必然失败；改为匿名访问后主页可以正常 SSR 出推文。
  async function fetchLatestTweetUrlViaBrowser(account: string): Promise<{ url: string; avatar: string } | null> {
    const puppeteer = (ctx as any).puppeteer
    if (!puppeteer?.page) return null
    const page = await puppeteer.page()
    try {
      await page.setViewport({ width: 720, height: 900 })
      await page.setUserAgent(X_BROWSER_UA)
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' })
      await page.goto(`https://x.com/${account}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const article = await page.waitForSelector('article', { timeout: 15000 })
      const probe: any = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 400),
      }))
      if (looksLikeXVerification(probe?.url, probe?.title, probe?.text)) {
        throw new Error('X 要求进行安全验证（匿名访问仍被拦截）')
      }
      // 同时取最新推文链接与作者头像（头像 = 选中推文卡片内的 profile_images 图片）
      const latest = await page.evaluate((noRt: boolean) => {
        const articles = document.querySelectorAll('article')
        for (const article of articles) {
          const articleText = (article as HTMLElement).innerText || ''
          // X 已移除 data-testid="socialContext"，置顶/转推提示只能从卡片文本判断
          if (/(pinned|已置顶|置顶|固定|置頂)/i.test(articleText.slice(0, 80))) continue
          if (noRt && /^(reposted|retweeted|已转帖|转推|轉推|转发)/i.test(articleText.trim())) continue
          const link = article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null
          if (link) {
            const avatarEl = article.querySelector('img[src*="profile_images"]') as HTMLImageElement | null
            return { url: link.href, avatar: avatarEl?.src || '' }
          }
        }
        return null
      }, config.excludeRetweets)
      return latest
    } catch (error: any) {
      xlog('warn', `浏览器兜底读取主页失败 @${account}: ${error?.message || error}`, account)
      return null
    } finally {
      await page.close().catch(() => {})
    }
  }

  // ---------------- 推文解析（fxtwitter 优先，vxtwitter 兜底） ----------------
  //
  // 2026-10-24：vxtwitter 接口在本机经常直接 403，fxtwitter 的 /status/<id> 返回结构化 JSON
  // （text / media / author / created_at / reposted_by），无需登录也不会触发 Cloudflare，
  // 因此改为 fxtwitter 优先、vxtwitter 兜底；两者都失败才回退浏览器抓主页。

  function tweetIdFromUrl(tweetUrl: string): string {
    return tweetUrl.match(/status\/(\d+)/)?.[1] || ''
  }

  async function fetchTweetViaFxTwitter(account: string, tweetId: string): Promise<RettiwtTweet | null> {
    const apiUrl = `https://api.fxtwitter.com/${encodeURIComponent(account)}/status/${tweetId}`
    const data: any = await ctx.http.get(apiUrl, {
      headers: { 'User-Agent': X_BROWSER_UA, 'Accept': 'application/json' },
      responseType: 'text',
      timeout: config.requestTimeout,
    })
    const parsed: any = typeof data === 'string' ? JSON.parse(data) : data
    const tweet = parsed?.tweet
    if (!tweet || !tweet.text) return null
    const images: string[] = []
    const videos: string[] = []
    const gifs: string[] = []
    for (const item of (Array.isArray(tweet?.media?.all) ? tweet.media.all : [])) {
      const type = String(item?.type || '').toLowerCase()
      const url = String(item?.url || '')
      if (!url) continue
      if (type === 'photo' || type === 'image') images.push(url)
      else if (type === 'gif') gifs.push(url)
      else if (type === 'video') videos.push(url)
    }
    let text = String(tweet.text || '')
    if (config.includeQuote && tweet?.quote?.text) {
      text += `\n\n引用 @${tweet.quote.author?.screen_name || ''}: ${tweet.quote.text}`
    }
    return {
      id: String(tweet.id || tweetId),
      text,
      images,
      videos,
      gifs,
      author: String(tweet.author?.screen_name || account),
      avatarUrl: String(tweet.author?.avatar_url || '') || undefined,
      createdAt: String(tweet.created_at || (tweet.created_timestamp ? new Date(tweet.created_timestamp * 1000).toISOString() : '')),
      // reposted_by 非空表示这是一条转推；文本 RT @ 前缀兜底
      isRetweet: Boolean(tweet.reposted_by) || /^RT @/.test(String(tweet.text || '')),
    }
  }

  async function fetchTweetViaVxTwitter(account: string, tweetUrl: string): Promise<RettiwtTweet | null> {
    const tweetId = tweetIdFromUrl(tweetUrl)
    if (!tweetId) return null
    const apiUrl = `https://api.vxtwitter.com/${account}/status/${tweetId}`
    const data: any = await ctx.http.get(apiUrl, {
      headers: { 'User-Agent': X_BROWSER_UA, 'Accept': 'application/json' },
      responseType: 'text',
      timeout: config.requestTimeout,
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
      // vxtwitter 响应含 user_profile_image_url（_normal 后缀）；为空时由主页 og:image 兜底
      avatarUrl: String(parsed.avatar_url || parsed.user_avatar_url || parsed.user_profile_image_url || parsed.profile_image_url || '') || undefined,
      // vxtwitter 用 date（Twitter 格式字符串）/ date_epoch（秒）字段，无 created_at
      createdAt: String(parsed.created_at || parsed.createdAt
        || (parsed.date_epoch ? new Date(parsed.date_epoch * 1000).toISOString() : '')
        || parsed.date || ''),
      // retweet 字段：普通推文为 null，转推为对象/真值；文本 RT @ 前缀兜底
      isRetweet: Boolean(parsed.retweet) || /^RT @/.test(String(parsed.text || '')),
    }
  }

  async function fetchTweetFromMirror(account: string, tweetUrl: string): Promise<RettiwtTweet | null> {
    const tweetId = tweetIdFromUrl(tweetUrl)
    if (!tweetId) return null
    try {
      const tweet = await fetchTweetViaFxTwitter(account, tweetId)
      if (tweet) return tweet
      xlog('info', `fxtwitter 未返回推文 ${tweetId}，尝试 vxtwitter`, account)
    } catch (error: any) {
      xlog('info', `fxtwitter 解析失败（${error?.message || error}），尝试 vxtwitter`, account)
    }
    try {
      return await fetchTweetViaVxTwitter(account, tweetUrl)
    } catch (error: any) {
      xlog('warn', `vxtwitter 解析失败: ${error?.message || error}`, account)
      return null
    }
  }

  async function pollAccountViaRettiwt(account: string): Promise<string> {
    // 说明：X 当前对非浏览器主页返回精简页，rettiwt 内部 x-client-transaction-id 无法解析
    // ondemand chunk，主路径已整体失效（每次都抛 Unknown error）。
    // 首选：无 cookie 纯 HTTP 拉未登录版主页提取推文 ID（2026-10-20 实测可用）；
    // 兜底：Puppeteer 浏览器回退（2026-10-20 起常被 Cloudflare Turnstile 拦截，仅作备选）。
    let tweets: RettiwtTweet[] = []
    try {
      const { ids, avatar } = await fetchLatestTweetIdsViaHttp(account)
      if (ids.length) {
        // 雪花 ID 数值降序 = 时间降序；逐条经 fxtwitter / vxtwitter 解析正文与媒体
        const sorted = [...new Set(ids)]
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .slice(0, Math.max(config.maxTweets, 5))
        for (const id of sorted) {
          try {
            const tweet = await fetchTweetFromMirror(account, `https://x.com/${account}/status/${id}`)
            if (!tweet) continue
            tweet.avatarUrl = tweet.avatarUrl || avatar || undefined
            tweets.push(tweet)
          } catch { /* 单条解析失败不阻塞其余 */ }
        }
        if (tweets.length) xlog('info', `已通过 HTTP 直取 ${tweets.length} 条推文（ID ${ids.length} 个）`, account)
      }
    } catch (error: any) {
      xlog('warn', `HTTP 直取失败: ${error?.message || error}`, account)
    }
    if (!tweets.length) {
      // 浏览器回退默认关闭：x.com 对自动化环境经常直接弹「正在进行安全验证」，
      // 这条路径现在只会白等 20~30 秒并刷警告；需要时可在配置里手动开启。
      if (config.xBrowserFallback) {
        try {
          const latest = await fetchLatestTweetUrlViaBrowser(account)
          if (latest?.url) {
            const tweet = await fetchTweetFromMirror(account, latest.url)
            if (tweet) {
              tweet.avatarUrl = tweet.avatarUrl || latest.avatar || undefined
              tweets = [tweet]
              xlog('info', `已通过浏览器获取最新推文 ${tweet.id}`, account)
            }
          }
        } catch (error: any) {
          xlog('warn', `浏览器获取失败: ${error?.message || error}`, account)
        }
      } else {
        xlog('warn', `HTTP 直取无结果（未启用浏览器回退）: ${account}`, account)
      }
    }
    if (!tweets.length) return `${account}: 时间线为空或拉取失败`

    const candidates = tweets.filter(tweet => !config.excludeRetweets || !tweet.isRetweet)
    // 水位线取「所有拉到的推文」中最新的 ID，而不是排除转推后的第一条：
    // 否则最新一条恰好是转推时水位线会倒退，下一轮把旧推文重复推送一遍。
    const newest = [...tweets].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0]?.id
    const last = lastIds[account]
    if (!last) {
      // 首次见到该账号：只记录基线，不补发历史
      lastIds[account] = newest
      await saveState()
      return `${account}: 首次采集，已记录基线 ${newest}（不补发历史）`
    }

    // 时间线为最新在前；仅推送基线之后、且从未推送过的新推文
    const fresh = candidates
      .filter(tweet => tweet.id > last && !pushedTweetIds.has(tweet.id))
      .sort((a, b) => a.id.localeCompare(b.id))
    // 水位线只前进、不倒退：镜像接口（fxtwitter/vxtwitter）偶发解析失败时，成功解析的可能只剩
    // 旧推文（主页返回的 5 个 ID 里含置顶推），若无条件回写会把水位线拉低，
    // 下一轮「所有 ID 都大于水位线」→ 置顶旧推文整批重复推送（实测会跨天循环重推）。
    if (newerSnowflake(newest, last)) {
      lastIds[account] = newest
    } else if (newest !== last) {
      xlog('warn', `推文 ${account} 本轮解析到的最新 ID ${newest} 不大于水位线 ${last}（镜像解析部分失败），水位线保持不变（防重复推送）`, account)
    }
    let sent = 0
    let pushed = 0
    for (const tweet of fresh) {
      if (!passesFilters(tweet.text)) continue
      pushed++
      sent += await push(account, `@${tweet.author}`, tweet.text, `https://x.com/${account}/status/${tweet.id}`, tweet.createdAt, tweet.images, tweet.videos, tweet.gifs, undefined, tweet.avatarUrl, tweet.id)
      // 无论本次是否部分群失败都记为「已推送」：宁可少数群漏一条，也不能对同一条反复刷屏
      pushedTweetIds.add(tweet.id)
    }
    if (pushed) {
      while (pushedTweetIds.size > PUSHED_IDS_LIMIT) {
        const oldest = pushedTweetIds.values().next().value
        if (oldest == null) break
        pushedTweetIds.delete(oldest)
      }
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

    const fresh = items.filter(item => item.id > last && !pushedTweetIds.has(item.id))
    // 水位线只前进、不倒退（与 HTTP 直取同理：源偶发只吐旧内容时防止整批重推）
    if (newerSnowflake(newest, last)) {
      lastIds[account] = newest
    } else if (newest !== last) {
      xlog('warn', `RSS ${account} 本轮最新 ID ${newest} 不大于水位线 ${last}，水位线保持不变（防重复推送）`)
    }
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
      pushedTweetIds.add(item.id)
    }
    if (pushed) {
      while (pushedTweetIds.size > PUSHED_IDS_LIMIT) {
        const oldest = pushedTweetIds.values().next().value
        if (oldest == null) break
        pushedTweetIds.delete(oldest)
      }
    }
    await saveState()
    return `${account}: 新内容 ${fresh.length} 条（推送 ${pushed} 条），发送成功 ${sent} 群次`
  }

  async function pollAccount(account: string): Promise<string> {
    return config.sourceMode === 'rsshub'
      ? pollAccountViaRss(account)
      : pollAccountViaRettiwt(account)
  }

  // X 轮询与 DC 兜底轮询各自独立、互不阻塞：
  // 此前两者共用一个 polling 标志和 10 分钟定时器，X 侧任何慢请求（截图/翻译/接口超时）
  // 都会把 DC 的读取整体推迟到下一轮，DC 消息因此可能延迟十几分钟。
  async function pollXOnce(manual: boolean): Promise<string> {
    if (xPolling) return '上一轮 X 轮询尚未结束'
    const accounts = allAccounts()
    if (!accounts.length) return '未配置 X 推送账号'
    xPolling = true
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
    } finally {
      xPolling = false
    }
    const summary = results.join('\n')
    log('info', `X 轮询完成${manual ? '（手动）' : ''}:\n${summary}`)
    return summary
  }

  // DC 兜底轮询：只读取推送板块内配置的中转频道（实时消息由 discord/message-create 事件即时转发）
  async function pollDiscordOnce(manual: boolean): Promise<string> {
    if (dcPolling) return '上一轮 DC 轮询尚未结束'
    if (!config.discordEnabled) return 'Discord 未启用'
    if (!allDiscordChannels().length) return '推送板块内未配置有效的 DC 推送频道'
    dcPolling = true
    try {
      const summary = await pollDiscord()
      // 兜底轮询默认 15 秒一次，空轮不写日志，避免刷屏；有新增/失败才输出
      if (manual || /(?:新消息 [1-9]|推送成功 [1-9]|失败|没有可用机器人|未找到 APP ID)/.test(summary)) {
        dclog('info', `DC 轮询完成${manual ? '（手动）' : ''}:\n${summary}`)
      }
      return summary
    } finally {
      dcPolling = false
    }
  }

  // ---------------- Discord 中转（通过 DC 机器人读取指定频道内容） ----------------

  // 雪花 ID（推文/消息）大小比较：正常是纯数字字符串，用 BigInt 精确比较；
  // 出现非数字内容时退回长度 + 字典序（等长数字串下与数值序一致）。
  function newerSnowflake(a?: string, b?: string): boolean {
    const x = String(a ?? '').trim()
    const y = String(b ?? '').trim()
    if (!x) return false
    if (!y) return true
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return BigInt(x) > BigInt(y)
    return x.length > y.length || (x.length === y.length && x > y)
  }

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
    // DC 中转走独立的推送队列（lane='dc'）：既不会被 X 的批量补发堵住，
    // 翻译也有等待上限，保证「消息到达 → 群内可见」的总体延迟可控。
    const t0 = Date.now()
    const sent = await push(account || authorName || `dc:${channelId}`, source, body, '', '', images, videos, [], boardTargets, undefined, messageId, 'dc')
    dclog('info', `Discord 中转内容已推送 ${sent} 群次（用时 ${Date.now() - t0}ms）${images.length || videos.length ? `（附带 ${images.length} 图 / ${videos.length} 视频）` : ''}`)
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
    const changed = maxId !== lastMessageIds[channelId] || collected.length > 0
    lastMessageIds[channelId] = maxId
    let sent = 0
    for (const message of collected) {
      // 回源 REST 补全内容：正文被截断的用 embed 完整标题/摘要补齐，并取出 embed 配图与附件媒体
      const media = await enrichDiscordMessage(bot, channelId, message)
      const before = sent
      const startedAt = Date.now()
      sent += await relayMessage(message, channelId, bot.selfId, true, media)
      // 由「兜底轮询」而不是网关事件转发的消息：说明实时事件没收到（或机器人当时离线），
      // 这里把「消息发布 → 群内可见」的耗时打出来，方便一眼判断延迟到底来自哪一段。
      if (sent > before) {
        const rawTs = typeof message?.createdAt === 'number' ? message.createdAt : Date.parse(String(message?.timestamp || ''))
        if (Number.isFinite(rawTs) && rawTs > 0) {
          const age = startedAt - rawTs
          const note = age > 5000 ? '（实时事件未收到，本次为轮询补发）' : ''
          dclog('info', `Discord 兜底轮询转发 ...${String(message.id).slice(-6)}：消息发布 → 群内可见 ${Math.max(0, age)}ms${note}`)
        }
      }
    }
    // 兜底轮询 15 秒一次，无新消息时不写盘
    if (changed) await saveState()
    return `Discord #${channelId}: 新消息 ${collected.length} 条，推送成功 ${sent} 群次`
  }

  // 判断「这个机器人是不是本插件要用的中转机器人」。
  // 配置了 dcAppId 时优先只认它；但如果该 APP ID 对应的机器人根本没连上（token 失效 / 适配器停用），
  // 就退化为放行所有 discord 机器人 —— 否则实时事件永远匹配不上，只能靠轮询，延迟被拉到轮询周期。
  function isRelayBot(bot: any): boolean {
    if (!bot || bot.platform !== 'discord') return false
    const appId = String(config.dcAppId || '').trim()
    if (!appId) return true
    if (String(bot.selfId) === appId) return true
    return !ctx.bots.some(b => b.platform === 'discord' && String(b.selfId) === appId)
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

  // ---------------- Discord 实时推送（gateway 原始事件，不等轮询） ----------------
  //
  // 直接监听 satori Discord 适配器派发的 discord/message-create 原始事件，而不是上层
  // message-created session：当消息是「回复 / 转发」且机器人无权读取被引用消息时，
  // 适配器的 decodeMessage 会抛 403 Missing Access 并丢弃整个 session，导致实时转发从未触发，
  // 只能等 10 分钟一次的轮询。原始事件在 decodeMessage 之前派发，字段（content / embeds /
  // attachments / message_reference）完整，既不丢消息也不受适配器解析失败影响。
  //
  // 兜底轮询仍然保留（默认 15 秒），用于 webhook 事件漏收 / 机器人短暂离线期间补收；
  // discordSeen 去重保证同一条消息只会推送一次。

  function trimDiscordSeen() {
    if (discordSeen.size <= 400) return
    for (const id of [...discordSeen].slice(0, 200)) discordSeen.delete(id)
  }

  // 事件名不在 Koishi 的事件类型表里（由 discord 适配器的 internal 会话派发），用 any 绕过类型校验
  ctx.on('discord/message-create' as any, async (data: any, bot: any) => {
    try {
      if (disposed || !config.discordEnabled) return
      if (!bot || bot.platform !== 'discord') return
      // 固定使用配置的 DC 机器人（与轮询一致），其它机器人（如 DC-QQ 桥接）的频道事件不处理。
      // 例外：配置的 APP ID 对应的机器人根本没连上时，退化为「谁收到就用谁」，避免实时转发整条失效
      // （此前这种不一致会导致只能靠轮询转发，延迟被拉到轮询周期）。
      if (!isRelayBot(bot)) {
        const evtChannel = String(data?.channel_id || '')
        if (evtChannel && allDiscordChannels().includes(evtChannel)) {
          dclog('warn', `中转频道的实时事件来自机器人 ${bot.selfId}，与配置的 DC 机器人 ${config.dcAppId} 不一致，已忽略`)
        }
        return
      }
      const channelId = String(data?.channel_id || '')
      if (!channelId || !allDiscordChannels().includes(channelId)) return
      const messageId = String(data?.id || '')
      if (!messageId) return

      // Discord 原始时间戳 → 网关事件延迟（一般 <1s；若经常偏大说明网关事件不稳）
      const rawType = Number(data.type ?? 0)
      const sentAt = Number(data.timestamp) ? Date.parse(String(data.timestamp)) : 0
      const gatewayLag = sentAt ? Date.now() - sentAt : null
      const isSelf = String(data.author?.id || '') === String(bot.selfId)
      // 到达日志放在「自身消息过滤」之前：这样即使只是机器人自己发消息，也能确认网关事件链路是通的
      dclog('info', `Discord 网关收到消息：频道 ${channelId}，消息 ...${messageId.slice(-6)}，作者 ${data.author?.id}，type=${rawType}，embeds=${Array.isArray(data.embeds) ? data.embeds.length : 0}，attachments=${Array.isArray(data.attachments) ? data.attachments.length : 0}${gatewayLag != null ? `，网关延迟 ${Math.max(0, gatewayLag)}ms` : ''}${isSelf ? '（本机器人自己发出，跳过转发）' : ''}`)

      // 跳过机器人自身消息（本插件推送出去的内容）
      if (isSelf) return
      if (discordSeen.has(messageId)) return
      // 先占位，避免与兜底轮询同时处理同一条消息
      discordSeen.add(messageId)
      trimDiscordSeen()

      // 0=普通消息 12=频道跟随系统消息 19=回复；其余系统消息没有可转发的正文
      if (rawType !== 0 && rawType !== 12 && rawType !== 19) {
        dclog('info', `跳过 Discord 系统消息（type=${rawType}，无实质正文）`)
        return
      }
      const arrivedAt = Date.now()

      // 统一包装成 relayMessage 需要的 message 结构（content / author / type）
      const message: any = {
        id: messageId,
        content: String(data.content || ''),
        author: data.author,
        type: rawType,
      }
      if (rawType === 12) {
        const follower = String(data.author?.username || data.author?.global_name || '有人')
        message.content = `${follower} 将「${String(data.content || '').trim()}」加入了此频道，最重要的更新都将显示在这里。`
        dclog('info', 'Discord 频道跟随系统消息，已拼装完整文案')
      }

      // gateway 原始数据已包含 embed / 附件：直接并入正文并收集媒体，无需再回源 REST
      const media: DiscordRawMedia = mergeDiscordEmbeds(message, Array.isArray(data.embeds) ? data.embeds : [])
      const attachment = collectAttachmentMedia(data.attachments)
      media.images.push(...attachment.images)
      media.videos.push(...attachment.videos)

      // 转发消息/回复：本体 content 为空时，从被引用的原消息取正文与媒体
      const ref = data.message_reference
      if (!String(message.content || '').trim() && ref?.message_id) {
        const refChannelId = String(ref.channel_id || channelId)
        try {
          if (typeof bot.internal?.getChannelMessage !== 'function') throw new Error('当前 Discord 适配器不支持读取单条消息')
          const orig: any = await bot.internal.getChannelMessage(refChannelId, String(ref.message_id))
          if (orig) {
            const origMedia = mergeDiscordEmbeds(message, Array.isArray(orig.embeds) ? orig.embeds : [])
            if (!String(message.content || '').trim() && String(orig.content || '').trim()) {
              message.content = String(orig.content).trim()
            }
            media.images.push(...origMedia.images)
            const origAttachment = collectAttachmentMedia(orig.attachments)
            media.images.push(...origAttachment.images)
            media.videos.push(...origAttachment.videos)
            dclog('info', `Discord 转发/回复消息 ...${messageId.slice(-6)} 已从原消息取得内容（${String(message.content || '').length} 字）`)
          }
        } catch (error: any) {
          // 降级：原内容不可得（bot 无原频道权限），推送占位说明 + 原消息直链
          dclog('warn', `Discord 转发消息 ...${messageId.slice(-6)} 的原内容读取失败（原频道 ${refChannelId}）：${error?.message || error}，已降级为链接推送`)
          message.content = `📎 该消息为 Discord「转发」，正文不随消息传输且机器人无权读取原频道，请点开链接在 Discord 查看：\nhttps://discord.com/channels/${String(ref.guild_id || data.guild_id || '')}/${refChannelId}/${String(ref.message_id)}`
        }
      }

      if (!String(message.content || '').trim() && !media.images.length && !media.videos.length) {
        dclog('warn', `Discord 实时消息 ...${messageId.slice(-6)} 无有效正文与媒体，跳过`)
        return
      }

      // relayMessage 内部会做转推/过滤/目标归属判断并推送；消息 ID 已提前占位，这里 markSeen=false
      const sent = await relayMessage(message, channelId, bot.selfId, false, media)
      if (sent > 0) {
        const total = gatewayLag != null ? Math.max(0, gatewayLag) + (Date.now() - arrivedAt) : Date.now() - arrivedAt
        dclog('info', `Discord 实时消息已推送 ${sent} 群次（频道 ${channelId}，消息 ...${messageId.slice(-6)}，消息发布→群内可见 ${total}ms）`)
      }
    } catch (error: any) {
      dclog('warn', `Discord 实时消息处理失败: ${error?.message || error}`)
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

        // 2. API_KEY 格式已校验通过；rettiwt 主路径因 X 反爬已失效，实际抓取走
        //    「未登录主页取推文 ID → fxtwitter / vxtwitter 解析」，与正式推送通道一致。
        let avatarFallback: string | undefined
        lines.push('✓ API_KEY 格式有效（rettiwt 主路径已失效，实际抓取走匿名主页 + fxtwitter/vxtwitter）。')

        // 4. 获取最新一条推文：HTTP 直取优先，浏览器匿名回退
        let tweet: RettiwtTweet | null = null
        let browserAvatar = ''
        try {
          const { ids, avatar: httpAvatar } = await fetchLatestTweetIdsViaHttp(target)
          if (ids.length) {
            const newest = [...ids].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
            tweet = await fetchTweetFromMirror(target, `https://x.com/${target}/status/${newest}`)
            browserAvatar = tweet?.avatarUrl || httpAvatar || ''
          }
        } catch (error: any) {
          lines.push(`⚠ HTTP 直取失败：${error?.message || error}，尝试浏览器回退...`)
        }
        if (!tweet) {
          if (!config.xBrowserFallback) {
            lines.push('✘ 未能获取到最新推文（HTTP 直取无结果；浏览器回退已在配置中关闭）')
            return lines.join('\n')
          }
          try {
            const latest = await fetchLatestTweetUrlViaBrowser(target)
            if (!latest?.url) {
              lines.push('✘ 未能获取到最新推文（请确认服务器可访问 x.com，且 Puppeteer 服务可用）。')
              return lines.join('\n')
            }
            browserAvatar = latest.avatar || browserAvatar || ''
            tweet = await fetchTweetFromMirror(target, latest.url)
            if (!tweet) {
              lines.push('✘ 拿到了推文链接，但 fxtwitter / vxtwitter 均解析失败。')
              return lines.join('\n')
            }
          } catch (error: any) {
            lines.push(`✘ 浏览器回退失败：${error?.message || error}`)
            return lines.join('\n')
          }
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
        const screenshot = await captureTweetScreenshot(tweetUrl, {
          account: target,
          author: `@${tweet.author || target}`,
          text: bodyText,
          images: tweet.images,
          avatarUrl: tweet.avatarUrl || browserAvatar || avatarFallback,
          pubDate,
          link: tweetUrl,
        })
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
    // DC 机器人一致性检查：配置的 APP ID 没连上时，实时事件只能退化为「谁收到用谁」，
    // 这种情况一定伴随实时转发异常，启动阶段就提示出来，免得再去日志里翻。
    if (config.discordEnabled && allDiscordChannels().length) {
      const bots = ctx.bots.filter(b => b.platform === 'discord')
      if (!bots.length) {
        dclog('warn', '没有已连接的 Discord 机器人，DC 中转只能靠 REST 轮询（请检查 adapter-discord 配置）')
      } else if (config.dcAppId && !bots.some(b => String(b.selfId) === String(config.dcAppId))) {
        dclog('warn', `配置的 DC 机器人 ${config.dcAppId} 未连接；当前已连接：${bots.map(b => b.selfId).join(', ')}。实时转发将使用实际连接的机器人，兜底轮询照旧`)
      } else {
        dclog('info', `DC 实时转发就绪：机器人 ${bots.map(b => b.selfId).join(', ')}，优先匹配 ${config.dcAppId || '（未指定）'}`)
      }
    }
    // 模型名作为变量：根据配置的 API KEY 与地址在线获取可用模型，重建面板下拉选项
    refreshModels().catch(() => {})
    loadState().then(() => {
      // X 与 DC 使用各自独立的定时器与重入锁：X 轮询再慢也不会推迟 DC 实时/兜底读取
      const xActive = config.xEnabled && allAccounts().length > 0
      const dcActive = config.discordEnabled && allDiscordChannels().length > 0
      if (xActive) {
        const interval = Math.max(1, config.intervalMinutes) * 60 * 1000
        timers.set('x-poll', setInterval(() => { if (!disposed) pollXOnce(false).catch(() => {}) }, interval))
        // 启动后 15 秒执行首轮 X 采集
        timers.set('x-first', setTimeout(() => { if (!disposed) pollXOnce(false).catch(() => {}) }, 15000))
      }
      if (dcActive) {
        // 兜底轮询默认 15 秒：实时消息由 discord/message-create 事件即时转发，
        // 这里只负责补收事件漏掉的消息，不再等 X 的 10 分钟周期
        const dcInterval = Math.max(5, Number(config.dcIntervalSeconds) || 15) * 1000
        timers.set('dc-poll', setInterval(() => { if (!disposed) pollDiscordOnce(false).catch(() => {}) }, dcInterval))
        // 启动后 5 秒执行首轮 DC 兜底读取
        timers.set('dc-first', setTimeout(() => { if (!disposed) pollDiscordOnce(false).catch(() => {}) }, 5000))
      }
    }).catch(() => {})
  })

  ctx.on('dispose', () => {
    disposed = true
    timers.forEach(timer => { clearTimeout(timer); clearInterval(timer) })
    timers.clear()
    log('info', '插件卸载，定时器已全部清理')
  })
}
