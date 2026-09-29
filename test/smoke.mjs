/**
 * dsh-draw-plugin — 冒烟测试
 *
 * 不依赖真实 DSH 运行时：把 fs / shell / webServer 三个服务 stub 成最小实现，
 * 验证宿主半边：
 *   1. 模块导出形状（name / inject / apply）；
 *   2. 初始化把生成脚本写进 $DSH_HOME；
 *   3. 两个路由都挂上，POST /dsh-draw/api 能走完整条链路（出图 + 读图）；
 *   4. 保存位置：默认 $DSH_HOME/dsh-draw、自定义位置会被记住、写入边界跟着目录走；
 *   5. 需要 Key 的引擎缺 Key 时明确拒绝。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

// 必须在 import 宿主半边之前设好：默认出图目录基于 DSH_HOME
const FAKE_HOME = process.platform === 'win32' ? 'C:\\fake\\home' : '/fake/home'
process.env.DSH_HOME = FAKE_HOME

const WORKSPACE = process.platform === 'win32' ? 'C:\\fake\\workspace' : '/fake/workspace'
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 1, 2, 3, 4, 5])

/** 记录所有写盘动作。 */
const writes = new Map()
/** 记录所有注册的路由。 */
const routes = new Map()
/** 记录所有被跑过的生成命令。 */
const shellCalls = []

function makeTarget(path) {
  return { targetKey: path, displayPath: path }
}

function isAbsoluteish(value) {
  return value.startsWith('/') || /^[A-Za-z]:/.test(value)
}

const fsStub = {
  async resolve(path, opts) {
    const cwd = (opts && opts.cwd) || WORKSPACE
    return makeTarget(isAbsoluteish(path) ? path : join(cwd, path))
  },
  processPath(target) {
    return target.displayPath
  },
  async writeText(target, content) {
    writes.set(target.displayPath, content)
    return { operation: 'create', version: 'v1', before: null, after: content }
  },
  async stat(target) {
    return writes.has(target.displayPath) ? { version: 'v1', type: 'file' } : undefined
  },
  async readText(target) {
    return writes.get(target.displayPath) || ''
  },
  async readBytes(target, signal, maxBytes) {
    assert.ok(IMAGE_BYTES.length <= maxBytes, 'readBytes 的 maxBytes 应足够大')
    return IMAGE_BYTES
  },
  async listDir() { return [] },
  async editText() { throw new Error('unused') },
  contains() { return false },
  fileUrl(target) { return pathToFileURL(target.displayPath).href },
}

/** shell 服务：记录命令，直接返回一行"生成成功"的 JSON。 */
const shellStub = {
  resolve(request) {
    shellCalls.push(request)
    return {
      command: request.command,
      workdir: request.workdir || WORKSPACE,
      timeoutMs: request.timeoutMs || 120000,
      stdoutMaxBytes: request.stdoutMaxBytes || 100000,
      stdin: request.stdin,
      sandboxPolicy: request.sandboxPolicy,
    }
  },
  started: [],
  start(spec) {
    shellStub.started.push(spec)
    let parsed = {}
    try { parsed = JSON.parse(spec.stdin) } catch (error) { parsed = {} }
    const completed = (text) => ({
      status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
      readOutput: () => ({ delta: text, lossy: false }), kill: () => true,
    })
    // 启动本机引擎的命令：假装"立刻就死了"，用来验证插件会不会如实报错
    if (/main\.py|sd-server\.exe/.test(String(spec.command))) {
      return completed('stub: 引擎启动即退出')
    }
    // 探活 / 列表：立刻跑完并给出输出（run 缺失时的回退路径要靠它）
    if (parsed.mode === 'ping') return completed(JSON.stringify({ ok: false, error: 'stub: ComfyUI 没在跑' }))
    if (parsed.mode === 'probe') return completed(JSON.stringify({ ok: true, checkpoints: [], loras: [], samplers: ['euler'] }))
    // 安装这类长活：一直跑着
    return { status: 'running', exitCode: null, signal: null, done: new Promise(() => {}), readOutput: () => ({ delta: '', lossy: false }), kill: () => true }
  },
  async run(spec) {
    const parsed = JSON.parse(spec.stdin)
    const ok = (text) => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text, truncated: false }, stderr: { text: '', truncated: false },
    })
    // 探活 / 列表请求不是出图，要分开处理
    if (parsed.mode === 'ping') return ok(JSON.stringify({ ok: false, error: 'stub: ComfyUI 没在跑' }))
    if (parsed.mode === 'probe') return ok(JSON.stringify({ ok: true, checkpoints: [], loras: [], samplers: ['euler'] }))
    const file = join(parsed.outDir, 'img-' + parsed.seed + '.jpg')
    return ok(JSON.stringify({ ok: true, path: file, type: 'image/jpeg', bytes: IMAGE_BYTES.length, ms: 12, attempts: 1 }))
  },
}

