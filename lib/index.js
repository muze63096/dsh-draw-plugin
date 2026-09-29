/**
 * dsh-draw — HOST half
 *
 * 一个 DSH（DeepSeek Harness）画图插件：面板里写提示词 → 选画风（Q版/正常）→ 选引擎出图。
 *
 * 引擎三选一（由使用者在面板里选，Key 由使用者自己填）：
 *   - pollinations：免费、无需 Key（默认）
 *   - siliconflow ：硅基流动（Kolors 等）
 *   - custom      ：任意 OpenAI 兼容的 /images/generations 端点
 *
 * 本文件负责：
 *   1. 把一个无依赖的 Node 生成脚本写到工作区（<workspace>/.dsh-draw-gen.mjs）；
 *   2. 通过 shell 服务运行它（脚本自己用 fetch 出网，绕开 Windows 沙箱对系统 TLS 的限制）；
 *   3. 挂 HTTP 路由：
 *        POST /dsh-draw/api        ← 客户端调用出图
 *        GET  /dsh-draw/img/<id>   ← 把生成结果喂给 <img>
 *   4. 需要时用宿主已配置的模型把中文提示词译成英文（免费引擎吃中文会转写实风）。
 *
 * 路径锚点：
 *   - 生成脚本、记住的设置、可选的 Key 文件都放 `$DSH_HOME`；
 *   - 出图目录由使用者指定，默认 `$DSH_HOME/dsh-draw`，
 *     选择记住在 `$DSH_HOME/dsh-draw.config.json`。
 * 不要依赖 fs/shell 的相对路径默认值——它们的 cwd 是 DSH 进程的启动目录。
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

/** 生成脚本的文件名（落在工作区根目录）。 */
const SCRIPT_NAME = '.dsh-draw-gen.mjs'
/** 可选的 Key 文件：面板不填 Key 时从这里读。 */
const KEY_FILE_NAME = '.dsh-draw-key.txt'
/** 初始化失败时把原因写在这里，方便排查（正常情况下不会存在）。 */
const INIT_LOG_NAME = '.dsh-draw-init-error.txt'
/** 默认出图目录名（位于 $DSH_HOME 下）。 */
const DEFAULT_OUT_DIR = 'dsh-draw'
/** 记住使用者选择的保存位置（JSON，放在 $DSH_HOME 下）。 */
const CONFIG_NAME = 'dsh-draw.config.json'

const API_PATH = '/dsh-draw/api'
const IMG_PREFIX = '/dsh-draw/img/'
const MAX_IMAGE_BYTES = 20_000_000
const MAX_REQUEST_BYTES = 400_000

