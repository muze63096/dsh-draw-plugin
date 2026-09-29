/**
 * dsh-draw — 轻量版安装器（stable-diffusion.cpp）
 *
 * 比 ComfyUI 版简单得多：本体只有一个 29MB 的压缩包（Vulkan 后端，N/A/核显都能用），
 * 外加一个 2GB 底模。sd-server.exe 自带 OpenAI 兼容接口，插件直接当普通接口用。
 *
 * 用法：node setup-sdcpp.mjs --root=<目录> [--plan] [--only=binary,model]
 *   或从 stdin 读 JSON：{"root":"...","plan":false,"only":["binary"]}
 *
 * 步骤：
 *   binary  下载并解压 stable-diffusion.cpp（Vulkan 版）
 *   model   下载默认二次元底模
 *   launcher 按显存写一个启动脚本
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, closeSync, readSync, writeSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** stable-diffusion.cpp 的 Windows Vulkan 预编译包（29MB；N 卡/A 卡/核显通用）。 */
const SDCPP_URL = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/sd-master-3f8527a-bin-win-vulkan-x64.zip'
/** 默认底模（与完整版同一份，ModelScope，国内可高速下载）。 */
const MODEL = {
  url: 'https://www.modelscope.cn/models/VoidOc/ckpt_sd1.5_anime/resolve/master/%E5%8A%A8%E6%BC%AB%E4%BA%8C%E6%AC%A1%E5%85%832.5D_dxMix.safetensors',
  saveAs: 'anime-2.5D-dxMix.safetensors',
  label: '动漫二次元 2.5D dxMix（SD1.5，约 2GB）',
}
const PORT = 1234
const CONNECTIONS = 16
const STEP_ORDER = ['binary', 'model', 'launcher']
const STEP_TITLES = {
  binary: '下载 stable-diffusion.cpp（约 29MB）',
  model: '下载默认底模（约 2GB）',
  launcher: '生成启动脚本',
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const argv = process.argv.slice(2)
const fromArgs = {}
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a)
  if (m) fromArgs[m[1]] = m[2]
  else if (a.startsWith('--')) fromArgs[a.slice(2)] = true
}
let input = {}
if (!fromArgs.root) {
  try {
    const raw = (await readStdin()).trim()
    if (raw) input = JSON.parse(raw)
  } catch (error) { /* 无 stdin 就用参数 */ }
}
const root = String(fromArgs.root || input.root || '').trim()
const planOnly = fromArgs.plan === true || input.plan === true
const only = String(fromArgs.only || '').split(',').map((s) => s.trim()).filter(Boolean)
if (!root) {
  console.log(JSON.stringify({ ok: false, error: '缺少 --root=<安装目录>' }))
  process.exit(1)
}

const BIN = join(root, 'sd-server.exe')
const MODELS = join(root, 'models')
const LORAS = join(root, 'loras')
const TMP = join(root, '.tmp')
const DL = join(root, '.downloads')
const LOG = join(root, '.dsh-setup.log')
const STATUS = join(root, '.dsh-setup-status.json')
for (const d of [root, MODELS, LORAS, TMP, DL]) mkdirSync(d, { recursive: true })

let status = { phase: 'idle', step: null, stepIndex: 0, stepCount: STEP_ORDER.length, percent: 0, message: '', error: null, startedAt: Date.now(), updatedAt: Date.now(), root, engine: 'sdcpp' }
function flushStatus() {
  status.updatedAt = Date.now()
  try { writeFileSync(STATUS, JSON.stringify(status, null, 2), 'utf8') } catch (error) { /* 忽略 */ }
}
function say(message, extra) {
  status = Object.assign({}, status, { message }, extra || {})
  flushStatus()
  process.stderr.write('[dsh-draw-sdcpp] ' + message + '\n')
}

/** 子进程输出走日志文件 fd（沙箱禁止管道 stdio）。 */
function run(command, args, options = {}) {
  const logFd = openSync(LOG, 'a')
  const capturePath = options.capture ? join(TMP, 'out-' + Date.now() + '.txt') : null
  const outFd = capturePath ? openSync(capturePath, 'w') : logFd
  try {
    const result = spawnSync(command, args, { cwd: options.cwd || root, stdio: ['ignore', outFd, logFd] })
    let stdout = ''
    if (capturePath) { try { stdout = readFileSync(capturePath, 'utf8') } catch (error) { stdout = '' } }
    if (result.error) return { code: -1, stdout, error: String(result.error.message || result.error) }
    return { code: result.status === null ? -1 : result.status, stdout }
  } finally {
    if (outFd !== logFd) closeSync(outFd)
    closeSync(logFd)
    if (capturePath) { try { unlinkSync(capturePath) } catch (error) { /* 忽略 */ } }
  }
}

