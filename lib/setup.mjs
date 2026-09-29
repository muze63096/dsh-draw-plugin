/**
 * dsh-draw — ComfyUI 一键安装器
 *
 * 由插件宿主写出到磁盘、再用 `node` 执行。它把「装一个能用的 ComfyUI」这件事
 * 全自动做完，并且**只用国内可达的源**（GitHub 直连在很多网络下是断的）。
 *
 * 用法：
 *   node setup.mjs --root=<安装目录> [--with-model] [--only=<步骤,步骤>] [--plan]
 *   或从 stdin 读 JSON：{"root":"...","withModel":true,"only":["python"],"plan":false}
 *
 * 步骤（可单独跑、可断点续跑，已完成的会跳过）：
 *   python       嵌入式 Python 3.12（华为云镜像）
 *   pip          取 pip wheel 解压安装 + 修 _pth + 打 tempfile 补丁
 *   comfy        ComfyUI 源码（Gitee 镜像）
 *   torch        CUDA 版 torch / torchvision / torchaudio（pytorch 官方源，多线程下）
 *   requirements ComfyUI 的其余依赖（清华 PyPI）
 *   model        默认二次元底模（ModelScope）
 *
 * 进度写到 <root>/.dsh-setup-status.json，宿主/面板轮询它显示进度。
 * 结果以一行 JSON 打到 stdout。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, closeSync, readSync, writeSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 全部使用国内可达的源。 */
const SOURCES = {
  python: 'https://mirrors.huaweicloud.com/python/3.12.10/python-3.12.10-embed-amd64.zip',
  pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  pipIndexJson: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  comfyZip: 'https://gitee.com/mirrors/ComfyUI/repository/archive/master.zip',
  torchIndex: 'https://download.pytorch.org/whl/cu128',
  torchVersion: '2.9.1',
  model: {
    url: 'https://www.modelscope.cn/models/VoidOc/ckpt_sd1.5_anime/resolve/master/%E5%8A%A8%E6%BC%AB%E4%BA%8C%E6%AC%A1%E5%85%832.5D_dxMix.safetensors',
    saveAs: 'anime-2.5D-dxMix.safetensors',
    label: '动漫二次元 2.5D dxMix（SD1.5，约 2GB）',
  },
}

const CONNECTIONS = 16
const STEP_ORDER = ['python', 'pip', 'comfy', 'torch', 'requirements', 'model']
const STEP_TITLES = {
  python: '下载嵌入式 Python',
  pip: '安装 pip 与补丁',
  comfy: '下载 ComfyUI 源码',
  torch: '下载安装 CUDA 版 PyTorch（约 2.7GB）',
  requirements: '安装 ComfyUI 依赖',
  model: '下载默认底模（约 2GB）',
}

// ── 入参 ────────────────────────────────────────────────────────────
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
const withModel = fromArgs['with-model'] === true || input.withModel === true
const planOnly = fromArgs.plan === true || input.plan === true
const only = String(fromArgs.only || '').split(',').map((s) => s.trim()).filter(Boolean)

if (!root) {
  console.log(JSON.stringify({ ok: false, error: '缺少 --root=<安装目录>' }))
  process.exit(1)
}

const PY = join(root, 'python', 'python.exe')
const PY_DIR = join(root, 'python')
const COMFY_DIR = join(root, 'ComfyUI')
const SITE = join(PY_DIR, 'Lib', 'site-packages')
const TMP = join(root, '.tmp')
const DL = join(root, '.downloads')
const CACHE = join(root, '.pipcache')
const LOG = join(root, '.dsh-setup.log')
const STATUS = join(root, '.dsh-setup-status.json')

for (const d of [root, TMP, DL, CACHE]) mkdirSync(d, { recursive: true })
const IS_WIN = process.platform === 'win32'

// ── 状态 / 日志 ─────────────────────────────────────────────────────
let status = {
  phase: 'idle',
  step: null,
  stepIndex: 0,
  stepCount: STEP_ORDER.length,
  percent: 0,
  message: '',
  error: null,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  root,
}

function flushStatus() {
  status.updatedAt = Date.now()
  try { writeFileSync(STATUS, JSON.stringify(status, null, 2), 'utf8') } catch (error) { /* 忽略 */ }
}

function say(message, extra) {
  status = Object.assign({}, status, { message }, extra || {})
  flushStatus()
  process.stderr.write('[dsh-draw-setup] ' + message + '\n')
}

function totalProgress() {
  const done = status.stepIndex
  const within = typeof status.percent === 'number' ? status.percent / 100 : 0
  return Math.min(100, Math.round(((done + within) / status.stepCount) * 100))
}

