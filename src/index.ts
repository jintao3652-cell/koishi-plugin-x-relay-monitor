import { Context, Schema, h, Session } from 'koishi'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// ============================== 类型定义 ==============================

interface TargetConfig {
  platform: string
  channelId: string
}

interface AccountTargetConfig extends TargetConfig {
  account: string
}

export interface Config {
  sourceMode: 'rsshub' | 'browser'
  xEnabled: boolean
  accounts: string[]
  intervalMinutes: number
  requestTimeout: number
  excludeRetweets: boolean
  includeFilter: string
  excludeFilter: string
  // browser 模式（twitter-fetcher 方式）
  xAuthToken: string
  apiProvider: 'fxtwitter' | 'vxtwitter'
  includeQuote: boolean
  browserMaxTweets: number
  // rsshub 模式
  rssTemplate: string
  rsshubAccessKey: string
  // Discord 中转
  discordEnabled: boolean
  discordChannels: string[]
  // OpenAI 翻译
  openaiApiKey: string
  openaiBaseURL: string
  openaiModel: string
  systemPrompt: string
  // 推送
  linkStyle: 'original' | 'fxtwitter' | 'vxtwitter'
  targets: TargetConfig[]
  accountTargets: AccountTargetConfig[]
  enableLog: boolean
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

const AccountTargetSchema = Schema.intersect([
  Schema.object({
    account: Schema.string().required().description('X 账号（不含 @）'),
  }),
  TargetSchema,
]) as Schema<AccountTargetConfig>

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    sourceMode: Schema.union([
      Schema.const('browser').description('浏览器模式（twitter-fetcher 方式：Puppeteer + fx/vx API）'),
      Schema.const('rsshub').description('RSS 模式（RSSHub /twitter/user 路由）'),
    ]).default('browser').description('X 数据获取方式'),
    xEnabled: Schema.boolean().default(true).description('启用 X 账号轮询'),
  }),
  Schema.object({
    accounts: Schema.array(Schema.string().pattern(/^\S+$/)).default([]).description('白名单 X 账号（不含 @）'),
    intervalMinutes: Schema.number().min(1).max(1440).step(1).default(10).description('轮询间隔（分钟）'),
    requestTimeout: Schema.number().min(5000).max(120000).step(1000).default(30000).description('单次请求超时（毫秒）'),
    excludeRetweets: Schema.boolean().default(true).description('排除转推（浏览器模式同时跳过“已转帖”卡片，RSS 模式按 RT @ 判断）'),
    includeFilter: Schema.string().default('').description('包含过滤（正则，留空不过滤；命中才推送）'),
    excludeFilter: Schema.string().default('').description('排除过滤（正则，留空不过滤；命中则不推送）'),
  }),
  Schema.object({
    xAuthToken: Schema.string().role('secret').default('').description('X 登录 Cookie auth_token（浏览器模式可选，用于查看受保护账号）'),
    apiProvider: Schema.union([
      Schema.const('fxtwitter').description('api.fxtwitter.com'),
      Schema.const('vxtwitter').description('api.vxtwitter.com'),
    ]).default('fxtwitter').description('推文数据 API 提供方（失败自动回退另一个）'),
    includeQuote: Schema.boolean().default(false).description('附带引用推文内容'),
    browserMaxTweets: Schema.number().min(1).max(20).step(1).default(5).description('浏览器模式每次最多检查的最新推文条数'),
  }).description('浏览器模式（twitter-fetcher 方式）'),
  Schema.object({
    rssTemplate: Schema.string().default('https://rsshub.app/twitter/user/{account}')
      .description('RSS 源模板，{account} 会被替换为账号名'),
    rsshubAccessKey: Schema.string().role('secret').default('').description('RSSHub accessKey（自建实例可留空）'),
  }).description('RSS 模式'),
  Schema.object({
    discordEnabled: Schema.boolean().default(true).description('启用 Discord 中转频道监听'),
    discordChannels: Schema.array(Schema.string()).default([]).description('只监听这些自己服务器的中转频道 ID'),
  }),
  Schema.object({
    openaiApiKey: Schema.string().role('secret').default('').description('OpenAI API Key（留空则只发原文）'),
    openaiBaseURL: Schema.string().default('https://api.openai.com/v1').description('API Base URL（兼容 Chat Completions）'),
    openaiModel: Schema.string().default('gpt-4o-mini').description('模型名'),
    systemPrompt: Schema.string().default('你是专业模拟飞行领域翻译。将用户内容准确翻译为简体中文，保留专有名词、呼号、机场代码与数字，只输出译文，不要附加说明。').description('翻译系统提示词'),
  }),
  Schema.object({
    linkStyle: Schema.union([
      Schema.const('original').description('原始 twitter.com 链接'),
      Schema.const('fxtwitter').description('fxtwitter.com（国内可打开）'),
      Schema.const('vxtwitter').description('vxtwitter.com（国内可打开）'),
    ]).default('vxtwitter').description('推送中的推文链接样式'),
    targets: Schema.array(TargetSchema).default([]).description('全局推送目标（未被账号映射覆盖时使用）'),
    accountTargets: Schema.array(AccountTargetSchema).default([]).description('按账号推送：为指定账号单独配置目标群'),
    enableLog: Schema.boolean().default(true).description('输出详细日志'),
  }),
]) as Schema<Config>

