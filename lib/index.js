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
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

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
/** 一键安装器的脚本名（写到 $DSH_HOME 再执行）。 */
const SETUP_SCRIPT_NAME = '.dsh-draw-setup.mjs'
/** 轻量版（stable-diffusion.cpp）安装器的脚本名。 */
const SETUP_SDCPP_SCRIPT_NAME = '.dsh-draw-setup-sdcpp.mjs'
/** ComfyUI 默认安装目录名（位于 $DSH_HOME 下）。 */
const DEFAULT_COMFY_DIR = 'comfyui'

/** 安装器源码：跟宿主半边同目录，安装时写到磁盘再跑。 */
let SETUP_SOURCE = ''
let SETUP_SDCPP_SOURCE = ''
try {
  SETUP_SOURCE = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8')
  SETUP_SDCPP_SOURCE = readFileSync(new URL('./setup-sdcpp.mjs', import.meta.url), 'utf8')
} catch (error) {
  SETUP_SOURCE = SETUP_SOURCE || ''
  SETUP_SDCPP_SOURCE = SETUP_SDCPP_SOURCE || ''
}

const API_PATH = '/dsh-draw/api'
const IMG_PREFIX = '/dsh-draw/img/'
const MAX_IMAGE_BYTES = 20_000_000
const MAX_REQUEST_BYTES = 400_000

/** 每个引擎的默认端点与默认模型。 */
const ENGINE_DEFAULTS = {
  pollinations: { baseUrl: '', model: 'turbo' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' },
  custom: { baseUrl: '', model: '' },
  comfyui: { baseUrl: 'http://127.0.0.1:8188', model: '' },
  sdcpp: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'sd-cpp-local' },
}

/** 翻译指令：要求只回英文关键词，不要句子/引号/解释。 */
const TRANSLATE_RULE =
  'Turn the Chinese image request below into ONE English image-generation prompt. '
  + 'Reply with the English prompt only: comma-separated visual keywords, no sentences, no quotes, '
  + 'no explanation, no markdown. Keep every concrete detail (character, hair, clothing, colors, pose, '
  + 'action, scene, mood). Keep it under 60 words. '
  // 扩散模型不会写字：把"说×××"这种要求换成情绪标签，不然画面上会糊出一坨假字
  + 'If the request asks the character to SAY or write something, do NOT translate the spoken words '
  + 'and never ask for text/letters/speech bubbles in the image; express the same feeling with emotion '
  + 'tags instead (e.g. pout, angry, blush, tsundere).\n\n'

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

async function comfyBase(req) {
  return String(req.baseUrl || 'http://127.0.0.1:8188').replace(/\\/+$/, '')
}

/** 探活 + 列表：/object_info 里的模型、LoRA、采样器。 */
async function probeComfy(req) {
  const base = await comfyBase(req)
  const response = await fetch(base + '/object_info', { signal: AbortSignal.timeout(30000) })
  if (response.status !== 200) return { ok: false, error: 'ComfyUI /object_info HTTP ' + response.status + '（服务起来了吗？地址对吗？）' }
  let info = null
  try { info = await response.json() } catch (error) { return { ok: false, error: '/object_info 返回的不是 JSON' } }
  const pick = (nodeClass, field) => {
    const node = info && info[nodeClass]
    const spec = node && node.input && node.input.required && node.input.required[field]
    const list = spec && spec[0]
    return Array.isArray(list) ? list : []
  }
  return {
    ok: true,
    checkpoints: pick('CheckpointLoaderSimple', 'ckpt_name'),
    loras: pick('LoraLoader', 'lora_name'),
    samplers: pick('KSampler', 'sampler_name'),
  }
}

/** 生成一个标准 txt2img 工作流（可选挂一个 LoRA）。 */
function buildComfyWorkflow(req) {
  const steps = Math.max(1, Math.round(Number(req.steps) || 25))
  const cfg = Number(req.cfg) || 7
  const seed = Math.abs(Math.round(Number(req.seed) || 0))
  const workflow = {
    '3': { class_type: 'KSampler', inputs: { seed: seed, steps: steps, cfg: cfg, sampler_name: req.sampler || 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: req.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: req.width, height: req.height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: req.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: req.negative || '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-draw', images: ['8', 0] } },
  }
  const lora = String(req.lora || '').trim()
  if (lora) {
    const weight = Number(req.loraWeight)
    const strength = isFinite(weight) && weight > 0 ? weight : 0.8
    workflow['10'] = { class_type: 'LoraLoader', inputs: { lora_name: lora, strength_model: strength, strength_clip: strength, model: ['4', 0], clip: ['4', 1] } }
    workflow['3'].inputs.model = ['10', 0]
    workflow['6'].inputs.clip = ['10', 1]
    workflow['7'].inputs.clip = ['10', 1]
  }
  return workflow
}