/** 每个引擎的默认端点与默认模型。 */
const ENGINE_DEFAULTS = {
  pollinations: { baseUrl: '', model: 'turbo' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' },
  custom: { baseUrl: '', model: '' },
}

/** 翻译指令：要求只回英文关键词，不要句子/引号/解释。 */
const TRANSLATE_RULE =
  'Turn the Chinese image request below into ONE English image-generation prompt. '
  + 'Reply with the English prompt only: comma-separated visual keywords, no sentences, no quotes, '
  + 'no explanation, no markdown. Keep every concrete detail (character, hair, clothing, colors, pose, '
  + 'action, scene, mood). Keep it under 60 words.\n\n'

/**
 * 写到工作区、由 `node` 执行的生成脚本。
 *
 * 为什么是"写脚本再跑"，而不是宿主直接 fetch：
 *   - 宿主运行在受限求值环境里，没有 fetch；
 *   - Windows 沙箱下 curl / .NET 的系统 TLS 会被拒（schannel SEC_E_NO_CREDENTIALS），
 *     而 Node 自带 OpenSSL，出网正常。
 * 脚本从 stdin 读 JSON 请求（Key 不进命令行，避免出现在进程列表里），
 * 成功后把结果 JSON 打到 stdout 最后一行。
 */
const GEN_SOURCE = `import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function saveBytes(bytes, type, req) {
  const ext = EXTENSIONS[type] || '.jpg'
  const dir = resolvePath(req.outDir || 'dsh-draw')
  const file = resolvePath(dir, 'img-' + req.seed + '-' + Date.now() + ext)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  return file
}

async function fromPollinations(req) {
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(req.prompt)
    + '?width=' + req.width + '&height=' + req.height + '&nologo=true&seed=' + req.seed + '&model=' + req.model
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (response.status !== 200) return { retry: true, error: 'HTTP ' + response.status }
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim()
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (type.indexOf('image/') !== 0 || bytes.length < 1000) {
    return { retry: true, error: '引擎返回了非图片内容（' + type + '，' + bytes.length + ' 字节）' }
  }
  return { ok: true, bytes: bytes, type: type }
}

async function fromRemote(req, sizeKey) {
  const endpoint = String(req.baseUrl || '').replace(/\\/+$/, '') + '/images/generations'
  const body = { model: req.model, prompt: req.prompt, batch_size: 1 }
  body[sizeKey] = req.width + 'x' + req.height
  if (sizeKey === 'size') body.n = 1
  if (req.negative) body.negative_prompt = req.negative
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + req.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  const text = await response.text()
  if (response.status === 400 || response.status === 422) {
    return { retry: true, error: 'HTTP ' + response.status + ' ' + text.slice(0, 200) }
  }
  if (response.status !== 200) {
    return { retry: false, error: 'HTTP ' + response.status + ' ' + text.slice(0, 300) }
  }
  let data = null
  try { data = JSON.parse(text) } catch (error) { return { retry: false, error: '返回不是 JSON：' + text.slice(0, 200) } }
  const first = data && data.data && data.data[0]
  if (!first) return { retry: false, error: '返回里没有图片字段：' + text.slice(0, 300) }
  if (first.b64_json) {
    return { ok: true, bytes: new Uint8Array(Buffer.from(first.b64_json, 'base64')), type: 'image/png' }
  }
  if (first.url) {
    const download = await fetch(first.url, { signal: AbortSignal.timeout(60000) })
    if (download.status !== 200) return { retry: false, error: '图片下载失败 HTTP ' + download.status }
    const type = String(download.headers.get('content-type') || '').split(';')[0].trim()
    const bytes = new Uint8Array(await download.arrayBuffer())
    return { ok: true, bytes: bytes, type: type.indexOf('image/') === 0 ? type : 'image/png' }
  }
  return { retry: false, error: '返回里既没有 url 也没有 b64_json' }
}

let result = { ok: false, error: '生成脚本没有执行' }
try {
  const raw = (await readStdin()).trim()
  if (!raw) throw new Error('stdin carried no request')
  const req = JSON.parse(raw)
  const started = Date.now()
  const sizeKeys = req.engine === 'pollinations' ? ['image_size'] : ['image_size', 'size']
  let attempts = 0
  let lastError = '没有发起请求'
  let success = null
  let fatal = false

  for (let round = 0; round < 4 && !success && !fatal; round += 1) {
    for (const sizeKey of sizeKeys) {
      if (success || fatal) break
      attempts += 1
      try {
        const outcome = req.engine === 'pollinations' ? await fromPollinations(req) : await fromRemote(req, sizeKey)
        if (outcome.ok) { success = outcome; break }
        lastError = outcome.error
        if (outcome.retry === false) fatal = true
      } catch (error) {
        lastError = String((error && error.message) || error)
      }
    }
    if (!success && !fatal) await sleep(4000 * (round + 1))
  }

  if (success) {
    const file = await saveBytes(success.bytes, success.type, req)
    result = { ok: true, path: file, type: success.type, bytes: success.bytes.length, ms: Date.now() - started, attempts: attempts }
  } else {
    result = { ok: false, error: lastError, attempts: attempts }
  }
} catch (error) {
  result = { ok: false, error: String((error && error.message) || error) }
}
console.log(JSON.stringify(result))
`

/** 含非 ASCII 字符（中文等）时为 true。 */
function hasWideChar(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return true
  }
  return false
}

/** 取整并夹到 [min, max]。 */
function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value))
  if (!isFinite(number)) return fallback
  if (number < min) return min
  if (number > max) return max
  return number
}

