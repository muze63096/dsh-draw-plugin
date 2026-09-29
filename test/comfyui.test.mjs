/**
 * dsh-draw-plugin — ComfyUI 链路集成测试
 *
 * 用一个假 ComfyUI（test/mock-comfyui.mjs）真跑一遍生成脚本，验证：
 *   1. 探活：/object_info → 模型 / LoRA 列表
 *   2. 自动工作流：选模型 + 挂 LoRA → 提交的 workflow 里真的有 LoraLoader 和提示词
 *   3. 轮询：/history 第一次为空时继续等，第二次拿到图 → /view 取图 → 落盘
 *   4. 自定义工作流：{{prompt}} 占位符替换 + 自动识别 CLIPTextEncode 两条路都对
 *
 * 全程不 spawn 子进程（沙箱里带管道 stdio 的 spawn 会 EPERM），
 * 而是把脚本当模块 import，并临时替换 process.stdin / console.log。
 *
 * 运行：node test/comfyui.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startMockComfy, TINY_PNG } from './mock-comfyui.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-draw-comfy-home-'))
process.env.DSH_HOME = HOME
const OUT_DIR = mkdtempSync(join(tmpdir(), 'dsh-draw-comfy-out-'))

// ── 最小宿主桩：只为拿到插件内嵌的生成脚本 ─────────────────────────
const captured = new Map()
const fsStub = {
  async resolve(path, opts) {
    const cwd = (opts && opts.cwd) || HOME
    const abs = path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : join(cwd, path)
    return { targetKey: abs, displayPath: abs }
  },
  processPath(target) { return target.displayPath },
  async writeText(target, content) { captured.set(target.displayPath, content); return {} },
  async stat() { return undefined },
  async readText() { return '' },
  async readBytes() { return new Uint8Array() },
}
const shellStub = { resolve: (request) => request, async run() { return { stdout: { text: '' } } } }
const webServerStub = { register() { return () => {} } }
const services = { fs: fsStub, shell: shellStub, webServer: webServerStub }
const ctx = {
  fs: fsStub,
  shell: shellStub,
  get(name) { return services[name] },
  logger: { warn() {}, error() {} },
  effect(callback) { callback() },
}

const mod = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)
mod.apply(ctx, {})
await new Promise((r) => setTimeout(r, 20))

const scriptKey = [...captured.keys()].find((key) => key.endsWith('.dsh-draw-gen.mjs'))
assert.ok(scriptKey, '应捕获到生成脚本')
const scriptPath = join(HOME, 'generator.mjs')
writeFileSync(scriptPath, captured.get(scriptKey), 'utf8')

/** 把脚本当模块跑一次，喂它 stdin、收它的 stdout。 */
async function runGenerator(payload) {
  const { Readable } = await import('node:stream')
  const fake = new Readable({ read() {} })
  fake.push(JSON.stringify(payload))
  fake.push(null)
  const desc = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
  const logs = []
  const originalLog = console.log
  console.log = (...args) => { logs.push(args.map(String).join(' ')) }
  try {
    await import(pathToFileURL(scriptPath).href + '?run=' + Math.random())
  } finally {
    console.log = originalLog
    if (desc) Object.defineProperty(process, 'stdin', desc)
  }
  const last = logs[logs.length - 1]
  assert.ok(last, '脚本应该有输出')
  return JSON.parse(last)
}

const mock = await startMockComfy()
const base = 'http://127.0.0.1:' + mock.port
const workflow = { outDir: OUT_DIR, seed: 1234 }