/** 把提示词注入自定义工作流：先认占位符，再自动找正/负向文本节点。 */
function injectPrompt(workflow, prompt, negative) {
  const graph = JSON.parse(JSON.stringify(workflow))
  let placed = 0
  for (const id of Object.keys(graph)) {
    const inputs = graph[id] && graph[id].inputs
    if (!inputs) continue
    for (const key of Object.keys(inputs)) {
      const value = inputs[key]
      if (typeof value !== 'string') continue
      if (value.indexOf('{{prompt}}') >= 0 || value.indexOf('%prompt%') >= 0) {
        inputs[key] = value.split('{{prompt}}').join(prompt).split('%prompt%').join(prompt)
        placed += 1
      } else if (value.indexOf('{{negative}}') >= 0 || value.indexOf('%negative%') >= 0) {
        inputs[key] = value.split('{{negative}}').join(negative || '').split('%negative%').join(negative || '')
        placed += 1
      }
    }
  }
  if (placed > 0) return { graph: graph, how: '占位符' }
  const encodes = Object.keys(graph).filter((id) => graph[id] && graph[id].class_type === 'CLIPTextEncode')
  let positiveId = ''
  let negativeId = ''
  for (const id of Object.keys(graph)) {
    const node = graph[id]
    if (!node || !node.inputs) continue
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      const pos = node.inputs.positive
      const neg = node.inputs.negative
      if (Array.isArray(pos) && encodes.indexOf(String(pos[0])) >= 0) positiveId = String(pos[0])
      if (Array.isArray(neg) && encodes.indexOf(String(neg[0])) >= 0) negativeId = String(neg[0])
    }
  }
  if (!positiveId && encodes.length) positiveId = encodes[0]
  if (!negativeId) {
    for (const id of encodes) { if (id !== positiveId) { negativeId = id; break } }
  }
  if (positiveId) graph[positiveId].inputs.text = prompt
  if (negativeId) graph[negativeId].inputs.text = negative || ''
  return { graph: graph, how: positiveId ? ('自动识别正向节点 ' + positiveId) : '没找到文本节点' }
}

/** 走 ComfyUI：/prompt 排队 → 轮询 /history → /view 取图。 */
async function fromComfyUI(req) {
  const base = await comfyBase(req)
  let workflow = null
  let how = '自动生成的默认工作流'
  if (req.workflow) {
    let parsed = null
    try {
      parsed = typeof req.workflow === 'string' ? JSON.parse(req.workflow) : req.workflow
    } catch (error) {
      return { retry: false, error: '自定义工作流不是合法 JSON：' + String((error && error.message) || error) }
    }
    const injected = injectPrompt(parsed, req.prompt, req.negative || '')
    workflow = injected.graph
    how = '自定义工作流（' + injected.how + '）'
  } else {
    if (!req.checkpoint) return { retry: false, error: 'ComfyUI 模式需要选模型，或粘贴自定义工作流' }
    workflow = buildComfyWorkflow(req)
  }

  const queued = await fetch(base + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: req.clientId || 'dsh-draw' }),
    signal: AbortSignal.timeout(30000),
  })
  const queuedText = await queued.text()
  if (queued.status !== 200) return { retry: false, error: 'ComfyUI /prompt HTTP ' + queued.status + '：' + queuedText.slice(0, 300) }
  let job = null
  try { job = JSON.parse(queuedText) } catch (error) { job = null }
  const promptId = job && job.prompt_id
  if (!promptId) return { retry: false, error: 'ComfyUI 没返回 prompt_id：' + queuedText.slice(0, 200) }

  const deadline = Date.now() + (Number(req.timeoutMs) || 240000)
  while (Date.now() < deadline) {
    await sleep(1000)
    const history = await fetch(base + '/history/' + promptId, { signal: AbortSignal.timeout(20000) })
    if (history.status !== 200) continue
    let record = null
    try { record = (await history.json())[promptId] } catch (error) { record = null }
    if (!record) continue
    if (record.status && record.status.status_str === 'error') {
      return { retry: false, error: 'ComfyUI 执行出错：' + JSON.stringify(record.status.messages || []).slice(0, 300) }
    }
    const outputs = record.outputs || {}
    let image = null
    for (const nodeId of Object.keys(outputs)) {
      const list = outputs[nodeId] && outputs[nodeId].images
      if (Array.isArray(list) && list.length) { image = list[0]; break }
    }
    if (!image) continue
    const viewUrl = base + '/view?filename=' + encodeURIComponent(image.filename)
      + '&subfolder=' + encodeURIComponent(image.subfolder || '')
      + '&type=' + encodeURIComponent(image.type || 'output')
    const view = await fetch(viewUrl, { signal: AbortSignal.timeout(60000) })
    if (view.status !== 200) return { retry: false, error: 'ComfyUI 取图失败 HTTP ' + view.status }
    const type = String(view.headers.get('content-type') || '').split(';')[0].trim() || 'image/png'
    const bytes = new Uint8Array(await view.arrayBuffer())
    if (!bytes.length) return { retry: false, error: 'ComfyUI 返回的图片是空的' }
    return { ok: true, bytes: bytes, type: type.indexOf('image/') === 0 ? type : 'image/png', note: how, promptId: promptId }
  }
  return { retry: false, error: 'ComfyUI 超时（' + Math.round((Number(req.timeoutMs) || 240000) / 1000) + ' 秒内没出图；任务可能还在队列里，去 ComfyUI 界面看看）' }
}