/** 去掉模型回复两端可能带的引号与换行。 */
function stripWrapping(value) {
  let out = String(value || '').split('\n').join(' ').trim()
  let guard = 0
  while (guard < 8 && out.length > 1) {
    const head = out.charAt(0)
    const tail = out.charAt(out.length - 1)
    if (head === '"' || head === "'" || head === '`') { out = out.slice(1).trim(); guard += 1; continue }
    if (tail === '"' || tail === "'" || tail === '`') { out = out.slice(0, -1).trim(); guard += 1; continue }
    break
  }
  return out
}

/** 读完整请求体（上限保护）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > MAX_REQUEST_BYTES) {
        reject(new Error('请求体过大'))
        try { req.destroy() } catch (error) { /* ignore */ }
      }
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

function sendJson(res, payload, status) {
  const body = JSON.stringify(payload)
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

export const name = 'dsh-draw'
export const inject = ['fs', 'shell', 'webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ outDir?: string }} [config] 来自 profile 的 cordis.patch.yml 行配置
 */
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const fs = ctx.fs
  const shell = ctx.shell
  const webServer = ctx.get('webServer')

  /** 生成结果的内存缓存：id → { bytes, type }。 */
  const images = new Map()
  let workspace = ''
  let scriptPath = ''
  /** 使用者写下的保存位置（原样保存，可能为空或相对路径）。 */
  let savedOutDir = ''
  let initError = ''
  let ready = null

  /** $DSH_HOME，没设就用 ~/.dsh。 */
  function dshHome() {
    const fromEnv = String(process.env.DSH_HOME || '').trim()
    return fromEnv || join(homedir(), '.dsh')
  }

  /**
   * 把使用者写的位置解析成绝对路径。
   * 留空 → $DSH_HOME/dsh-draw；相对路径 → 相对 $DSH_HOME；~ 开头 → 家目录。
   */
  function resolveOutDir(raw) {
    let value = String(raw || '').trim() || String(settings.outDir || '').trim()
    if (!value) return join(dshHome(), DEFAULT_OUT_DIR)
    if (value === '~') return dshHome()
    if (value.startsWith('~/') || value.startsWith('~\\')) value = join(dshHome(), value.slice(2))
    return isAbsolute(value) ? resolvePath(value) : resolvePath(join(dshHome(), value))
  }

  /** 读记住的设置（不存在就返回空对象）。 */
  async function readConfigFile() {
    try {
      const target = await fs.resolve(CONFIG_NAME, { cwd: dshHome() })
      const info = await fs.stat(target)
      if (!info) return {}
      const parsed = JSON.parse(await fs.readText(target))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      return {}
    }
  }

  /** 记住使用者的选择（尽力而为，失败不影响出图）。 */
  async function writeConfigFile(patch) {
    try {
      const home = dshHome()
      const target = await fs.resolve(CONFIG_NAME, { cwd: home })
      let current = {}
      try {
        const info = await fs.stat(target)
        if (info) current = JSON.parse(await fs.readText(target)) || {}
      } catch (error) { current = {} }
      const next = Object.assign({}, current, patch)
      await fs.writeText(target, JSON.stringify(next, null, 2) + '\n', undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: home,
      })
      return true
    } catch (error) {
      ctx.logger?.warn?.('[dsh-draw] 保存设置失败: ' + String((error && error.message) || error))
      return false
    }
  }

  async function writeInitLog(message) {
    try {
      const target = await fs.resolve(INIT_LOG_NAME, workspace ? { cwd: workspace } : undefined)
      await fs.writeText(
        target,
        message,
        undefined,
        undefined,
        workspace ? { mode: 'workspace-write', workspaceRoot: workspace } : undefined,
      )
    } catch (error) {
      ctx.logger?.warn?.('[dsh-draw] 写初始化日志失败: ' + String((error && error.message) || error))
    }
  }

  function init() {
    return (async () => {
      // 生成脚本固定放 $DSH_HOME：稳定、可预期，不会落到 DSH 进程的启动目录
      workspace = dshHome()

      const policy = { mode: 'workspace-write', workspaceRoot: workspace }
      const target = await fs.resolve(SCRIPT_NAME, { cwd: workspace })
      await fs.writeText(target, GEN_SOURCE, undefined, undefined, policy)
      scriptPath = String(fs.processPath(target) || '')
      if (!scriptPath) throw new Error('无法解析生成脚本的绝对路径')

      const saved = await readConfigFile()
      savedOutDir = typeof saved.outDir === 'string' ? saved.outDir : ''
      if (!savedOutDir) savedOutDir = String(settings.outDir || '').trim()
      return true
    })().catch(async (error) => {
      initError = String((error && error.message) || error)
      ctx.logger?.warn?.('[dsh-draw] 初始化失败: ' + initError)
      await writeInitLog('workspace=' + workspace + '\n' + initError)
      return false
    })
  }

  ready = init()

  /** 面板没填 Key 时，从工作区的 .dsh-draw-key.txt 读。 */
  async function readKeyFromFile() {
    try {
      const target = await fs.resolve(KEY_FILE_NAME, { cwd: workspace })
      const info = await fs.stat(target)
      if (!info) return ''
      return String(await fs.readText(target) || '').trim()
    } catch (error) {
      return ''
    }
  }

  /** 用宿主当前配置的聊天模型把中文提示词译成英文；失败返回 null。 */
  async function translate(text) {
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')
    if (llm === undefined || typeof llm.stream !== 'function' || selection === undefined) return null
    let current = null
    try { current = selection.currentSelection() } catch (error) { current = null }
    if (!current || !current.provider || !current.model) return null
    let out = ''
    try {
      const stream = llm.stream({
        provider: current.provider,
        model: current.model,
        maxTokens: 400,
        messages: [{
          id: 'dsh-draw-translate-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: TRANSLATE_RULE + text }],
          source: { kind: 'plugin', plugin: 'dsh-draw' },
        }],
      })
      for await (const chunk of stream) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return null
      }
    } catch (error) {
      ctx.logger?.warn?.('[dsh-draw] 翻译失败: ' + String((error && error.message) || error))
      return null
    }
    return stripWrapping(out) || null
  }

  /** 出图主流程。 */
  async function generate(input) {
    const text = String((input && input.text) || '').trim()
    if (!text) return { ok: false, error: '提示词是空的' }
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }

    const engine = input.engine === 'siliconflow' || input.engine === 'custom' ? input.engine : 'pollinations'
    const defaults = ENGINE_DEFAULTS[engine]

    let apiKey = String(input.apiKey || '').trim()
    if (!apiKey && engine !== 'pollinations') apiKey = await readKeyFromFile()
    if (engine !== 'pollinations' && !apiKey) {
      return { ok: false, error: '这个引擎需要 API Key：请在面板里填，或把 key 写进工作区的 ' + KEY_FILE_NAME }
    }

    const baseUrl = String(input.baseUrl || '').trim() || defaults.baseUrl
    if (engine === 'custom' && !baseUrl) return { ok: false, error: '自定义接口需要填接口地址（填到 /v1 为止）' }
    const model = String(input.model || '').trim() || defaults.model
    if (!model) return { ok: false, error: '这个引擎需要填模型名' }

    const subject = String(input.subject || '').trim()
    const rawPrompt = (subject ? subject + ', ' : '') + text
    let translated = rawPrompt
    let translateFailed = false
    const wantsTranslate = input.translate === true && hasWideChar(rawPrompt)
    if (wantsTranslate) {
      const english = await translate(rawPrompt)
      if (english) translated = english
      else translateFailed = true
    }

    const finalPrompt = String(input.prefix || '') + translated + String(input.background || '')

    // 保存位置：面板传了就用面板的，没传就用记住的/配置的
    const rawWanted = input.outDir === undefined ? savedOutDir : String(input.outDir || '')
    const targetDir = resolveOutDir(rawWanted)
    if (input.outDir !== undefined && String(input.outDir).trim() !== savedOutDir) {
      savedOutDir = String(input.outDir).trim()
      await writeConfigFile({ outDir: savedOutDir })
    }

    const width = clampInt(input.width, 320, 2048, 1024)
    const height = clampInt(input.height, 320, 2048, 1024)
    const seed = Math.floor(Math.random() * 1000000000)
    const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)

    const payload = JSON.stringify({
      engine: engine,
      baseUrl: baseUrl,
      apiKey: apiKey,
      model: model,
      prompt: finalPrompt,
      negative: String(input.negative || ''),
      width: width,
      height: height,
      seed: seed,
      outDir: targetDir,
    })

    try {
      const spec = shell.resolve({
        command: 'node "' + scriptPath + '"',
        workdir: workspace,
        timeoutMs: 300000,
        stdoutMaxBytes: 100000,
        stdin: payload,
        // 把使用者选的目录本身作为 workspace-write 边界，这样自定义位置也能落盘
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: dirname(targetDir) },
      })
      const run = await shell.run(spec)
      const textOut = String((run && run.stdout && run.stdout.text) || '').trim()
      const lines = textOut.split('\n').filter(Boolean)
      const line = lines.length ? lines[lines.length - 1] : ''
      let parsed = null
      try { parsed = JSON.parse(line) } catch (error) { parsed = null }

      if (!parsed || parsed.ok !== true) {
        const detail = (parsed && parsed.error) || line || '生成进程没有任何输出'
        const hint = engine === 'pollinations' && /HTTP (402|429|500|502|503)/.test(String(detail))
          ? '（免费引擎限流，已自动重试 4 次，过一会儿再点一次）'
          : ''
        return { ok: false, error: String(detail).slice(0, 300) + hint }
      }

      const target = await fs.resolve(String(parsed.path))
      const bytes = await fs.readBytes(target, undefined, MAX_IMAGE_BYTES)
      images.set(id, { bytes: bytes, type: String(parsed.type || 'image/jpeg') })
      while (images.size > 24) images.delete(images.keys().next().value)

      return {
        ok: true,
        url: IMG_PREFIX + id,
        path: String(parsed.path),
        bytes: bytes.length,
        ms: Number(parsed.ms) || 0,
        attempts: Number(parsed.attempts) || 1,
        translated: wantsTranslate ? translated : '',
        translateFailed: translateFailed,
        outDir: targetDir,
      }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error).slice(0, 400) }
    }
  }

  const disposers = []

  if (webServer && typeof webServer.register === 'function') {
    // 出图 API：POST /dsh-draw/api
    disposers.push(webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, { ok: false, error: '只接受 POST' }, 405)
          return
        }
        try {
          const body = await readBody(req)
          let input = {}
          try { input = body ? JSON.parse(body) : {} } catch (error) { input = {} }

          // 面板开局读一次当前设置
          if (input.action === 'config') {
            if (!(await ready)) {
              sendJson(res, { ok: false, error: '插件初始化失败：' + (initError || '未知原因') })
              return
            }
            sendJson(res, {
              ok: true,
              outDir: savedOutDir,
              resolvedOutDir: resolveOutDir(savedOutDir),
              defaultOutDir: join(dshHome(), DEFAULT_OUT_DIR),
              dshHome: dshHome(),
            })
            return
          }

          sendJson(res, await generate(input))
        } catch (error) {
          sendJson(res, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }))

    // 图片读取：GET /dsh-draw/img/<id>
    disposers.push(webServer.register({
      kind: 'prefix',
      path: IMG_PREFIX,
      handler: (req, res) => {
        const match = /\/([A-Za-z0-9-]+)\s*$/.exec(String((req && req.url) || ''))
        const stored = match ? images.get(match[1]) : undefined
        if (!stored) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('image not found')
          return
        }
        res.writeHead(200, {
          'Content-Type': stored.type,
          'Content-Length': String(stored.bytes.length),
          'Cache-Control': 'no-store',
        })
        res.end(stored.bytes)
      },
    }))
  } else {
    ctx.logger?.warn?.('[dsh-draw] 没有 webServer 服务，面板与 API 都不会工作')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch (error) { /* ignore */ }
      }
      images.clear()
    })
  }
}

export default { name, inject, apply }