const webServerStub = {
  register(route) {
    routes.set(route.kind + ' ' + route.path, route.handler)
    return () => routes.delete(route.kind + ' ' + route.path)
  },
}

const services = {
  fs: fsStub,
  shell: shellStub,
  webServer: webServerStub,
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE }) },
  // llm / agentDefaultModel 故意不给：翻译应被安全跳过
}

const ctx = {
  get(name) { return services[name] },
  logger: { warn() {}, error() {}, info() {} },
  effect(callback) { callback() },
}
ctx.fs = fsStub
ctx.shell = shellStub

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; return this },
    end(body) { this.body = body },
  }
}

function fakeReq(payload) {
  const handlers = {}
  return {
    method: 'POST',
    on(event, fn) { handlers[event] = fn; return this },
    setEncoding() {},
    destroy() {},
    __fire() {
      setTimeout(() => {
        if (payload !== undefined) handlers.data(Buffer.from(JSON.stringify(payload), 'utf8'))
        handlers.end()
      }, 0)
    },
  }
}

/** 发一次请求并等它处理完。 */
async function post(handler, payload) {
  const req = fakeReq(payload)
  const res = fakeRes()
  const pending = handler(req, res)
  req.__fire()
  await pending
  return { status: res.statusCode, headers: res.headers, body: res.body, json: JSON.parse(res.body) }
}

const mod = await import(pathToFileURL(join(pkgRoot, 'lib', 'index.js')).href)

// 1) 导出形状
assert.equal(mod.name, 'dsh-draw', 'name 应为 dsh-draw')
assert.deepEqual(mod.inject, ['fs', 'shell', 'webServer'], 'inject 应为三个硬依赖')
assert.equal(typeof mod.apply, 'function', 'apply 应为函数')

// 2) 挂载（刻意不传 outDir，验证默认值）
mod.apply(ctx, {})
await new Promise((r) => setTimeout(r, 20))

const scriptPath = join(FAKE_HOME, '.dsh-draw-gen.mjs')
assert.ok(writes.has(scriptPath), '应把生成脚本写进 $DSH_HOME：' + scriptPath)
const script = writes.get(scriptPath)
assert.ok(script.includes('pollinations'), '脚本应包含 pollinations 分支')
assert.ok(script.includes('images/generations'), '脚本应包含远程引擎分支')
assert.ok(script.includes('fromComfyUI'), '脚本应包含 ComfyUI 分支')

// 顺手落一份生成脚本，便于外部做 `node --check`
const generatedCopy = join(tmpdir(), 'dsh-draw-generated.mjs')
writeFileSync(generatedCopy, script, 'utf8')
console.log('（生成脚本已另存一份，可 node --check：' + generatedCopy + '）')

// 3) 路由
assert.ok(routes.has('exact /dsh-draw/api'), '应注册 POST /dsh-draw/api')
assert.ok(routes.has('prefix /dsh-draw/img/'), '应注册 GET /dsh-draw/img/')
const apiHandler = routes.get('exact /dsh-draw/api')
const imgHandler = routes.get('prefix /dsh-draw/img/')

// 4) 缺省保存位置 = $DSH_HOME/dsh-draw
const first = await post(apiHandler, {
  engine: 'pollinations', model: 'turbo', text: '一只猫',
  prefix: 'flat 2D anime illustration, chibi, ', background: ', pure white background',
  translate: false, width: 1024, height: 1024,
})
assert.equal(first.status, 200, '出图接口应返回 200')
assert.equal(first.json.ok, true, '出图应成功：' + first.body)
assert.equal(first.json.outDir, join(FAKE_HOME, 'dsh-draw'), '缺省保存位置应为 $DSH_HOME/dsh-draw')
assert.ok(first.json.url.startsWith('/dsh-draw/img/'), '应返回图片 URL')
assert.equal(shellCalls.length, 1, '应恰好跑一次生成命令')
assert.equal(shellCalls[0].workdir, FAKE_HOME, '命令的工作目录应为 $DSH_HOME')
assert.equal(shellCalls[0].sandboxPolicy.workspaceRoot, FAKE_HOME, '写入边界应为保存目录的父目录')

// 5) config 动作：默认值 + 尚未自定义
const cfg1 = await post(apiHandler, { action: 'config' })
assert.equal(cfg1.json.ok, true)
assert.equal(cfg1.json.defaultOutDir, join(FAKE_HOME, 'dsh-draw'))
assert.equal(cfg1.json.outDir, '', '还没自定义过，应为空')
assert.equal(cfg1.json.resolvedOutDir, join(FAKE_HOME, 'dsh-draw'))