export const name = 'x-relay-monitor'
export const inject = ['http']

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

  function log(level: 'info' | 'warn' | 'error', message: string, ...args: any[]) {
    if (level === 'info' && !config.enableLog) return
    logger[level](`[X监控] ${message}`, ...args)
  }

  // ---------------- 状态持久化 ----------------

  async function loadState() {
    try {
      const state = JSON.parse(await fs.readFile(dataFile, 'utf8'))
      if (state?.lastIds) Object.assign(lastIds, state.lastIds)
      if (Array.isArray(state?.discordSeen)) state.discordSeen.forEach((id: string) => discordSeen.add(id))
    } catch { /* 首次运行无状态文件 */ }
  }

  async function saveState() {
    await fs.mkdir(path.dirname(dataFile), { recursive: true })
    const seen = [...discordSeen].slice(-200)
    await fs.writeFile(dataFile, JSON.stringify({ lastIds, discordSeen: seen }, null, 2))
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

  function targetsFor(account: string): TargetConfig[] {
    const mapped = config.accountTargets
      .filter(t => t.account.toLowerCase() === account.toLowerCase())
      .map(({ platform, channelId }) => ({ platform, channelId }))
    return mapped.length ? mapped : config.targets
  }

  async function translate(text: string): Promise<string | null> {
    if (!config.openaiApiKey) return null
    try {
      const res: any = await ctx.http.post(`${config.openaiBaseURL.replace(/\/$/, '')}/chat/completions`, {
        model: config.openaiModel,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
      }, {
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        timeout: Math.max(config.requestTimeout, 60000),
      })
      const content = res?.choices?.[0]?.message?.content?.trim()
      return content || null
    } catch (error: any) {
      log('warn', `翻译失败，仅发送原文: ${error?.message || error}`)
      return null
    }
  }

  async function push(account: string, source: string, text: string, link: string, pubDate: string, images: string[], videos: string[] = []): Promise<number> {
    const targets = targetsFor(account)
    if (!targets.length) {
      log('warn', `账号 ${account} 没有可用推送目标，跳过`)
      return 0
    }

    const translated = await translate(text)
    const lines = [
      `🐦 ${source}`,
      '━━━━━━━━━━━━',
      text,
    ]
    if (translated) lines.push('', '📝 译文：', translated)
    if (videos.length) lines.push('', '🎬 媒体: ' + videos.join(' | '))
    if (pubDate) lines.push('', `🕒 ${pubDate}`)
    if (link) lines.push(`🔗 ${buildLink(link)}`)

    const segments: any[] = [lines.join('\n')]
    for (const image of images) {
      try { segments.push(h.image(image)) } catch { /* 单张图片失败不影响整体 */ }
    }

    let sent = 0
    for (const target of targets) {
      // 防回环：Discord 中转频道本身不作为推送目标
      if (target.platform === 'discord' && config.discordChannels.includes(target.channelId)) continue
      const bot = ctx.bots.find(b => b.platform === target.platform && b.status === 'online') || ctx.bots.find(b => b.platform === target.platform)
      if (!bot) {
        log('warn', `平台 ${target.platform} 没有可用机器人，无法推送到 ${target.channelId}`)
        continue
      }
      try {
        await bot.sendMessage(target.channelId, segments)
        sent++
      } catch (error: any) {
        log('warn', `推送到 ${target.platform}:${target.channelId} 失败: ${error?.message || error}`)
      }
    }
    return sent
  }

  // ---------------- 推文数据补全（fx/vx API，twitter-fetcher 方式） ----------------

  interface TweetData { text: string, images: string[], videos: string[], author: string, createdAt: string }

  async function fetchTweetData(id: string, account: string): Promise<TweetData | null> {
    const providers = config.apiProvider === 'vxtwitter' ? ['vxtwitter', 'fxtwitter'] : ['fxtwitter', 'vxtwitter']
    for (const provider of providers) {
      try {
        const url = `https://api.${provider}.com/${account}/status/${id}`
        const res = await ctx.http.get(url, {
          responseType: 'text',
          timeout: config.requestTimeout,
          headers: { 'User-Agent': 'Koishi-X-Relay-Monitor', Referer: 'https://x.com/' },
        })
        const data = JSON.parse(typeof res === 'string' ? res : String(res))
        const tweet = data?.tweet || data?.data?.tweet
        if (!tweet) continue
        const images: string[] = []
        const videos: string[] = []
        const media = tweet.media?.all || tweet.media?.photos || (Array.isArray(tweet.media) ? tweet.media : [])
        for (const item of media) {
          if (!item?.url) continue
          if (item.type === 'photo') images.push(item.url)
          else videos.push(item.url)
        }
        let text = String(tweet.text || '')
        if (config.includeQuote && tweet.quote) {
          text += `\n\n引用 @${tweet.quote.author?.screen_name || ''}: ${tweet.quote.text || ''}`
        }
        return {
          text,
          images,
          videos,
          author: tweet.author?.screen_name || account,
          createdAt: tweet.created_at || '',
        }
      } catch { /* 尝试下一个提供方 */ }
    }
    return null
  }

  // ---------------- 浏览器模式（twitter-fetcher 方式） ----------------

  async function collectProfileTweetIds(account: string): Promise<string[]> {
    const puppeteer = (ctx as any).puppeteer
    if (!puppeteer?.page) throw new Error('浏览器模式需要安装并启用 puppeteer 服务')
    const page = await puppeteer.page()
    try {
      if (config.xAuthToken) {
        await page.setCookie({ name: 'auth_token', value: config.xAuthToken, domain: '.x.com', path: '/', httpOnly: true, secure: true })
      }
      log('info', `正在访问用户主页: https://x.com/${account}`)
      await page.goto(`https://x.com/${account}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 20000 })
      const ids: string[] = await page.evaluate((max: number, excludeRetweets: boolean) => {
        const out: string[] = []
        const seen = new Set<string>()
        for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
          const contextEl = article.querySelector('[data-testid="socialContext"]')
          const contextText = contextEl?.textContent || ''
          if (/(pinned|已置顶|置顶|固定|置頂)/i.test(contextText)) continue
          if (excludeRetweets && /(retweeted|reposted|retweet|repost|转推|轉推|转发|已转帖)/i.test(contextText)) continue
          const link = article.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null
          const id = link?.href.match(/status\/(\d+)/)?.[1]
          if (!id || seen.has(id)) continue
          seen.add(id)
          out.push(id)
          if (out.length >= max) break
        }
        return out
      }, config.browserMaxTweets, config.excludeRetweets)
      log('info', `${account}: 页面上找到 ${ids.length} 条候选推文`)
      return ids
    } finally {
      await page.close()
    }
  }

  async function pollAccountViaBrowser(account: string): Promise<string> {
    const ids = await collectProfileTweetIds(account)
    if (!ids.length) return `${account}: 主页上未找到符合条件的推文`

    const last = lastIds[account]
    if (!last) {
      // 首次见到该账号：只记录基线，不补发历史
      lastIds[account] = ids[0]
      await saveState()
      return `${account}: 首次采集，已记录基线 ${ids[0]}（不补发历史）`
    }

    // DOM 为最新在前；逐条用 fx/vx API 补全数据后走统一管线
    const freshIds = ids.filter(id => id > last).sort((a, b) => a.localeCompare(b))
    lastIds[account] = ids[0]
    let sent = 0
    let pushed = 0
    for (const id of freshIds) {
      const data = await fetchTweetData(id, account)
      if (!data) {
        log('warn', `${account}/status/${id}: fx/vx API 解析失败，跳过`)
        continue
      }
      if (!passesFilters(data.text)) continue
      pushed++
      sent += await push(account, `@${data.author}`, data.text, `https://x.com/${account}/status/${id}`, data.createdAt, data.images, data.videos)
    }
    await saveState()
    return `${account}: 新推文 ${freshIds.length} 条（推送 ${pushed} 条），发送成功 ${sent} 群次`
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
        log('info', `跳过转推 ${item.id}`)
        continue
      }
      if (!passesFilters(item.text)) continue
      pushed++
      sent += await push(account, `@${account}`, item.text, item.link, item.pubDate, item.images, item.videos)
    }
    await saveState()
    return `${account}: 新内容 ${fresh.length} 条（推送 ${pushed} 条），发送成功 ${sent} 群次`
  }

  async function pollAccount(account: string): Promise<string> {
    return config.sourceMode === 'browser'
      ? pollAccountViaBrowser(account)
      : pollAccountViaRss(account)
  }

  async function pollOnce(manual: boolean): Promise<string> {
    if (polling) return '上一轮轮询尚未结束'
    if (!config.accounts.length) return '未配置 X 账号'
    polling = true
    const results: string[] = []
    try {
      for (const account of config.accounts) {
        if (disposed) break
        try {
          results.push(await pollAccount(account))
        } catch (error: any) {
          results.push(`${account}: 拉取失败 ${error?.message || error}`)
          log('warn', `拉取 ${account} 失败: ${error?.message || error}`)
        }
      }
    } finally {
      polling = false
    }
    const summary = results.join('\n')
    log('info', `轮询完成${manual ? '（手动）' : ''}:\n${summary}`)
    return summary
  }

  // ---------------- Discord 中转监听 ----------------

  function extractTwitterAccount(session: Session): string {
    // 中转消息若以 @handle: 开头，则视为该账号的内容（用于账号级推送映射）
    const m = session.content?.match(/^\s*@?([A-Za-z0-9_]{1,15})\s*[:：]\s*/)
    return m?.[1] || ''
  }

  async function handleDiscordRelay(session: Session) {
    const messageId = session.messageId || `${session.timestamp}`
    if (discordSeen.has(messageId)) return
    discordSeen.add(messageId)
    if (discordSeen.size > 400) {
      for (const id of [...discordSeen].slice(0, 200)) discordSeen.delete(id)
    }
    await saveState().catch(() => {})

    const text = session.content?.trim()
    if (!text) return
    if (config.excludeRetweets && /^RT @/.test(text)) return
    if (!passesFilters(text)) return

    const account = extractTwitterAccount(session)
    const source = account ? `@${account}（Discord 中转）` : `Discord 中转 #${session.channelId}`
    const sent = await push(account || session.userId, source, text, '', '', [])
    log('info', `Discord 中转内容已推送 ${sent} 群次`)
  }

  ctx.middleware(async (session, next) => {
    if (disposed || !config.discordEnabled || session.platform !== 'discord') return next()
    if (!config.discordChannels.includes(session.channelId)) return next()
    if (session.selfId && session.userId === session.selfId) return next()
    await handleDiscordRelay(session).catch(error => log('warn', `处理中转消息失败: ${error?.message || error}`))
    return next()
  })

  // ---------------- 指令 ----------------

  ctx.command('x检查', '手动检查白名单 X 账号的新内容')
    .action(async () => {
      const result = await pollOnce(true)
      return result.replace(/\n/g, '\n')
    })

  // ---------------- 启动与清理 ----------------

  ctx.on('ready', () => {
    log('info', `插件启动: 模式 ${config.sourceMode}, X 账号 ${config.accounts.length} 个, 中转频道 ${config.discordChannels.length} 个, 推送目标 ${config.targets.length} 组`)
    loadState().then(() => {
      if (!config.xEnabled) return
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