/** ComfyUI 的完整一轮：出图 + 落盘。 */
async function comfyRun(req, started) {
  const outcome = await fromComfyUI(req)
  if (!outcome.ok) return { ok: false, error: outcome.error, attempts: 1 }
  const file = await saveBytes(outcome.bytes, outcome.type, req)
  return { ok: true, path: file, type: outcome.type, bytes: outcome.bytes.length, ms: Date.now() - started, attempts: 1, note: outcome.note }
}

/** stable-diffusion.cpp 的 sd-server：走它的 A1111 兼容接口（负面词/步数/CFG 都支持）。 */
async function fromSdCpp(req) {
  const base = String(req.baseUrl || 'http://127.0.0.1:1234').replace(/\\/+$/, '').replace(/\\/v1$/, '')
  const body = {
    prompt: req.prompt,
    negative_prompt: req.negative || '',
    width: req.width,
    height: req.height,
    steps: Math.max(1, Math.round(Number(req.steps) || 20)),
    cfg_scale: Number(req.cfg) || 7,
    seed: Math.abs(Math.round(Number(req.seed) || 0)),
    sampler_name: req.sampler || 'euler_a',
  }
  const response = await fetch(base + '/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  })
  const text = await response.text()
  if (response.status !== 200) return { retry: false, error: 'SD.cpp HTTP ' + response.status + ' ' + text.slice(0, 200) }
  let data = null
  try { data = JSON.parse(text) } catch (error) { return { retry: false, error: 'SD.cpp 返回不是 JSON：' + text.slice(0, 200) } }
  const first = data && data.images && data.images[0]
  if (!first) return { retry: false, error: 'SD.cpp 返回里没有图片：' + text.slice(0, 200) }
  return { ok: true, bytes: new Uint8Array(Buffer.from(first, 'base64')), type: 'image/png', note: 'sd-server /sdapi/v1/txt2img' }
}

/** SD.cpp 的完整一轮：出图 + 落盘。 */
async function sdcppRun(req, started) {
  const outcome = await fromSdCpp(req)
  if (!outcome.ok) return { ok: false, error: outcome.error, attempts: 1 }
  const file = await saveBytes(outcome.bytes, outcome.type, req)
  return { ok: true, path: file, type: outcome.type, bytes: outcome.bytes.length, ms: Date.now() - started, attempts: 1, note: outcome.note }
}

let result = { ok: false, error: '生成脚本没有执行' }
try {
  const raw = (await readStdin()).trim()
  if (!raw) throw new Error('stdin carried no request')
  const req = JSON.parse(raw)
  const started = Date.now()
  if (req.mode === 'ping') {
    const base = await comfyBase(req)
    if (req.engine === 'sdcpp') {
      // sd-server：用 A1111 的 options 接口探活，顺便把当前底模名字带回来
      const root = base.replace(/\\/v1$/, '')
      try {
        const res = await fetch(root + '/sdapi/v1/options', { signal: AbortSignal.timeout(Number(req.timeoutMs) || 3000) })
        if (res.status !== 200) {
          result = { ok: false, error: 'HTTP ' + res.status }
        } else {
          const options = await res.json()
          result = { ok: true, running: true, version: 'stable-diffusion.cpp', gpu: '', model: String(options.sd_model_checkpoint || '') }
        }
      } catch (error) {
        result = { ok: false, error: String((error && error.message) || error) }
      }
    } else {
      try {
        const res = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(Number(req.timeoutMs) || 3000) })
        if (res.status !== 200) {
          result = { ok: false, error: 'HTTP ' + res.status }
        } else {
          const stats = await res.json()
          const device = stats.devices && stats.devices[0]
          result = {
            ok: true,
            running: true,
            version: (stats.system && stats.system.comfyui_version) || '',
            gpu: device ? String(device.name || '') : '',
            vram: device && device.vram_total ? Math.round(device.vram_total / 1073741824) : 0,
          }
        }
      } catch (error) {
        result = { ok: false, error: String((error && error.message) || error) }
      }
    }
  } else if (req.mode === 'probe') {
    result = await probeComfy(req)
  } else if (req.engine === 'sdcpp') {
    result = await sdcppRun(req, started)
  } else if (req.engine === 'comfyui') {
    result = await comfyRun(req, started)
  } else {
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
  /** 使用者写下的本机引擎目录（同样记在配置文件里，重启后仍生效）。 */
  let savedComfyDir = ''
  let savedSdcppDir = ''
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
      savedComfyDir = typeof saved.comfyDir === 'string' ? saved.comfyDir : ''
      if (!savedComfyDir) savedComfyDir = String(settings.comfyDir || '').trim()
      savedSdcppDir = typeof saved.sdcppDir === 'string' ? saved.sdcppDir : ''
      if (!savedSdcppDir) savedSdcppDir = String(settings.sdcppDir || '').trim()
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

  /**
   * 用宿主当前配置的聊天模型把中文提示词译成英文。
   * 返回 { text } 或 { error }——把失败原因带回面板，别让人对着"翻译失败"猜。
   *
   * 坑（实测 deepseek-flash）：这类模型默认 reasoningEffort=high，思考会吃满 maxTokens，
   * 结果一个 text-delta 都没有、finish 是 max-tokens —— 译文是空的，中文原样进了画图模型。
   * 所以这里显式关掉思考（off），并把上限放大；不支持该参数就退回默认再试一次。
   */
  async function translate(text) {
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')
    if (llm === undefined || typeof llm.stream !== 'function') return { error: '宿主没有 llm 服务，无法翻译' }
    if (selection === undefined) return { error: '宿主没有 agentDefaultModel，拿不到当前模型' }
    let current = null
    try { current = selection.currentSelection() } catch (error) { current = null }
    if (!current || !current.provider || !current.model) return { error: '拿不到当前会话模型' }

    const ask = async (effort) => {
      const options = {
        provider: current.provider,
        model: current.model,
        maxTokens: 1000,
        messages: [{
          id: 'dsh-draw-translate-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: TRANSLATE_RULE + text }],
          source: { kind: 'plugin', plugin: 'dsh-draw' },
        }],
      }
      if (effort) options.reasoningEffort = effort
      let out = ''
      let finish = null
      const stream = llm.stream(options)
      for await (const chunk of stream) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += String(chunk.text || '')
        if (chunk.type === 'finish') finish = chunk.reason || null
      }
      return { out: out, finish: finish }
    }

    let result = null
    try {
      result = await ask('off')
    } catch (error) {
      // 有的模型/适配器不认 reasoningEffort 'off'：退回不指定再试一次
      try {
        result = await ask('')
      } catch (error2) {
        const message = String((error2 && error2.message) || error2)
        ctx.logger?.warn?.('[dsh-draw] 翻译失败: ' + message)
        return { error: message }
      }
    }
    if (result.finish && result.finish.kind === 'error') {
      return { error: String((result.finish.failure && result.finish.failure.message) || '模型返回错误') }
    }
    const cleaned = stripWrapping(result.out)
    if (cleaned) return { text: cleaned }
    if (result.finish && result.finish.kind === 'max-tokens') {
      return { error: '模型的思考把输出上限吃光了（没吐出译文）' }
    }
    return { error: '模型没有返回译文' }
  }

  /** 出图主流程。 */
  async function generate(input) {
    const text = String((input && input.text) || '').trim()
    if (!text) return { ok: false, error: '提示词是空的' }
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }

    const engine = input.engine === 'siliconflow' || input.engine === 'custom' || input.engine === 'comfyui' || input.engine === 'sdcpp'
      ? input.engine
      : 'pollinations'
    const defaults = ENGINE_DEFAULTS[engine]
    const isComfy = engine === 'comfyui'
    const isSdcpp = engine === 'sdcpp'
    const isLocal = isComfy || isSdcpp

    let apiKey = String(input.apiKey || '').trim()
    if (!apiKey && engine !== 'pollinations' && !isLocal) apiKey = await readKeyFromFile()
    if (engine !== 'pollinations' && !isLocal && !apiKey) {
      return { ok: false, error: '这个引擎需要 API Key：请在面板里填，或把 key 写进工作区的 ' + KEY_FILE_NAME }
    }

    const baseUrl = String(input.baseUrl || '').trim() || defaults.baseUrl
    if (engine === 'custom' && !baseUrl) return { ok: false, error: '自定义接口需要填接口地址（填到 /v1 为止）' }
    if (isComfy && !baseUrl) return { ok: false, error: 'ComfyUI 模式需要填服务地址（默认 http://127.0.0.1:8188）' }
    if (isSdcpp && !baseUrl) return { ok: false, error: 'SD.cpp 模式需要填服务地址（默认 http://127.0.0.1:1234/v1）' }
    const model = String(input.model || '').trim() || defaults.model
    const workflow = String(input.workflow || '').trim()
    if (isComfy) {
      if (!workflow && !String(input.checkpoint || '').trim()) {
        return { ok: false, error: 'ComfyUI 模式：请先拉取并选一个模型，或在高级设置里粘贴自定义工作流' }
      }
    } else if (!isSdcpp && !model) {
      return { ok: false, error: '这个引擎需要填模型名' }
    }

    const subject = String(input.subject || '').trim()
    const rawPrompt = (subject ? subject + ', ' : '') + text
    let translated = rawPrompt
    let translateFailed = false
    const wantsTranslate = input.translate === true && hasWideChar(rawPrompt)
    let translateError = ''
    if (wantsTranslate) {
      const english = await translate(rawPrompt)
      if (english && english.text) translated = english.text
      else {
        translateFailed = true
        translateError = String((english && english.error) || '未知原因')
      }
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
      checkpoint: String(input.checkpoint || ''),
      lora: String(input.lora || ''),
      loraWeight: Number(input.loraWeight) || 0.8,
      steps: Number(input.steps) || 25,
      cfg: Number(input.cfg) || 7,
      sampler: String(input.sampler || ''),
      workflow: workflow,
      clientId: 'dsh-draw-' + id,
      timeoutMs: isComfy ? 240000 : undefined,
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
      const run = await runSpec(spec)
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
        translateError: translateError,
        outDir: targetDir,
        note: String(parsed.note || ''),
      }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error).slice(0, 400) }
    }
  }

  /** 探活 ComfyUI：拿模型 / LoRA / 采样器列表。 */
  async function probeComfyModels(baseUrl) {
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }
    const payload = JSON.stringify({
      mode: 'probe',
      engine: 'comfyui',
      baseUrl: String(baseUrl || '').trim() || ENGINE_DEFAULTS.comfyui.baseUrl,
    })
    try {
      const spec = shell.resolve({
        command: 'node "' + scriptPath + '"',
        workdir: workspace,
        timeoutMs: 60000,
        stdoutMaxBytes: 200000,
        stdin: payload,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
      })
      const run = await runSpec(spec)
      const textOut = String((run && run.stdout && run.stdout.text) || '').trim()
      const lines = textOut.split('\n').filter(Boolean)
      const line = lines.length ? lines[lines.length - 1] : ''
      let parsed = null
      try { parsed = JSON.parse(line) } catch (error) { parsed = null }
      if (!parsed || parsed.ok !== true) {
        return { ok: false, error: (parsed && parsed.error) || line || '探活失败（脚本没有输出）' }
      }
      return parsed
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error).slice(0, 400) }
    }
  }

  // ── ComfyUI 环境：检测 / 一键安装 / 启动 ─────────────────────────────
  /** 解析 ComfyUI 安装目录：面板 > 行配置 > $DSH_HOME/comfyui。 */
  function comfyRoot(input) {
    const fromInput = String((input && input.comfyDir) || '').trim()
    if (fromInput) return isAbsolute(fromInput) ? resolvePath(fromInput) : resolvePath(join(dshHome(), fromInput))
    const configured = (savedComfyDir || String(settings.comfyDir || '')).trim()
    if (configured) return isAbsolute(configured) ? resolvePath(configured) : resolvePath(join(dshHome(), configured))
    return join(dshHome(), DEFAULT_COMFY_DIR)
  }

  /**
   * 面板发来的本机引擎目录变了就记下来。
   * 不记的话，DSH 每重启一次面板里的「目录」就空一次，用户得重填。
   */
  async function rememberLocalDir(input) {
    const comfy = String((input && input.comfyDir) || '').trim()
    const sdcpp = String((input && input.sdcppDir) || '').trim()
    const patch = {}
    if (comfy && comfy !== savedComfyDir) { savedComfyDir = comfy; patch.comfyDir = comfy }
    if (sdcpp && sdcpp !== savedSdcppDir) { savedSdcppDir = sdcpp; patch.sdcppDir = sdcpp }
    if (Object.keys(patch).length) await writeConfigFile(patch)
  }

  async function pathExists(path) {
    try {
      return (await fs.stat(await fs.resolve(path))) !== undefined
    } catch (error) {
      return false
    }
  }

  /** 列出已装底模。 */
  async function listCheckpoints(root) {
    try {
      const entries = await fs.listDir(await fs.resolve(join(root, 'ComfyUI', 'models', 'checkpoints')))
      return entries.filter((e) => e.type === 'file' && e.name.endsWith('.safetensors')).map((e) => e.name)
    } catch (error) {
      return []
    }
  }

  /**
   * 宿主 shell 服务的执行方法在不同 DSH 版本里可能不一样：
   * 有的是 run（前台跑完返回结果），有的只给了 start（后台进程句柄）。
   * 优先 run；没有 run 就退回 start + 等 done + 读输出。
   */
  async function runSpec(spec) {
    if (shell && typeof shell.run === 'function') return await shell.run(spec)
    if (shell && typeof shell.start === 'function') {
      const proc = shell.start(spec)
      await proc.done
      const read = typeof proc.readOutput === 'function' ? (proc.readOutput() || {}) : {}
      return {
        exitCode: proc.exitCode === undefined ? null : proc.exitCode,
        signal: proc.signal || null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: String(read.delta || ''), truncated: read.lossy === true },
        stderr: { text: '', truncated: read.lossy === true },
      }
    }
    throw new Error(describeShellService())
  }

  /** 两种方法都没有时，把宿主 shell 服务真实提供的方法名列出来，方便排查。 */
  function describeShellService() {
    const names = []
    try {
      const seen = {}
      let object = shell
      while (object && object !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(object)) {
          if (key === 'constructor' || seen[key]) continue
          seen[key] = true
          if (typeof shell[key] === 'function') names.push(key)
        }
        object = Object.getPrototypeOf(object)
      }
    } catch (error) { /* 拿不到就算了，下面照样给一句人话 */ }
    return '宿主的 shell 服务既没有 run 也没有 start（它实际提供：' + (names.join(', ') || '（一个方法都没读到）')
      + '）—— 说明这个 DSH 版本和插件对不上，把这句话发给插件作者'
  }

  /** 跑一次生成脚本并解析它最后一行 JSON。 */
  async function execGenerator(payload, timeoutMs) {
    const spec = shell.resolve({
      command: 'node "' + scriptPath + '"',
      workdir: workspace,
      timeoutMs: timeoutMs || 60000,
      stdoutMaxBytes: 200000,
      stdin: JSON.stringify(payload),
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
    })
    const run = await runSpec(spec)
    const text = String((run && run.stdout && run.stdout.text) || '').trim()
    const lines = text.split('\n').filter(Boolean)
    const line = lines.length ? lines[lines.length - 1] : ''
    try { return JSON.parse(line) } catch (error) { return null }
  }

  /**
   * 认一认这个目录里是哪种 ComfyUI：
   *   自装版 / 插件装的：python\python.exe + ComfyUI\main.py
   *   官方便携包：      python_embeded\python.exe + ComfyUI\main.py
   *   有人直接指到内层：..\python_embeded\python.exe + main.py
   * 找不到就返回 null。
   */
  async function findComfyInstall(root) {
    const variants = [
      { python: join(root, 'python', 'python.exe'), main: join(root, 'ComfyUI', 'main.py'), workdir: join(root, 'ComfyUI') },
      { python: join(root, 'python_embeded', 'python.exe'), main: join(root, 'ComfyUI', 'main.py'), workdir: join(root, 'ComfyUI') },
      { python: join(root, '..', 'python_embeded', 'python.exe'), main: join(root, 'main.py'), workdir: root },
      { python: join(root, 'python', 'python.exe'), main: join(root, 'main.py'), workdir: root },
      { python: join(root, '..', '..', 'python_embeded', 'python.exe'), main: join(root, 'main.py'), workdir: root },
    ]
    for (const variant of variants) {
      if (await pathExists(variant.python) && await pathExists(variant.main)) return variant
    }
    return null
  }

  /** 目录像是「ComfyUI Desktop / 整合包」而不是便携版时，给一句对症的话。 */
  function comfyLayoutHint(root) {
    if (/Comfy\s*Desktop|ComfyUI_windows_portable/i.test(String(root))) {
      if (/Comfy\s*Desktop/i.test(String(root))) {
        return '。你填的像是 ComfyUI Desktop（桌面包）的目录——桌面包没有 python\\python.exe 这种便携版结构，'
          + '不用在这里填：直接打开 ComfyUI Desktop 应用（它自己就监听 8188），然后回面板点「读取模型 / LoRA」即可'
      }
      return '。便携包请填到最外层那个文件夹（里面有 python_embeded\\ 和 ComfyUI\\）'
    }
    return '。便携版目录里应该有 python\\python.exe（或 python_embeded\\python.exe）和 ComfyUI\\main.py；'
      + '如果你用的是 ComfyUI Desktop 桌面包，直接打开那个应用即可，不用在这里填目录'
  }

  async function comfyStatus(input) {
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }
    const root = comfyRoot(input)
    const baseUrl = String((input && input.baseUrl) || '').trim() || ENGINE_DEFAULTS.comfyui.baseUrl
    const found = await findComfyInstall(root)
    const hasPython = found !== null
    const hasComfy = found !== null
    const models = hasComfy ? await listCheckpoints(root) : []
    let setup = null
    try {
      const target = await fs.resolve(join(root, '.dsh-setup-status.json'))
      if (await fs.stat(target)) setup = JSON.parse(await fs.readText(target))
    } catch (error) { setup = null }
    const ping = await execGenerator({ mode: 'ping', engine: 'comfyui', baseUrl, timeoutMs: 3000 }, 20000)

    // 顺便找找别处有没有现成的安装，方便用户一键指回来
    const candidates = []
    for (const candidate of [join(dshHome(), DEFAULT_COMFY_DIR), join(dshHome(), 'ComfyUI'), 'D:/AI/ComfyUI', 'C:/ComfyUI']) {
      if (candidate === root || candidates.indexOf(candidate) >= 0) continue
      const nested = await pathExists(join(candidate, 'ComfyUI', 'main.py'))
      const flat = await pathExists(join(candidate, 'main.py'))
      if (nested || flat) candidates.push(candidate)
    }

    return {
      ok: true,
      root,
      baseUrl,
      installed: { python: hasPython, comfy: hasComfy, models },
      running: !!(ping && ping.ok === true),
      gpu: (ping && ping.gpu) || '',
      version: (ping && ping.version) || '',
      setup,
      candidates,
      installerReady: SETUP_SOURCE.length > 0,
    }
  }

  async function comfySetup(input) {
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }
    if (!SETUP_SOURCE) return { ok: false, error: '插件包里找不到 setup.mjs（安装不完整？）' }
    const root = comfyRoot(input)
    const target = await fs.resolve(SETUP_SCRIPT_NAME, { cwd: dshHome() })
    const policy = { mode: 'workspace-write', workspaceRoot: dshHome() }
    await fs.writeText(target, SETUP_SOURCE, undefined, undefined, policy)
    const scriptAbs = String(fs.processPath(target) || '')
    if (!scriptAbs) return { ok: false, error: '无法解析安装脚本路径' }
    const spec = shell.resolve({
      command: 'node "' + scriptAbs + '"',
      workdir: dshHome(),
      timeoutMs: 3600000,
      stdoutMaxBytes: 200000,
      stdin: JSON.stringify({ root, withModel: input.withModel !== false }),
      sandboxPolicy: policy,
    })
    try {
      shell.start(spec)
    } catch (error) {
      return { ok: false, error: '启动安装进程失败：' + String((error && error.message) || error) }
    }
    return { ok: true, started: true, root, statusFile: join(root, '.dsh-setup-status.json'), log: join(root, '.dsh-setup.log') }
  }

  /**
   * shell.start 不抛异常 ≠ 真的起来了：沙箱拒绝、命令写错、缺依赖都会让它立刻死掉。
   * 等一小会儿看句柄状态，死了就把原因带回去，别让面板显示"已启动"骗人。
   * 返回 null 表示还活着（正常）。
   */
  async function startedProcessProblem(proc, waitMs) {
    if (!proc || typeof proc !== 'object') return null
    await new Promise((done) => setTimeout(done, waitMs || 1500))
    if (proc.status === 'running') return null
    let detail = ''
    try {
      const read = typeof proc.readOutput === 'function' ? (proc.readOutput() || {}) : {}
      detail = String(read.delta || '').trim().split('\n').filter(Boolean).slice(-4).join(' / ')
    } catch (error) { detail = '' }
    const sandbox = (proc && proc.sandbox) || {}
    const why = sandbox.runnerFailed ? '被沙箱的隔离器挡下了（runnerFailed）'
      : sandbox.denied ? '被沙箱拒绝（denied）'
        : '进程很快就退出了（exitCode=' + String(proc.exitCode) + '，status=' + String(proc.status) + '）'
    return '启动后没能留住：' + why + (detail ? '；它的输出：' + detail : '')
  }

  async function comfyLaunch(input) {
    const root = comfyRoot(input)
    const found = await findComfyInstall(root)
    if (!found) {
      return { ok: false, error: '这个目录里没有装好的 ComfyUI：' + root + comfyLayoutHint(root) }
    }
    const python = found.python
    const main = found.main
    // 顺手放一个双击就能开的启动脚本（便携包用 python_embeded，自装版用 python）
    try {
      const portable = /python_embeded/i.test(python)
      const pythonRel = portable ? 'python_embeded\\python.exe' : 'python\\python.exe'
      const mainRel = main.slice(root.length + 1)
      const bat = join(root, '启动ComfyUI.bat')
      const content = '@echo off\r\nchcp 65001 >nul\r\ntitle ComfyUI\r\n'
        + 'cd /d "%~dp0' + dirname(mainRel) + '"\r\n'
        + 'echo ComfyUI 启动中，稍后浏览器打开 http://127.0.0.1:8188\r\n\r\n'
        + '"%~dp0' + pythonRel + '" ' + basename(mainRel) + ' --listen 127.0.0.1 --port 8188\r\npause\r\n'
      await fs.writeText(await fs.resolve(bat), content, undefined, undefined, { mode: 'workspace-write', workspaceRoot: root })
    } catch (error) { /* 只是便利脚本，失败不影响启动 */ }

    const spec = shell.resolve({
      command: '"' + python + '" "' + main + '" --listen 127.0.0.1 --port 8188',
      workdir: found.workdir,
      timeoutMs: 3600000,
      stdoutMaxBytes: 200000,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root },
    })
    let proc = null
    try {
      proc = shell.start(spec)
    } catch (error) {
      return { ok: false, error: '启动失败：' + String((error && error.message) || error) }
    }
    const problem = await startedProcessProblem(proc, 2000)
    if (problem) return { ok: false, error: problem }
    return { ok: true, started: true, root, url: 'http://127.0.0.1:8188' }
  }

  // ── 轻量引擎（stable-diffusion.cpp）：检测 / 一键安装 / 启动 ──────────
  function sdcppRoot(input) {
    const fromInput = String((input && input.sdcppDir) || '').trim()
    if (fromInput) return isAbsolute(fromInput) ? resolvePath(fromInput) : resolvePath(join(dshHome(), fromInput))
    const configured = (savedSdcppDir || String(settings.sdcppDir || '')).trim()
    if (configured) return isAbsolute(configured) ? resolvePath(configured) : resolvePath(join(dshHome(), configured))
    return join(dshHome(), 'sdcpp')
  }

  async function listModelFiles(dir) {
    try {
      const entries = await fs.listDir(await fs.resolve(dir))
      return entries.filter((e) => e.type === 'file' && /\.(safetensors|gguf)$/.test(e.name)).map((e) => e.name)
    } catch (error) {
      return []
    }
  }

  async function sdcppStatus(input) {
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }
    const root = sdcppRoot(input)
    const baseUrl = String((input && input.baseUrl) || '').trim() || ENGINE_DEFAULTS.sdcpp.baseUrl
    const binary = await pathExists(join(root, 'sd-server.exe'))
    const models = await listModelFiles(join(root, 'models'))
    let setup = null
    try {
      const target = await fs.resolve(join(root, '.dsh-setup-status.json'))
      if (await fs.stat(target)) setup = JSON.parse(await fs.readText(target))
    } catch (error) { setup = null }
    const ping = await execGenerator({ mode: 'ping', engine: 'sdcpp', baseUrl, timeoutMs: 3000 }, 20000)
    return {
      ok: true,
      root,
      baseUrl,
      installed: { binary, models },
      running: !!(ping && ping.ok === true),
      model: (ping && ping.model) || '',
      version: (ping && ping.version) || '',
      setup,
      installerReady: SETUP_SDCPP_SOURCE.length > 0,
    }
  }

  async function sdcppSetup(input) {
    if (!(await ready)) return { ok: false, error: '插件初始化失败：' + (initError || '未知原因') }
    if (!SETUP_SDCPP_SOURCE) return { ok: false, error: '插件包里找不到 setup-sdcpp.mjs（安装不完整？）' }
    const root = sdcppRoot(input)
    const target = await fs.resolve(SETUP_SDCPP_SCRIPT_NAME, { cwd: dshHome() })
    const policy = { mode: 'workspace-write', workspaceRoot: dshHome() }
    await fs.writeText(target, SETUP_SDCPP_SOURCE, undefined, undefined, policy)
    const scriptAbs = String(fs.processPath(target) || '')
    if (!scriptAbs) return { ok: false, error: '无法解析安装脚本路径' }
    const spec = shell.resolve({
      command: 'node "' + scriptAbs + '"',
      workdir: dshHome(),
      timeoutMs: 3600000,
      stdoutMaxBytes: 200000,
      stdin: JSON.stringify({ root }),
      sandboxPolicy: policy,
    })
    try {
      shell.start(spec)
    } catch (error) {
      return { ok: false, error: '启动安装进程失败：' + String((error && error.message) || error) }
    }
    return { ok: true, started: true, root, statusFile: join(root, '.dsh-setup-status.json'), log: join(root, '.dsh-setup.log') }
  }

  async function sdcppLaunch(input) {
    const root = sdcppRoot(input)
    const binary = join(root, 'sd-server.exe')
    if (!(await pathExists(binary))) return { ok: false, error: '这个目录里没有装好的 SD.cpp 引擎：' + root }
    let args = ''
    try {
      const target = await fs.resolve(join(root, 'sd-args.txt'))
      if (await fs.stat(target)) args = String(await fs.readText(target)).trim()
    } catch (error) { args = '' }
    if (!args) {
      const models = await listModelFiles(join(root, 'models'))
      if (!models.length) return { ok: false, error: '没找到底模（应放在 ' + join(root, 'models') + '）' }
      args = '-m "' + join(root, 'models', models[0]) + '" --listen-ip 127.0.0.1 --listen-port 1234 --vae-tiling --diffusion-fa'
    }
    const spec = shell.resolve({
      command: '"' + binary + '" ' + args,
      workdir: root,
      timeoutMs: 3600000,
      stdoutMaxBytes: 200000,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root },
    })
    let proc = null
    try {
      proc = shell.start(spec)
    } catch (error) {
      return { ok: false, error: '启动失败：' + String((error && error.message) || error) }
    }
    const problem = await startedProcessProblem(proc, 2000)
    if (problem) return { ok: false, error: problem }
    return { ok: true, started: true, root, url: ENGINE_DEFAULTS.sdcpp.baseUrl }
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

          // 兼容老面板：早期版本把动作名写成 comfyui-status，这里统一折成 comfy-status
          if (typeof input.action === 'string' && input.action.indexOf('comfyui-') === 0) {
            input.action = 'comfy-' + input.action.slice('comfyui-'.length)
          }

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
              comfyDir: savedComfyDir,
              sdcppDir: savedSdcppDir,
              defaultEngine: String(settings.defaultEngine || '').trim(),
            })
            return
          }

          // 拉取 ComfyUI 的模型 / LoRA 列表
          if (input.action === 'comfy-models') {
            await rememberLocalDir(input)
            sendJson(res, await probeComfyModels(input.baseUrl))
            return
          }

          // ComfyUI 环境：检测 / 一键安装 / 启动
          if (input.action === 'comfy-status') {
            await rememberLocalDir(input)
            sendJson(res, await comfyStatus(input))
            return
          }
          if (input.action === 'comfy-setup') {
            await rememberLocalDir(input)
            sendJson(res, await comfySetup(input))
            return
          }
          if (input.action === 'comfy-launch') {
            await rememberLocalDir(input)
            sendJson(res, await comfyLaunch(input))
            return
          }

          // 轻量引擎（stable-diffusion.cpp）
          if (input.action === 'sdcpp-status') {
            await rememberLocalDir(input)
            sendJson(res, await sdcppStatus(input))
            return
          }
          if (input.action === 'sdcpp-setup') {
            await rememberLocalDir(input)
            sendJson(res, await sdcppSetup(input))
            return
          }
          if (input.action === 'sdcpp-launch') {
            await rememberLocalDir(input)
            sendJson(res, await sdcppLaunch(input))
            return
          }

          // 带了 action 却不是上面任何一个 → 多半是面板比宿主新（宿主半边要重启才更新）
          if (input.action) {
            sendJson(res, {
              ok: false,
              error: '宿主不认识动作「' + String(input.action) + '」——面板可能比宿主新，重启一次 DSH 就好',
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