// 6) 自定义保存位置：生效 + 被记住
const CUSTOM = 'my-pics'
const second = await post(apiHandler, {
  engine: 'pollinations', model: 'turbo', text: '一只猫',
  prefix: 'chibi, ', translate: false, width: 512, height: 512, outDir: CUSTOM,
})
assert.equal(second.json.ok, true, '自定义位置出图应成功：' + second.body)
assert.equal(second.json.outDir, join(FAKE_HOME, CUSTOM), '相对路径应按 DSH_HOME 解析')
assert.equal(shellCalls[1].sandboxPolicy.workspaceRoot, FAKE_HOME, '写入边界应跟着保存目录走')

const configPath = join(FAKE_HOME, 'dsh-draw.config.json')
assert.ok(writes.has(configPath), '应把保存位置记住到 ' + configPath)
assert.equal(JSON.parse(writes.get(configPath)).outDir, CUSTOM, '记住的应是原样的写法')

// 7) 再读 config 应返回记住的值
const cfg2 = await post(apiHandler, { action: 'config' })
assert.equal(cfg2.json.outDir, CUSTOM)
assert.equal(cfg2.json.resolvedOutDir, join(FAKE_HOME, CUSTOM))

// 8) 图片路由能取到刚缓存的字节
const imgRes = fakeRes()
imgHandler({ url: first.json.url }, imgRes)
assert.equal(imgRes.statusCode, 200, '图片路由应返回 200')
assert.equal(imgRes.headers['Content-Type'], 'image/jpeg', '应按真实类型返回')
assert.deepEqual(Array.from(imgRes.body), Array.from(IMAGE_BYTES), '应返回原始字节')

// 9) 缺 Key 的引擎应被明确拒绝
const noKey = await post(apiHandler, {
  engine: 'siliconflow', model: 'Kwai-Kolors/Kolors', text: '一只猫', translate: false,
})
assert.equal(noKey.json.ok, false, '缺 Key 时应失败')
assert.ok(noKey.json.error.includes('API Key'), '错误信息应提示需要 Key：' + noKey.json.error)

// 10) ComfyUI 环境：状态检测（并确认宿主能读到一键安装器源码）
const envStatus = await post(apiHandler, { action: 'comfy-status' })
assert.equal(envStatus.json.ok, true, 'comfy-status 应成功：' + envStatus.body)
assert.equal(envStatus.json.installerReady, true, '应能读到 lib/setup.mjs —— 一键安装器要能工作')
assert.equal(envStatus.json.installed.comfy, false, 'stub 环境里不该检测到已安装')
assert.equal(envStatus.json.running, false, 'stub 环境里 ComfyUI 不该是在跑')

// 11) 一键安装：把安装器写到 $DSH_HOME，以后台进程启动（不能阻塞请求）
const setupResult = await post(apiHandler, { action: 'comfy-setup', comfyDir: 'comfy-test' })
assert.equal(setupResult.json.ok, true, 'comfy-setup 应能启动：' + setupResult.body)
assert.equal(setupResult.json.started, true)
assert.ok(writes.has(join(FAKE_HOME, '.dsh-draw-setup.mjs')), '安装器应被写到 $DSH_HOME')
assert.ok(shellStub.started.length >= 1, '安装应作为后台进程启动')

// 12) 启动 ComfyUI：目录里没有时给明确报错
const launchMissing = await post(apiHandler, { action: 'comfy-launch', comfyDir: 'nowhere' })
assert.equal(launchMissing.json.ok, false, '目录里没有 ComfyUI 时应失败')
assert.ok(String(launchMissing.json.error).includes('没有装好的'), '错误应说明目录里没有 ComfyUI：' + launchMissing.json.error)

// 13) 老面板兼容：早期版本发出的 comfyui-status 要等价于 comfy-status
const legacyStatus = await post(apiHandler, { action: 'comfyui-status' })
assert.equal(legacyStatus.json.ok, true, 'comfyui-status 应被折成 comfy-status：' + legacyStatus.body)
assert.equal(legacyStatus.json.installerReady, true, '兼容路径也应返回真实检测结果')

// 14) 轻量引擎：状态检测同样要能读到安装器
const liteStatus = await post(apiHandler, { action: 'sdcpp-status' })
assert.equal(liteStatus.json.ok, true, 'sdcpp-status 应成功：' + liteStatus.body)
assert.equal(liteStatus.json.installerReady, true, '应能读到 lib/setup-sdcpp.mjs')

// 15) 真·未知动作：必须明确报错，绝不能掉进"出图"分支（否则会误报"提示词是空的"）
const unknown = await post(apiHandler, { action: 'nonsense-action' })
assert.equal(unknown.json.ok, false, '未知动作应失败')
assert.ok(String(unknown.json.error).includes('不认识'), '错误应说明宿主不认识该动作：' + unknown.json.error)
assert.ok(!String(unknown.json.error).includes('提示词'), '未知动作不该被当成出图请求：' + unknown.json.error)

