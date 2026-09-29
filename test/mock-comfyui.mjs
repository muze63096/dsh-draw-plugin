/**
 * 假 ComfyUI 服务 —— 只为测试用。
 *
 * 实现了插件真正会调的四个接口：
 *   GET  /object_info      模型 / LoRA / 采样器列表
 *   POST /prompt           排队，返回 prompt_id
 *   GET  /history/<id>     首次返回空（逼出轮询），第二次返回出图记录
 *   GET  /view            返回一张 1x1 PNG
 *
 * 它会把收到的 workflow 存到 state.submitted，供测试断言"提示词/LoRA 有没有真的注入进去"。
 */
import { createServer } from 'node:http'

/** 1x1 透明 PNG。 */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['test-model.safetensors', 'anime-xl.safetensors'], {}] } } },
  LoraLoader: { input: { required: { lora_name: [['style-a.safetensors', 'style-b.safetensors'], {}] } } },
  KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m'], {}] } } },
}

/** 启动一个假 ComfyUI，端口随机。 */
export function startMockComfy() {
  const state = { submitted: null, historyPolls: 0, viewQueries: 0 }
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    if (url.pathname === '/object_info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(OBJECT_INFO))
      return
    }

    if (url.pathname === '/prompt' && req.method === 'POST') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try { state.submitted = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) { state.submitted = null }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: 'test-prompt-1', number: 1 }))
      })
      return
    }

    if (url.pathname === '/history/test-prompt-1') {
      state.historyPolls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 第一次故意返回空，验证插件会继续轮询
      if (state.historyPolls < 2) { res.end('{}'); return }
      res.end(JSON.stringify({
        'test-prompt-1': {
          status: { status_str: 'success', completed: true },
          outputs: { '9': { images: [{ filename: 'dsh-draw_00001_.png', subfolder: '', type: 'output' }] } },
        },
      }))
      return
    }

    if (url.pathname === '/view') {
      state.viewQueries += 1
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(TINY_PNG)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('mock comfyui: no route ' + url.pathname)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state })
    })
  })
}

// 直接运行时：起在固定端口，方便手工 curl 调试
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock-comfyui.mjs')) {
  const { port } = await startMockComfy()
  console.log('mock comfyui on http://127.0.0.1:' + port)
}
