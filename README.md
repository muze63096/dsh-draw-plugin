# dsh-draw-plugin

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的画图插件：侧边栏多一个「画图」面板，写句提示词就出图，Q版/正常两档画风，三个出图引擎随便挑。

**零运行时依赖，不需要构建**——宿主半边是普通 ESM，客户端半边是加载器直接可用的 CJS 单元。

---

## 长什么样

左侧边栏底部多一个铅笔图标「画图」，点开是一个整页面板：

```
┌ 画图 ─────────────────────────────────────────┐
│ 提示词  [ 坐在桌前打游戏，回头惊讶地看着镜头 ] │
│ 固定角色[ 蓝发鲸鱼女仆娘，白色蕾丝女仆装…    ] │
│ 画风  (●)Q版 ( )正常   尺寸 [1:1][3:4][16:9]  │
│                                     [ 生成 ]  │
├───────────────────────────────────────────────┤
│ 引擎  (●)免费 Pollinations ( )硅基流动 ( )自定义│
│ 模型  (●)Turbo ( )FLUX                        │
│ ☑纯白背景  ☑中文自动译成英文   高级设置        │
├───────────────────────────────────────────────┤
│            ┌────────────┐                     │
│            │   出图预览  │                     │
│            └────────────┘                     │
│  [新窗口打开] [再来一张]   已保存：<路径>      │
├───────────────────────────────────────────────┤
│ 本次历史  ▢ ▢ ▢ ▢                             │
└───────────────────────────────────────────────┘
```

> 截图占位：欢迎 PR 补一张 `docs/screenshot.png`。

---

## 特性

- **三个引擎可选**，Key 由使用者自己填：免费 Pollinations（无需 Key）／硅基流动（Kolors 等）／任意 OpenAI 兼容的 `/images/generations` 端点。
- **Q版 / 正常两档画风**，画风词**前置**（实测：放句尾会被稀释成 3D 写实风）。
- **中文提示词自动译成英文**（可关）。实测免费引擎吃到中文会整体切到写实路线并丢掉画风词，所以默认开启翻译，并会把你**实际发送的提示词**显示出来。
- **限流自动重试**：免费引擎的 402/429/500 会退避重试 4 次，不是一撞就死。
- **按真实格式落盘**：引擎返回什么类型就存什么后缀（`.jpg`/`.png`/`.webp`），`Content-Type` 也如实返回。
- **历史缩略图**、真实耗时/体积、一键新窗口打开。
- **自定义保存位置**：面板「保存到」直接填（默认 `$DSH_HOME/dsh-draw`），**填过就记住**；行配置也能改默认值。
- **不写死任何路径**：脚本、设置、Key 文件都在 `$DSH_HOME`，出图目录由使用者指定。

---

## 安装

```bash
# 从 npm（发布之后）
dsh plugin --profile web add dsh-draw-plugin

# 从本地目录 / GitHub clone / 解压的 ZIP：注意 -w 不能省
dsh plugin --profile web add -w "D:\path\to\dsh-draw-plugin"
```

> **`-w` 是必须的。** profile 目录本身就是 pnpm 的 workspace root，不加 `-w` 会报
> `ERR_PNPM_ADDING_TO_ROOT`。（`-w` 只是 pnpm 的 `--workspace-root` 缩写，不会改变装到哪个 profile。）

`dsh plugin … add` 会通过包自带的 `dsh.bundle.patch` 自动挂载插件行，**不需要手动改 profile**。

然后**重启 DSH 的 web app**（客户端 bundle 在启动时组图）。

<details>
<summary>手动安装（不走 dsh plugin）</summary>

把包目录放进 `$DSH_HOME/profiles/<profile>/node_modules/`，并确保该 profile 的 `cordis.patch.yml` 里有：

```yaml
- insert:
    - id: dsh-draw
      name: 'dsh-draw-plugin'
      inject: [fs, shell, webServer]
      config:
        outDir: 'dsh-draw'
```

`inject` 不能少——少了它，`apply` 可能在 `fs`/`shell`/`webServer` 就绪之前跑，路由注册不上。
</details>

---