// 16) 本机引擎目录要被记住（不然 DSH 每重启一次，面板里的「目录」就空一次）
const comfyCustom = join(FAKE_HOME, 'ComfyUI-test')
await post(apiHandler, { action: 'comfy-status', comfyDir: comfyCustom, baseUrl: 'http://127.0.0.1:8188' })
const cfg3 = await post(apiHandler, { action: 'config' })
assert.equal(cfg3.json.comfyDir, comfyCustom, 'config 应回记住的 ComfyUI 目录：' + cfg3.body)
assert.equal(JSON.parse(writes.get(configPath)).comfyDir, comfyCustom, 'ComfyUI 目录应写进配置文件')

const sdcppCustom = join(FAKE_HOME, 'sdcpp-test')
await post(apiHandler, { action: 'sdcpp-status', sdcppDir: sdcppCustom })
const cfg4 = await post(apiHandler, { action: 'config' })
assert.equal(cfg4.json.sdcppDir, sdcppCustom, 'config 应回记住的 SD.cpp 目录：' + cfg4.body)
assert.equal(JSON.parse(writes.get(configPath)).outDir, CUSTOM, '记目录不能把原来的保存位置冲掉')

// 17) 有的 DSH 版本 shell 服务只有 start 没有 run：要能退回 start 干活
const savedRun = shellStub.run
shellStub.run = undefined
try {
  const fallback = await post(apiHandler, { action: 'comfy-models', baseUrl: 'http://127.0.0.1:8188' })
  assert.equal(fallback.json.ok, true, '缺 run 时应退回 start：' + fallback.body)
  assert.ok(Array.isArray(fallback.json.checkpoints), '退回路径也要拿到模型列表')
} finally {
  shellStub.run = savedRun
}

// 18) run / start 都没有：必须说清"宿主 shell 服务到底提供了什么"，别让人瞎猜
const savedStart = shellStub.start
shellStub.run = undefined
shellStub.start = undefined
try {
  const none = await post(apiHandler, { action: 'comfy-status', baseUrl: 'http://127.0.0.1:8188' })
  assert.equal(none.json.ok, false, '没有任何执行方法时应失败')
  assert.ok(String(none.json.error).includes('run'), '错误里应点名 run：' + none.json.error)
  assert.ok(String(none.json.error).includes('resolve'), '错误里应列出它实际提供的方法：' + none.json.error)
} finally {
  shellStub.run = savedRun
  shellStub.start = savedStart
}

// 19) 官方便携包是 python_embeded 布局，也要认出来
const portableRoot = join(FAKE_HOME, 'ComfyUI_windows_portable')
writes.set(join(portableRoot, 'python_embeded', 'python.exe'), '')
writes.set(join(portableRoot, 'ComfyUI', 'main.py'), '')
const portable = await post(apiHandler, { action: 'comfy-status', comfyDir: portableRoot, baseUrl: 'http://127.0.0.1:8188' })
assert.equal(portable.json.installed.python, true, 'python_embeded 布局应被认成已安装：' + portable.body)
assert.equal(portable.json.installed.comfy, true, 'python_embeded 布局应被认成已安装')

// 20) 启动的进程立刻死掉时，必须如实报错（不能显示"已启动"骗人）
const launchRoot = join(FAKE_HOME, 'ComfyUI-launch')
writes.set(join(launchRoot, 'python', 'python.exe'), '')
writes.set(join(launchRoot, 'ComfyUI', 'main.py'), '')
const died = await post(apiHandler, { action: 'comfy-launch', comfyDir: launchRoot })
assert.equal(died.json.ok, false, '进程立刻退出时应报失败：' + died.body)
assert.ok(String(died.json.error).includes('没能留住'), '错误应说明它没能留住：' + died.json.error)

// 21) 指到 ComfyUI Desktop（桌面包）目录时，要给对症的提示
const desktop = await post(apiHandler, { action: 'comfy-launch', comfyDir: 'D:\\tool\\comfy\\Comfy Desktop' })
assert.equal(desktop.json.ok, false, '桌面包目录不该被当成便携版')
assert.ok(String(desktop.json.error).includes('Desktop'), '应提示这是桌面包、不用填目录：' + desktop.json.error)

console.log('✓ smoke test passed')
console.log('  导出形状 / 初始化写盘 / 两个路由 / 出图链路 / 图片读取 / 缺 Key 拒绝')
console.log('  保存位置：默认 $DSH_HOME/dsh-draw、自定义生效并记住、写入边界随目录走')
console.log('  ComfyUI 环境：状态检测 / 安装器可读 / 一键安装后台启动 / 缺安装时报错')
console.log('  动作名兼容 / 未知动作明确报错 / 本机引擎目录被记住')
console.log('  shell 只有 start 也能跑 / 没有 run+start 时点名报错 / python_embeded 布局 / 启动失败如实报错')