function detectGpu() {
  const r = run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { capture: true })
  const out = String(r.stdout || '').trim()
  if (r.code === 0 && out) {
    const line = out.split('\n')[0]
    const mb = Number((line.split(',')[1] || '').replace(/[^0-9]/g, ''))
    return { present: true, name: line.split(',')[0].trim(), vramGb: mb ? Math.round(mb / 1024) : 0 }
  }
  return { present: false, name: '', vramGb: 0 }
}

// ── 下载（单连接会被 GitHub / CDN 限速，16 路并发实测快得多）────────────
async function download(url, out, options = {}) {
  const partDir = out + '.parts'
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(partDir, { recursive: true })
  let total = 0
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
  const cr = head.headers.get('content-range')
  total = cr && cr.includes('/') ? Number(cr.split('/')[1]) : Number(head.headers.get('content-length') || 0)
  if (!total) throw new Error('拿不到文件大小')
  const count = Math.min(CONNECTIONS, Math.max(1, Math.ceil(total / (2 * 1024 * 1024))))
  const chunk = Math.ceil(total / count)
  const parts = Array.from({ length: count }, (_, i) => ({
    index: i, from: i * chunk, to: Math.min(i * chunk + chunk - 1, total - 1),
    path: join(partDir, 'part-' + String(i).padStart(3, '0')),
  }))
  const progress = new Array(count).fill(0)
  for (const p of parts) if (existsSync(p.path)) progress[p.index] = statSync(p.path).size
  const initial = progress.reduce((a, b) => a + b, 0)
  const started = Date.now()
  let lastReport = 0

  async function one(part) {
    const want = part.to - part.from + 1
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const done = existsSync(part.path) ? statSync(part.path).size : 0
      if (done >= want) { progress[part.index] = done; return }
      try {
        const res = await fetch(url, { headers: { Range: 'bytes=' + (part.from + done) + '-' + part.to }, redirect: 'follow', signal: AbortSignal.timeout(300000) })
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)
        const handle = createWriteStream(part.path, { flags: done > 0 ? 'a' : 'w' })
        const reader = res.body.getReader()
        let written = done
        try {
          while (true) {
            const { done: finished, value } = await reader.read()
            if (finished) break
            written += value.length
            progress[part.index] = written
            if (!handle.write(Buffer.from(value))) await new Promise((r) => handle.once('drain', r))
            const now = Date.now()
            if (now - lastReport > 3000) {
              lastReport = now
              const got = progress.reduce((a, b) => a + b, 0)
              const speed = (got - initial) / 1048576 / ((now - started) / 1000)
              say(options.label + '：' + (got / 1048576).toFixed(0) + '/' + (total / 1048576).toFixed(0) + ' MB  ' + speed.toFixed(1) + ' MB/s', { percent: Math.round((got / total) * 100) })
            }
          }
        } finally {
          await new Promise((r) => handle.end(r))
        }
        return
      } catch (error) {
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
    }
    throw new Error('分块下载失败：' + url)
  }

  await Promise.all(parts.map(one))
  const outFd = openSync(out, 'w')
  try {
    for (const part of parts) {
      const size = statSync(part.path).size
      const buf = Buffer.alloc(8 * 1024 * 1024)
      const fd = openSync(part.path, 'r')
      let read = 0
      while (read < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - read), read)
        if (n <= 0) break
        writeSync(outFd, buf, 0, n)
        read += n
      }
      closeSync(fd)
      try { unlinkSync(part.path) } catch (error) { /* 忽略 */ }
    }
  } finally {
    closeSync(outFd)
  }
  return out
}