## 使用

1. 点侧边栏的铅笔图标「画图」。
2. **免费引擎开箱可用**，不需要任何配置：写提示词 → 点生成。
3. 要用别的引擎：切到「硅基流动」或「自定义接口」，填 API Key。
   - Key 也可以放到工作区的 `.dsh-draw-key.txt`，面板里就不用每次填。
4. 「固定角色」里写一段固定描述（如某个角色的外形），每张图都会带上——适合反复画同一个角色。

---

## 引擎

| 引擎 | 需要 Key | 默认端点 | 常用模型 |
| --- | --- | --- | --- |
| **免费 Pollinations** | 否 | `image.pollinations.ai` | `turbo`（二次元更好）、`flux`（写实更好） |
| **硅基流动** | 是 | `https://api.siliconflow.cn/v1` | `Kwai-Kolors/Kolors`、`Tongyi-MAI/Z-Image-Turbo`、`Qwen/Qwen-Image` |
| **自定义接口** | 是 | 你自己填 | 任何 OpenAI 兼容的 `/images/generations` 模型（`dall-e-3` 等） |

Key 在硅基流动控制台创建（[siliconflow.cn](https://siliconflow.cn)）。**它和 DeepSeek 的 API Key 是两家公司、两套余额**，互不通用。

自定义接口会**先发 `image_size`**（硅基流动的写法），若对方返回 400/422 再**自动改用 `size`**（OpenAI 的写法）重发；返回体里的 `url` 和 `b64_json` 两种都支持。

---

## 画风：Q版 / 正常

两档各自的「画风词」放在提示词**最前面**，高级设置里可以直接改。默认值：

```text
Q版  ：flat 2D anime illustration, chibi, super deformed, big head small body,
        thick black outlines, flat cel shading, sticker art, large expressive eyes, blush,
正常 ：2D Japanese anime illustration, clean line art, soft cel shading, detailed,
        anime screencap quality,
```

实测经验（都用免费引擎跑过）：

- **Q版能压住 2D**：`chibi` / `super deformed` 这类超变形词足够强。
- **正常档会滑向 3D/CG**：正常比例的角色，免费模型的引力井就是"漂亮 3D 二次元"，换 4 套强制 2D 的措辞也压不住。想要贴合 2D 插画风格，**换硅基流动的 Kolors**。
- **场景词越多越写实**：`坐在堆满泡面的房间里` 这类具体场景会把画面拉向写实；只写角色 + 白底最容易保住 2D。
- 免费引擎**没有**二次元专用模型（`flux-anime` / `flux-pro` / `anime` 都是无效名，服务端会静默回退）。
- 不要给 Pollinations 加 `negative_prompt`：实测会让服务端把不同模型的请求返回成**同一张图**。

---

## 保存位置

面板上的「保存到」输入框就是它，**填过就记住**（存在 `$DSH_HOME/dsh-draw.config.json`）：

| 你填的 | 结果 |
| --- | --- |
| 留空 | `$DSH_HOME/dsh-draw` |
| `my-pics` | `$DSH_HOME/my-pics`（相对路径按 `$DSH_HOME` 解析） |
| `D:\pics\draw` | 原样使用（绝对路径） |
| `~/pics` | 家目录下的 `pics` |

> 生成时会把该目录的**父目录**作为本次的 workspace-write 边界，所以自定义到别处也能落盘（沙箱只在写盘时按边界校验）。

行配置（`cordis.patch.yml` 里的 `config:`）改的是**默认值**（面板里还没设过时生效）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `outDir` | 空 | 默认保存位置，留空 = `$DSH_HOME/dsh-draw`。 |

---

## 文件落在哪

| 位置 | 文件 | 说明 |
| --- | --- | --- |
| 保存目录（默认 `$DSH_HOME/dsh-draw`） | `img-<seed>-<ts>.jpg` | 生成的图片（后缀随真实格式） |
| `$DSH_HOME` | `.dsh-draw-gen.mjs` | 生成脚本。无依赖、可直接读；出网、重试、落盘都在它里面 |
| `$DSH_HOME` | `dsh-draw.config.json` | 记住的保存位置 |
| `$DSH_HOME` | `.dsh-draw-key.txt` | *可选*，你自己创建。面板没填 Key 时从这里读 |
| `$DSH_HOME` | `.dsh-draw-init-error.txt` | *仅在初始化失败时出现*，内容是失败原因 |

`$DSH_HOME` 默认是 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。

---

## 常见问题

**一直报 `HTTP 402` / 429？**
免费引擎的限流很紧（上游有每分钟额度）。插件已经自动退避重试 4 次，还是失败就隔半分钟再点一次。想稳定出图就换硅基流动。

**出来的图是写实照片，不是我写的画风？**
两种原因：中文提示词没翻译（检查「中文自动译成英文」是否勾上，生成结果下方会显示"实际发送"的提示词），或者提示词里场景描述压过了画风词。

**图存哪了？想换地方？**
看面板「保存到」下面那行灰字——它显示的是**实际落盘目录**。要换就在输入框里填，下次生成即生效，并且会被记住。

**面板不出现 / 点了没反应？**
1. 看工作区有没有 `.dsh-draw-init-error.txt`，里面有失败原因；
2. 确认 `cordis.patch.yml` 里的 `inject` 写了 `fs`/`shell`/`webServer`；
3. 装完**必须重启** web app。

**为什么要写一个 `.mjs` 脚本再跑，宿主不直接请求？**
宿主运行在受限求值环境里没有 `fetch`；而 Windows 沙箱下 `curl`、PowerShell 的 `.NET` 走的是系统 TLS（schannel），会被拒绝并报 `SEC_E_NO_CREDENTIALS`。Node 自带 OpenSSL，出网正常。所以出网这件事交给 Node 脚本做。

**Key 会被写进文件吗？**
不会。面板里填的 Key 只存在浏览器内存里，随请求以 **stdin** 传给子进程（不进命令行、不出现在进程列表），用完即弃。只有你自己创建 `.dsh-draw-key.txt` 时它才在磁盘上。

---

## 安全与隐私

- 出图请求由**服务器直连**你选的引擎，提示词会发送给该第三方（Pollinations / 硅基流动 / 你自定义的端点）。
- `/dsh-draw/api` 与 `/dsh-draw/img/*` **没有鉴权**，只应暴露在本机（DSH 默认监听 `127.0.0.1`）。若你把 DSH 暴露到公网，请自行加访问控制——否则任何人都能用你的 Key 出图、也能读到本次进程内缓存的图片。
- 图片只缓存在内存里（最多 24 张）供页面显示；进程重启即失效，但**磁盘上的图不会被删**。

---

## 开发

```
dsh-draw-plugin/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 挂载行（inject + config）
├── lib/
│   ├── index.js          # 宿主半边（ESM）：写脚本、跑脚本、挂路由、翻译
│   └── client.js         # 客户端半边：__ModuleLoader__ 封装 + 面板 UI
├── test/smoke.mjs        # 冒烟测试：stub 掉服务，验证初始化与两个路由
└── LICENSE
```

```bash
npm run check   # 语法检查
node test/smoke.mjs
```

改画风词不用改代码——面板「高级设置」里当场就能改。

---

## English

A text-to-image panel plugin for **DeepSeek Harness**. Adds a brush icon to the sidebar and a
full-page panel: type a prompt, pick a style (chibi / normal), pick an engine
(free Pollinations / SiliconFlow Kolors / any OpenAI-compatible endpoint), and the image is
generated, saved to your workspace and shown inline.

- Zero runtime dependencies, no build step (host half is plain ESM, client half is a
  `window.__ModuleLoader__` CJS unit).
- API keys are supplied by the user, kept in browser memory and passed to the generator
  subprocess on **stdin** — never written to disk unless you create `.dsh-draw-key.txt`.
- Prompts in Chinese are auto-translated to English before being sent to the free engine,
  because that engine silently switches to photorealism when it sees Chinese.

```bash
dsh plugin --profile web add dsh-draw-plugin
# then restart the DSH web app
```

MIT licensed.

---

## License

[MIT](./LICENSE)