try {
  // ── 1. 探活 ─────────────────────────────────────────────────────
  const probe = await runGenerator({ mode: 'probe', engine: 'comfyui', baseUrl: base })
  assert.equal(probe.ok, true, '探活应成功：' + JSON.stringify(probe))
  assert.deepEqual(probe.checkpoints, ['test-model.safetensors', 'anime-xl.safetensors'], '应读到模型列表')
  assert.deepEqual(probe.loras, ['style-a.safetensors', 'style-b.safetensors'], '应读到 LoRA 列表')
  assert.deepEqual(probe.samplers, ['euler', 'dpmpp_2m'], '应读到采样器列表')

  // ── 2. 自动工作流 + LoRA + 轮询 + 取图 + 落盘 ────────────────────
  const run = await runGenerator({
    engine: 'comfyui',
    baseUrl: base,
    prompt: 'chibi anime girl, blue hair',
    negative: 'lowres, bad anatomy',
    checkpoint: 'anime-xl.safetensors',
    lora: 'style-a.safetensors',
    loraWeight: 0.75,
    steps: 20,
    cfg: 6.5,
    width: 768,
    height: 1024,
    outDir: OUT_DIR,
    seed: 1234,
    timeoutMs: 30000,
  })
  assert.equal(run.ok, true, 'ComfyUI 出图应成功：' + JSON.stringify(run))
  assert.equal(run.type, 'image/png')
  assert.ok(existsSync(run.path), '图片应落盘：' + run.path)
  assert.deepEqual(readFileSync(run.path), TINY_PNG, '落盘内容应与 /view 返回一致')
  assert.ok(run.note && run.note.includes('默认工作流'), '应注明用的是自动工作流：' + run.note)

  const submitted = mock.state.submitted
  assert.ok(submitted && submitted.prompt, '假 ComfyUI 应收到 /prompt')
  const graph = submitted.prompt
  assert.equal(graph['4'].inputs.ckpt_name, 'anime-xl.safetensors', '模型应写进 CheckpointLoaderSimple')
  assert.ok(graph['10'], '挂了 LoRA 就应该有 LoraLoader 节点')
  assert.equal(graph['10'].inputs.lora_name, 'style-a.safetensors')
  assert.equal(graph['10'].inputs.strength_model, 0.75, 'LoRA 权重应生效')
  assert.deepEqual(graph['3'].inputs.model, ['10', 0], 'KSampler 的 model 应接到 LoRA 输出')
  assert.equal(graph['3'].inputs.steps, 20, '步数应生效')
  assert.equal(graph['3'].inputs.cfg, 6.5, 'CFG 应生效')
  assert.equal(graph['5'].inputs.width, 768, '宽度应生效')
  assert.equal(graph['6'].inputs.text, 'chibi anime girl, blue hair', '正向提示词应注入')
  assert.equal(graph['7'].inputs.text, 'lowres, bad anatomy', '负向提示词应注入')
  assert.equal(graph['9'].class_type, 'SaveImage')
  assert.ok(mock.state.historyPolls >= 2, '第一次 /history 为空时应继续轮询（实际 ' + mock.state.historyPolls + ' 次）')
  assert.equal(mock.state.viewQueries, 1, '应恰好取图一次')

  // ── 3. 自定义工作流：占位符 ──────────────────────────────────────
  mock.state.submitted = null
  mock.state.historyPolls = 0
  const templated = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'prefix {{prompt}} suffix', clip: ['4', 1] } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'neg {{negative}}', clip: ['4', 1] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anime-xl.safetensors' } },
  }
  const run2 = await runGenerator({
    engine: 'comfyui',
    baseUrl: base,
    prompt: 'CAT',
    negative: 'DOG',
    workflow: JSON.stringify(templated),
    width: 512,
    height: 512,
    outDir: OUT_DIR,
    timeoutMs: 30000,
  })
  assert.equal(run2.ok, true, '自定义工作流应成功：' + JSON.stringify(run2))
  assert.ok(run2.note.includes('占位符'), '应走占位符分支：' + run2.note)
  assert.equal(mock.state.submitted.prompt['1'].inputs.text, 'prefix CAT suffix', '{{prompt}} 应被替换')
  assert.equal(mock.state.submitted.prompt['2'].inputs.text, 'neg DOG', '{{negative}} 应被替换')

  // ── 4. 自定义工作流：自动识别正/负向节点 ─────────────────────────
  mock.state.submitted = null
  mock.state.historyPolls = 0
  const plain = {
    '5': { class_type: 'CLIPTextEncode', inputs: { text: 'old positive', clip: ['4', 1] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative', clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { positive: ['5', 0], negative: ['6', 0], model: ['4', 0], steps: 10, cfg: 7, seed: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1, latent_image: ['7', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anime-xl.safetensors' } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  }
  const run3 = await runGenerator({
    engine: 'comfyui',
    baseUrl: base,
    prompt: 'NEW POS',
    negative: 'NEW NEG',
    workflow: JSON.stringify(plain),
    width: 512,
    height: 512,
    outDir: OUT_DIR,
    timeoutMs: 30000,
  })
  assert.equal(run3.ok, true, '自动识别应成功：' + JSON.stringify(run3))
  assert.ok(run3.note.includes('自动识别'), '应走自动识别分支：' + run3.note)
  assert.equal(mock.state.submitted.prompt['5'].inputs.text, 'NEW POS', '正向应替换到 KSampler.positive 指向的节点')
  assert.equal(mock.state.submitted.prompt['6'].inputs.text, 'NEW NEG', '负向应替换到 KSampler.negative 指向的节点')

  // ── 5. 连不上时应给出可读错误 ────────────────────────────────────
  const dead = await runGenerator({ engine: 'comfyui', baseUrl: 'http://127.0.0.1:1', checkpoint: 'x.safetensors', prompt: 'x', outDir: OUT_DIR, timeoutMs: 3000 })
  assert.equal(dead.ok, false, '连不上应失败')
  assert.ok(dead.error && dead.error.length > 0, '应有错误信息')

  console.log('✓ comfyui 集成测试通过')
  console.log('  探活 / 自动工作流+LoRA+轮询+取图+落盘 / 占位符注入 / 自动识别注入 / 连不上报错')
} finally {
  mock.server.close()
}