async function downloadSimple(url, out, options = {}) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  const stream = Readable.fromWeb(res.body)
  stream.on('data', (chunk) => {
    got += chunk.length
    if (total) say(options.label + '：' + (got / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB', { percent: Math.round((got / total) * 100) })
  })
  mkdirSync(dirname(out), { recursive: true })
  await pipeline(stream, createWriteStream(out))
  return out
}

function modelFile() {
  const p = join(MODELS, MODEL.saveAs)
  return existsSync(p) ? p : null
}

function detectInstall() {
  let model = modelFile()
  if (!model) {
    try {
      const found = readdirSync(MODELS).filter((f) => f.endsWith('.safetensors') || f.endsWith('.gguf'))
      model = found.length ? join(MODELS, found[0]) : null
    } catch (error) { model = null }
  }
  return { binary: existsSync(BIN), model: !!model, launcher: existsSync(join(root, '启动SD.bat')) }
}

// ── 步骤 ────────────────────────────────────────────────────────────
async function stepBinary() {
  if (existsSync(BIN)) { say('sd-server.exe 已存在，跳过'); return }
  say('下载 stable-diffusion.cpp（Vulkan 版）…', { percent: 0 })
  const zip = join(DL, 'sdcpp-vulkan.zip')
  if (!existsSync(zip)) await download(SDCPP_URL, zip, { label: 'sd.cpp' })
  say('解压…', { percent: 100 })
  const r = run('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + root + '" -Force'])
  if (r.code !== 0 || !existsSync(BIN)) throw new Error('解压失败（看日志 ' + LOG + '）')
}

async function stepModel() {
  if (modelFile() || detectInstall().model) { say('底模已存在，跳过'); return }
  say('下载底模（' + MODEL.label + '）…', { percent: 0 })
  await download(MODEL.url, join(MODELS, MODEL.saveAs), { label: '底模' })
}

async function stepLauncher() {
  const model = modelFile() || (detectInstall().model ? readdirSync(MODELS).filter((f) => /\.(safetensors|gguf)$/.test(f)).map((f) => join(MODELS, f))[0] : null)
  if (!model) throw new Error('还没找到底模，无法生成启动脚本')
  const gpu = detectGpu()
  // 小显存（<8GB）要开卸载与分块，否则容易 OOM（实测 6GB 卡必须这样）
  const memoryFlags = gpu.vramGb && gpu.vramGb < 8
    ? ' --offload-to-cpu --vae-tiling --diffusion-fa --max-vram ' + Math.max(2, gpu.vramGb - 2)
    : ' --diffusion-fa'
  const args = '-m "' + model + '" --listen-ip 127.0.0.1 --listen-port ' + PORT
    + ' --lora-model-dir "' + LORAS + '"' + memoryFlags
  const bat = '@echo off\r\nchcp 65001 >nul\r\ntitle stable-diffusion.cpp\r\ncd /d "%~dp0"\r\n'
    + 'echo 轻量引擎启动中…接口 http://127.0.0.1:' + PORT + '/v1\r\n\r\n'
    + 'sd-server.exe ' + args + '\r\npause\r\n'
  writeFileSync(join(root, '启动SD.bat'), bat, 'utf8')
  writeFileSync(join(root, 'sd-args.txt'), args, 'utf8')
  say('启动脚本已生成（显存 ' + (gpu.vramGb || '?') + 'GB，参数：' + memoryFlags.trim() + '）')
}

// ── 主流程 ──────────────────────────────────────────────────────────
const gpu = detectGpu()
const steps = only.length ? only.filter((s) => STEP_ORDER.indexOf(s) >= 0) : STEP_ORDER.slice()
status.stepCount = steps.length
flushStatus()

if (planOnly) {
  console.log(JSON.stringify({
    ok: true, plan: true, engine: 'sdcpp', platform: process.platform, gpu, root,
    installed: detectInstall(), steps, stepTitles: STEP_TITLES,
    sources: { binary: SDCPP_URL, model: MODEL.label },
    port: PORT,
  }, null, 2))
  process.exit(0)
}

let failed = null
try {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    status.step = step
    status.stepIndex = i
    status.percent = 0
    status.phase = 'running'
    say('【' + (i + 1) + '/' + steps.length + '】' + (STEP_TITLES[step] || step))
    if (step === 'binary') await stepBinary()
    else if (step === 'model') await stepModel()
    else if (step === 'launcher') await stepLauncher()
    status.percent = 100
    status.stepIndex = i + 1
    flushStatus()
  }
  status.phase = 'done'
  status.step = null
  status.message = '安装完成'
  flushStatus()
} catch (error) {
  failed = String((error && error.message) || error)
  status.phase = 'error'
  status.error = failed
  status.message = failed
  flushStatus()
}

console.log(JSON.stringify({
  ok: !failed, error: failed, root, gpu, engine: 'sdcpp',
  installed: detectInstall(),
  binary: existsSync(BIN) ? BIN : null,
  url: 'http://127.0.0.1:' + PORT + '/v1',
  log: LOG,
}))
process.exit(failed ? 1 : 0)