// ── 子进程（不用管道：沙箱禁止捕获管道 stdio，改用文件 fd）──────────
function run(command, args, options = {}) {
  const logFd = openSync(LOG, 'a')
  // 需要读输出时，把 stdout 落到单独的文件里再读回来（管道在沙箱里会被拒）
  const capturePath = options.capture ? join(TMP, 'stdout-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.txt') : null
  const outFd = capturePath ? openSync(capturePath, 'w') : logFd
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd || root,
      stdio: ['ignore', outFd, logFd],
      env: Object.assign({}, process.env, {
        TEMP: TMP,
        TMP,
        PIP_CACHE_DIR: CACHE,
        HF_HOME: join(root, '.hf'),
        PYTHONIOENCODING: 'utf-8',
      }),
    })
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

function readLogTail(bytes = 1200) {
  try {
    const size = statSync(LOG).size
    const start = Math.max(0, size - bytes)
    const fd = openSync(LOG, 'r')
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8')
  } catch (error) { return '' }
}

// ── 多线程下载（单连接会被限速，实测 16 路能到 10MB/s+）───────────────
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  return res.text()
}

async function download(url, out, options = {}) {
  const partDir = out + '.parts'
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(partDir, { recursive: true })

  let total = options.size || 0
  if (!total) {
    const head = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    const cr = head.headers.get('content-range')
    total = cr && cr.includes('/') ? Number(cr.split('/')[1]) : Number(head.headers.get('content-length') || 0)
  }
  if (!total) throw new Error('拿不到文件大小（源不支持 Range？）')

  const count = Math.min(CONNECTIONS, Math.max(1, Math.ceil(total / (2 * 1024 * 1024))))
  const chunk = Math.ceil(total / count)
  const parts = Array.from({ length: count }, (_, i) => ({
    index: i,
    from: i * chunk,
    to: Math.min(i * chunk + chunk - 1, total - 1),
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
        const res = await fetch(url, {
          headers: { Range: 'bytes=' + (part.from + done) + '-' + part.to },
          redirect: 'follow',
          signal: AbortSignal.timeout(300000),
        })
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
              say(options.label + '：' + (got / 1048576).toFixed(0) + '/' + (total / 1048576).toFixed(0) + ' MB  ' + speed.toFixed(1) + ' MB/s', {
                percent: Math.round((got / total) * 100),
              })
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

/** 单连接下载（小文件用）。 */
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

// ── 检测 ────────────────────────────────────────────────────────────
function detectGpu() {
  // 注意：不能用 spawnSync 默认的管道捕获（沙箱会拒），所以走 run() 的文件捕获
  const r = run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { capture: true })
  const out = String(r.stdout || '').trim()
  if (r.code === 0 && out) {
    const line = out.split('\n')[0]
    return { present: true, name: line.split(',')[0].trim(), memory: (line.split(',')[1] || '').trim() }
  }
  return { present: false }
}

function detectInstall() {
  let hasModel = false
  try {
    const dir = join(COMFY_DIR, 'models', 'checkpoints')
    hasModel = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.safetensors'))
  } catch (error) { hasModel = false }
  return {
    python: existsSync(PY),
    pip: existsSync(join(SITE, 'pip')),
    comfy: existsSync(join(COMFY_DIR, 'main.py')),
    torch: existsSync(join(SITE, 'torch')),
    requirements: existsSync(join(SITE, 'transformers')) && existsSync(join(SITE, 'aiohttp')),
    model: hasModel,
  }
}

// ── 各步骤 ──────────────────────────────────────────────────────────
async function stepPython() {
  if (existsSync(PY)) { say('Python 已存在，跳过'); return }
  say('下载嵌入式 Python…', { percent: 0 })
  const zip = join(DL, 'python-embed.zip')
  if (!existsSync(zip)) await downloadSimple(SOURCES.python, zip, { label: 'Python' })
  say('解压 Python…', { percent: 100 })
  const r = run('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + PY_DIR + '" -Force'])
  if (r.code !== 0 || !existsSync(PY)) throw new Error('解压 Python 失败（展开日志看 ' + LOG + '）')
}

async function stepPip() {
  const pyPth = join(PY_DIR, 'python312._pth')
  if (!existsSync(join(SITE, 'pip'))) {
    say('获取 pip…', { percent: 0 })
    const index = await fetchText(SOURCES.pipIndex + '/pip/')
    const links = [...index.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1].split('#')[0])
      .filter((l) => /pip-[0-9]/.test(l) && l.endsWith('-py3-none-any.whl'))
    if (!links.length) throw new Error('pip 索引里没找到 wheel')
    const url = new URL(links[links.length - 1], SOURCES.pipIndex + '/pip/').href
    const wheel = join(DL, 'pip.whl')
    if (!existsSync(wheel)) await downloadSimple(url, wheel, { label: 'pip' })
    mkdirSync(SITE, { recursive: true })
    const r = run(PY, ['-c', 'import zipfile;zipfile.ZipFile(r"' + wheel + '").extractall(r"' + SITE + '")'])
    if (r.code !== 0 || !existsSync(join(SITE, 'pip'))) throw new Error('解压 pip 失败')
  } else {
    say('pip 已存在，跳过')
  }

  // _pth：嵌入式 Python 默认不加载 site、也不把脚本目录放进 sys.path
  const pth = ['python312.zip', '.', 'Lib\\site-packages', '..\\ComfyUI', 'import site'].join('\n') + '\n'
  const current = existsSync(pyPth) ? readFileSync(pyPth, 'utf8') : ''
  if (current !== pth) { writeFileSync(pyPth, pth, 'utf8'); say('已修正 python312._pth') }

  // tempfile.mkdtemp 在受限令牌下 ACL 有问题：换成普通 mkdir
  const patch = join(SITE, 'sitecustomize.py')
  const patchSource = [
    '"""dsh-draw 自动写入：修正受限环境下 tempfile.mkdtemp 的 ACL 问题。"""',
    'import os, random, string, tempfile',
    "_A = string.ascii_lowercase + string.digits",
    'def _safe_mkdtemp(suffix=None, prefix=None, dir=None):',
    "    suffix = suffix or ''",
    "    prefix = prefix or 'tmp'",
    '    base = dir or tempfile.gettempdir()',
    '    for _ in range(2000):',
    "        name = prefix + ''.join(random.choice(_A) for _ in range(8)) + suffix",
    '        path = os.path.join(base, name)',
    '        try:',
    '            os.mkdir(path)',
    '            return path',
    '        except FileExistsError:',
    '            continue',
    "    raise FileExistsError('safe_mkdtemp exhausted')",
    'tempfile.mkdtemp = _safe_mkdtemp',
    'tempfile._mkdtemp = _safe_mkdtemp',
    '',
  ].join('\n')
  if (!existsSync(patch) || readFileSync(patch, 'utf8') !== patchSource) {
    writeFileSync(patch, patchSource, 'utf8')
    say('已写入 tempfile 补丁')
  }
}

async function stepComfy() {
  if (existsSync(join(COMFY_DIR, 'main.py'))) { say('ComfyUI 已存在，跳过'); return }
  say('下载 ComfyUI 源码…', { percent: 0 })
  const zip = join(DL, 'comfyui-src.zip')
  if (!existsSync(zip)) await downloadSimple(SOURCES.comfyZip, zip, { label: 'ComfyUI 源码' })
  say('解压 ComfyUI…', { percent: 100 })
  const staging = join(root, '.staging')
  mkdirSync(staging, { recursive: true })
  const r = run('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + staging + '" -Force'])
  if (r.code !== 0) throw new Error('解压 ComfyUI 失败')
  // Gitee 的包里是一层 comfyui-master/
  const inner = (() => {
    for (const name of readdirSync(staging)) {
      if (existsSync(join(staging, name, 'main.py'))) return join(staging, name)
    }
    return null
  })()
  if (!inner) throw new Error('解压出来的目录里没有 main.py')
  const mv = run('powershell', ['-NoProfile', '-Command', 'Move-Item -LiteralPath "' + inner + '" -Destination "' + COMFY_DIR + '" -Force'])
  if (mv.code !== 0 || !existsSync(join(COMFY_DIR, 'main.py'))) throw new Error('移动 ComfyUI 目录失败')
}

async function resolveTorchUrl() {
  const index = await fetchText(SOURCES.torchIndex + '/torch/')
  const wheels = [...index.matchAll(/href="([^"]+)"/g)]
    .map((m) => decodeURIComponent(m[1].split('#')[0]))
    .filter((h) => h.includes('cp312') && h.includes('win_amd64') && h.includes(SOURCES.torchVersion))
  if (!wheels.length) throw new Error('cu128 索引里没有 ' + SOURCES.torchVersion + ' 的 win cp312 wheel')
  return new URL(wheels[wheels.length - 1], SOURCES.torchIndex + '/torch/').href
}

async function pipInstall(args, label) {
  say(label, { percent: 0 })
  const r = run(PY, ['-m', 'pip', 'install', '--no-warn-script-location'].concat(args))
  if (r.code !== 0) throw new Error(label + ' 失败（看日志 ' + LOG + '）')
}

async function stepTorch() {
  if (existsSync(join(SITE, 'torch', 'version.py'))) {
    const check = run(PY, ['-c', 'import torch;print(torch.__version__)'], { capture: true })
    if (check.code === 0 && String(check.stdout).includes('+cu')) { say('torch 已是 CUDA 版（' + String(check.stdout).trim() + '），跳过'); return }
  }
  say('解析 CUDA 版 torch 地址…', { percent: 0 })
  const url = await resolveTorchUrl()
  const torchWheel = join(DL, decodeURIComponent(url.split('/').pop()))
  if (!existsSync(torchWheel)) await download(url, torchWheel, { label: 'PyTorch' })
  await pipInstall(['--no-deps', torchWheel], '安装 torch（本地 wheel）')

  // torchvision / torchaudio：小文件，单连接即可
  for (const pkg of ['torchvision', 'torchaudio']) {
    const index = await fetchText(SOURCES.torchIndex + '/' + pkg + '/')
    const wheels = [...index.matchAll(/href="([^"]+)"/g)]
      .map((m) => decodeURIComponent(m[1].split('#')[0]))
      .filter((h) => h.includes('cp312') && h.includes('win_amd64') && h.endsWith('.whl'))
    if (!wheels.length) continue
    const picked = wheels.filter((h) => h.includes(SOURCES.torchVersion))[0] || wheels[wheels.length - 1]
    const pkgUrl = new URL(picked, SOURCES.torchIndex + '/' + pkg + '/').href
    const out = join(DL, decodeURIComponent(pkgUrl.split('/').pop()))
    if (!existsSync(out)) await downloadSimple(pkgUrl, out, { label: pkg })
    await pipInstall(['--no-deps', out], '安装 ' + pkg)
  }

  const verify = run(PY, ['-c', 'import torch;print("CUDA", torch.cuda.is_available())'], { capture: true })
  if (verify.code !== 0) throw new Error('torch 安装后自检失败')
  say('PyTorch 就绪（' + (String(verify.stdout).includes('True') ? 'CUDA 可用' : '注意：CUDA 未启用') + '）', { percent: 100 })
}

async function stepRequirements() {
  if (existsSync(join(SITE, 'transformers')) && existsSync(join(SITE, 'aiohttp'))) { say('依赖已存在，跳过'); return }
  await pipInstall(['-r', join(COMFY_DIR, 'requirements.txt'), '--index-url', SOURCES.pipIndex], '安装 ComfyUI 依赖')
}

async function stepModel() {
  const dir = join(COMFY_DIR, 'models', 'checkpoints')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, SOURCES.model.saveAs)
  if (existsSync(target)) { say('底模已存在，跳过'); return }
  say('下载底模（' + SOURCES.model.label + '）…', { percent: 0 })
  await download(SOURCES.model.url, target, { label: '底模' })
}

// ── 主流程 ──────────────────────────────────────────────────────────
const gpu = detectGpu()
const before = detectInstall()
const steps = (only.length ? only : STEP_ORDER).filter((s) => s === 'model' ? (withModel || only.includes('model')) : true)

status.stepCount = steps.length
flushStatus()

if (planOnly) {
  console.log(JSON.stringify({
    ok: true,
    plan: true,
    platform: process.platform,
    gpu,
    root,
    installed: before,
    steps,
    stepTitles: STEP_TITLES,
    sources: { python: SOURCES.python, comfy: SOURCES.comfyZip, torch: SOURCES.torchIndex, pip: SOURCES.pipIndex, model: SOURCES.model.label },
  }, null, 2))
  process.exit(0)
}

if (!IS_WIN) {
  console.log(JSON.stringify({ ok: false, error: '一键安装目前只支持 Windows（这套源与 torch 构建都是 Windows/NVIDIA 的）' }))
  process.exit(1)
}
if (!gpu.present) {
  console.log(JSON.stringify({ ok: false, error: '没检测到 NVIDIA 显卡（nvidia-smi 不可用），一键安装需要 N 卡' }))
  process.exit(1)
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
    if (step === 'python') await stepPython()
    else if (step === 'pip') await stepPip()
    else if (step === 'comfy') await stepComfy()
    else if (step === 'torch') await stepTorch()
    else if (step === 'requirements') await stepRequirements()
    else if (step === 'model') await stepModel()
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
  status.logTail = readLogTail(2000)
  flushStatus()
}

const after = detectInstall()
console.log(JSON.stringify({
  ok: !failed,
  error: failed,
  root,
  gpu,
  installed: after,
  python: existsSync(PY) ? PY : null,
  comfyDir: existsSync(join(COMFY_DIR, 'main.py')) ? COMFY_DIR : null,
  log: LOG,
  statusFile: STATUS,
}))
process.exit(failed ? 1 : 0)
