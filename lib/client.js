/**
 * dsh-draw — CLIENT half（浏览器半边）
 *
 * 加载器格式：`window.__ModuleLoader__.load({ id, factory })`。
 * 这个文件不是 ESM——它是 DSH 客户端模块系统的 CJS 懒加载单元：
 * 执行时只登记工厂，模块体（含 CSS 注入）在首次 require 时才真正运行。
 *
 * 与宿主半边的通信走 HTTP：
 *   POST /dsh-draw/api       出图
 *   GET  /dsh-draw/img/<id>  图片字节（<img src> 直接用）
 *
 * 界面：侧边栏一个画笔图标 + 一个整页主面板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-draw-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var el = React.createElement

    /** 宿主半边挂的接口路径（与 lib/index.js 保持一致）。 */
    var API = '/dsh-draw/api'
    var STYLE_ID = 'dsh-draw-style'

    /** 画风词：放在提示词最前面，权重最高（实测放结尾会被稀释成 3D 写实风）。 */
    var CHIBI = 'flat 2D anime illustration, chibi, super deformed, big head small body, thick black outlines, flat cel shading, sticker art, large expressive eyes, blush, '
    var NORMAL = '2D Japanese anime illustration, clean line art, soft cel shading, detailed, anime screencap quality, '
    var WHITE_BG = ', pure white background'

    var SIZES = {
      '1:1': { width: 1024, height: 1024 },
      '3:4': { width: 768, height: 1024 },
      '16:9': { width: 1280, height: 720 },
    }

    var ENGINES = [
      { value: 'pollinations', label: '免费 Pollinations' },
      { value: 'siliconflow', label: '硅基流动' },
      { value: 'custom', label: '自定义接口' },
    ]

    var FREE_MODELS = [
      { value: 'turbo', label: 'Turbo（二次元）' },
      { value: 'flux', label: 'FLUX（写实）' },
    ]

    var DEFAULTS = {
      pollinations: { model: 'turbo', baseUrl: '' },
      siliconflow: { model: 'Kwai-Kolors/Kolors', baseUrl: 'https://api.siliconflow.cn/v1' },
      custom: { model: '', baseUrl: '' },
    }

    var KEY_HINT = 'sk-...（留空则读取工作区的 .dsh-draw-key.txt）'

    var CSS = [
      '.dd-wrap { box-sizing: border-box; min-height: 100%; padding: 22px 24px 40px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); overflow-y: auto; }',
      '.dd-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }',
      '.dd-title { font-size: 17px; font-weight: 600; }',
      '.dd-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dd-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }',
      '.dd-ta { width: 100%; box-sizing: border-box; min-height: 88px; resize: vertical; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; font: inherit; line-height: 1.6; outline: none; }',
      '.dd-ta:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.dd-ta-sm { min-height: 58px; font-size: 12.5px; }',
      '.dd-inp { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 13px; outline: none; }',
      '.dd-inp:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.dd-inp-key { font-family: ui-monospace, Consolas, monospace; letter-spacing: .04em; }',
      '.dd-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.dd-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dd-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
      '.dd-seg { display: inline-flex; gap: 3px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 3px; flex-wrap: wrap; }',
      '.dd-seg-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 5px 13px; border-radius: 7px; cursor: pointer; font: inherit; font-size: 13px; }',
      '.dd-seg-btn.is-on { background: var(--dsw-alias-brand-primary); color: #fff; }',
      '.dd-btn { border: 0; border-radius: 9px; padding: 9px 22px; font: inherit; font-size: 14px; cursor: pointer; background: var(--dsw-alias-brand-primary); color: #fff; text-decoration: none; display: inline-block; }',
      '.dd-btn:disabled { opacity: .55; cursor: default; }',
      '.dd-ghost { background: transparent; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }',
      '.dd-push { margin-left: auto; }',
      '.dd-tiny { font-size: 12px; }',
      '.dd-link { color: var(--dsw-alias-brand-primary); cursor: pointer; }',
      '.dd-hint { color: var(--dsw-alias-label-secondary); }',
      '.dd-warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }',
      '.dd-adv { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 10px; }',
      '.dd-mono { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); word-break: break-word; }',
      '.dd-result { align-items: flex-start; }',
      '.dd-wait { font-size: 13px; color: var(--dsw-alias-label-secondary); padding: 16px 0; }',
      '.dd-err { font-size: 13px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; }',
      '.dd-img { max-width: 100%; max-height: 60vh; border-radius: 10px; display: block; border: 1px solid var(--dsw-alias-border-l1); }',
      '.dd-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 10px; }',
      '.dd-hist { display: flex; gap: 8px; flex-wrap: wrap; }',
      '.dd-thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; cursor: pointer; border: 2px solid transparent; }',
      '.dd-thumb.is-on { border-color: var(--dsw-alias-brand-primary); }',
    ].join('\n')

    /** 幂等注入样式表。 */
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.getElementById(STYLE_ID)) return
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch (error) { /* 样式失败不影响功能 */ }
    }

    /** 调宿主出图接口。 */
    function apiCall(payload) {
      return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (response) {
        return response.json()
      })
    }

    /** 每秒回调；优先用宿主 timer 服务，没有就退回 setInterval。 */
    function everySecond(callback) {
      if (timerService && typeof timerService.interval === 'function') {
        return timerService.interval(callback, 1000)
      }
      var handle = setInterval(callback, 1000)
      return function () { clearInterval(handle) }
    }

    var timerService = null

    /** 分段选择器。 */
    function seg(options, value, onPick) {
      return el('div', { className: 'dd-seg' }, options.map(function (option) {
        return el('button', {
          key: option.value,
          type: 'button',
          className: 'dd-seg-btn' + (option.value === value ? ' is-on' : ''),
          onClick: function () { onPick(option.value) },
        }, option.label)
      }))
    }

    function Panel() {
      var promptState = React.useState('')
      var prompt = promptState[0]
      var setPrompt = promptState[1]

      var characterState = React.useState('')
      var character = characterState[0]
      var setCharacter = characterState[1]

      var styleState = React.useState('chibi')
      var style = styleState[0]
      var setStyle = styleState[1]

      var sizeState = React.useState('1:1')
      var sizeKey = sizeState[0]
      var setSizeKey = sizeState[1]

      var engineState = React.useState('pollinations')
      var engine = engineState[0]
      var setEngine = engineState[1]

      var modelState = React.useState(DEFAULTS.pollinations.model)
      var model = modelState[0]
      var setModel = modelState[1]

      var baseUrlState = React.useState(DEFAULTS.pollinations.baseUrl)
      var baseUrl = baseUrlState[0]
      var setBaseUrl = baseUrlState[1]

      var apiKeyState = React.useState('')
      var apiKey = apiKeyState[0]
      var setApiKey = apiKeyState[1]

      var translateState = React.useState(true)
      var translate = translateState[0]
      var setTranslate = translateState[1]

      var whiteState = React.useState(true)
      var white = whiteState[0]
      var setWhite = whiteState[1]

      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var elapsedState = React.useState(0)
      var elapsed = elapsedState[0]
      var setElapsed = elapsedState[1]

      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var currentState = React.useState(null)
      var current = currentState[0]
      var setCurrent = currentState[1]

      var historyState = React.useState([])
      var history = historyState[0]
      var setHistory = historyState[1]

      var chibiState = React.useState(CHIBI)
      var chibiPrefix = chibiState[0]
      var setChibiPrefix = chibiState[1]

      var normalState = React.useState(NORMAL)
      var normalPrefix = normalState[0]
      var setNormalPrefix = normalState[1]

      var advancedState = React.useState(false)
      var advanced = advancedState[0]
      var setAdvanced = advancedState[1]

      var outDirState = React.useState('')
      var outDir = outDirState[0]
      var setOutDir = outDirState[1]

      var dirHintState = React.useState('')
      var dirHint = dirHintState[0]
      var setDirHint = dirHintState[1]

      // 打开面板时读一次当前设置（记住的保存位置 / 默认位置）
      React.useEffect(function () {
        apiCall({ action: 'config' }).then(function (result) {
          if (!result || result.ok !== true) return
          setOutDir(String(result.outDir || ''))
          setDirHint('默认 ' + String(result.defaultOutDir || '')
            + (result.resolvedOutDir ? ' · 当前实际保存到 ' + String(result.resolvedOutDir) : ''))
        }).catch(function () { /* 读不到就用默认 */ })
      }, [])

      React.useEffect(function () {
        if (!busy) return undefined
        setElapsed(0)
        return everySecond(function () { setElapsed(function (value) { return value + 1 }) })
      }, [busy])

      function pickEngine(next) {
        setEngine(next)
        setModel(DEFAULTS[next].model)
        setBaseUrl(DEFAULTS[next].baseUrl)
        setTranslate(next === 'pollinations')
      }

      function generate() {
        if (busy) return
        var text = prompt.trim()
        if (!text) {
          setError('先写一句提示词')
          return
        }
        var dims = SIZES[sizeKey]
        setBusy(true)
        setError('')
        apiCall({
          engine: engine,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          subject: character.trim(),
          text: text,
          prefix: style === 'chibi' ? chibiPrefix : normalPrefix,
          background: white ? WHITE_BG : '',
          translate: translate,
          width: dims.width,
          height: dims.height,
          negative: '',
          outDir: outDir,
        }).then(function (result) {
          if (!result || result.ok !== true) {
            setError(String((result && result.error) || '生成失败'))
            return
          }
          if (result.outDir) setDirHint('当前实际保存到 ' + String(result.outDir))
          var item = {
            url: String(result.url),
            path: String(result.path || ''),
            bytes: Number(result.bytes) || 0,
            ms: Number(result.ms) || 0,
            prompt: text,
            translated: String(result.translated || ''),
            translateFailed: result.translateFailed === true,
            attempts: Number(result.attempts) || 1,
            style: style,
            size: sizeKey,
            model: engine === 'pollinations' ? model : engine + ':' + model,
          }
          setCurrent(item)
          setHistory(function (list) { return [item].concat(list).slice(0, 12) })
        }).catch(function (failure) {
          setError('调用失败：' + String((failure && failure.message) || failure))
        }).then(function () {
          setBusy(false)
        })
      }

      var prefix = style === 'chibi' ? chibiPrefix : normalPrefix
      var preview = prompt.trim()
        ? prefix + (character.trim() ? character.trim() + ', ' : '') + prompt.trim() + (white ? WHITE_BG : '')
        : ''

      var rows = []

      rows.push(el('div', { className: 'dd-head', key: 'head' },
        el('div', { className: 'dd-title' }, '画图'),
        el('div', { className: 'dd-sub' }, '多引擎可选 · 自带 Key 或使用免费引擎')))

      var editor = [
        el('textarea', {
          key: 'prompt',
          className: 'dd-ta',
          placeholder: '描述你想画的画面，例如：坐在桌前打游戏，回头惊讶地看着镜头',
          value: prompt,
          onChange: function (event) { setPrompt(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) generate()
          },
        }),
        el('div', { className: 'dd-row', key: 'character' },
          el('span', { className: 'dd-label' }, '固定角色'),
          el('input', {
            className: 'dd-inp dd-push',
            placeholder: '可留空。例：蓝发长发的鲸鱼女仆娘，白色蕾丝女仆装，鲸鱼尾巴（每张都会带上）',
            value: character,
            onChange: function (event) { setCharacter(event.target.value) },
          })),
        el('div', { className: 'dd-row', key: 'outdir' },
          el('span', { className: 'dd-label' }, '保存到'),
          el('input', {
            className: 'dd-inp dd-push',
            placeholder: '留空 = 默认目录；可填绝对路径（如 D:\\pics\\draw），相对路径按 DSH_HOME 解析',
            value: outDir,
            onChange: function (event) { setOutDir(event.target.value) },
          })),
        dirHint ? el('div', { className: 'dd-mono', key: 'dirhint' }, dirHint) : null,
        el('div', { className: 'dd-row', key: 'style' },
          el('span', { className: 'dd-label' }, '画风'),
          seg([{ value: 'chibi', label: 'Q版' }, { value: 'normal', label: '正常' }], style, setStyle),
          el('span', { className: 'dd-label' }, '尺寸'),
          seg(Object.keys(SIZES).map(function (key) { return { value: key, label: key } }), sizeKey, setSizeKey),
          el('button', {
            key: 'go',
            className: 'dd-btn dd-push',
            type: 'button',
            disabled: busy,
            onClick: generate,
          }, busy ? '生成中 ' + elapsed + 's' : '生成')),
      ]
      rows.push(el('div', { className: 'dd-card', key: 'editor' }, editor))

      var engineRows = [
        el('div', { className: 'dd-row', key: 'engine' },
          el('span', { className: 'dd-label' }, '引擎'),
          seg(ENGINES, engine, pickEngine)),
      ]

      if (engine === 'pollinations') {
        engineRows.push(el('div', { className: 'dd-row', key: 'freemodel' },
          el('span', { className: 'dd-label' }, '模型'),
          seg(FREE_MODELS, model, setModel),
          el('span', { className: 'dd-hint' }, '免费、无需 Key；偶发限流会自动重试')))
      } else {
        engineRows.push(el('div', { className: 'dd-row', key: 'key' },
          el('span', { className: 'dd-label' }, 'API Key'),
          el('input', {
            className: 'dd-inp dd-inp-key dd-push',
            type: 'password',
            placeholder: KEY_HINT,
            value: apiKey,
            onChange: function (event) { setApiKey(event.target.value) },
          })))

        if (engine === 'custom') {
          engineRows.push(el('div', { className: 'dd-row', key: 'baseurl' },
            el('span', { className: 'dd-label' }, '接口地址'),
            el('input', {
              className: 'dd-inp dd-push',
              placeholder: 'https://api.openai.com/v1（只填到 /v1，后面自动补 /images/generations）',
              value: baseUrl,
              onChange: function (event) { setBaseUrl(event.target.value) },
            })))
        }

        engineRows.push(el('div', { className: 'dd-row', key: 'modelname' },
          el('span', { className: 'dd-label' }, '模型名'),
          el('input', {
            className: 'dd-inp dd-push',
            placeholder: engine === 'siliconflow' ? 'Kwai-Kolors/Kolors' : 'dall-e-3 / 厂商模型 id',
            value: model,
            onChange: function (event) { setModel(event.target.value) },
          })))
      }

      if (engine === 'siliconflow') {
        engineRows.push(el('div', { className: 'dd-mono', key: 'tip' },
          '常用模型：Kwai-Kolors/Kolors、Tongyi-MAI/Z-Image-Turbo、Qwen/Qwen-Image；免费额度与价格以硅基流动控制台为准'))
      }

      engineRows.push(el('div', { className: 'dd-row dd-tiny', key: 'toggles' },
        el('label', { className: 'dd-check' },
          el('input', { type: 'checkbox', checked: white, onChange: function (event) { setWhite(event.target.checked) } }),
          '纯白背景'),
        el('label', { className: 'dd-check' },
          el('input', { type: 'checkbox', checked: translate, onChange: function (event) { setTranslate(event.target.checked) } }),
          '中文自动译成英文'),
        el('span', { className: 'dd-link', onClick: function () { setAdvanced(!advanced) } }, advanced ? '收起高级设置' : '高级设置')))

      if (advanced) {
        engineRows.push(el('div', { className: 'dd-adv', key: 'adv' },
          el('div', { className: 'dd-label' }, 'Q版 画风词（放提示词最前，权重最高）'),
          el('textarea', { className: 'dd-ta dd-ta-sm', value: chibiPrefix, onChange: function (event) { setChibiPrefix(event.target.value) } }),
          el('div', { className: 'dd-label' }, '正常 画风词（放提示词最前，权重最高）'),
          el('textarea', { className: 'dd-ta dd-ta-sm', value: normalPrefix, onChange: function (event) { setNormalPrefix(event.target.value) } }),
          el('div', { className: 'dd-label' }, '拼好的提示词（中文部分按需翻译）'),
          el('div', { className: 'dd-mono' }, preview || '（先写提示词）')))
      }

      rows.push(el('div', { className: 'dd-card', key: 'enginecard' }, engineRows))

      var resultBody
      if (busy) {
        resultBody = el('div', { className: 'dd-wait' }, '正在画… 已用 ' + elapsed + ' 秒')
      } else if (error) {
        resultBody = el('div', { className: 'dd-err' }, error)
      } else if (current) {
        resultBody = el('div', null,
          el('img', { className: 'dd-img', src: current.url, alt: current.prompt }),
          el('div', { className: 'dd-row dd-meta' },
            el('span', null, (current.style === 'chibi' ? 'Q版' : '正常') + ' · ' + current.size + ' · ' + current.model
              + ' · ' + (current.ms / 1000).toFixed(1) + 's · ' + Math.round(current.bytes / 1024) + 'KB'
              + (current.attempts > 1 ? ' · 重试' + (current.attempts - 1) + '次' : '')),
            el('a', { className: 'dd-btn dd-ghost', href: current.url, target: '_blank', rel: 'noreferrer' }, '新窗口打开'),
            el('button', { className: 'dd-btn dd-ghost', type: 'button', onClick: generate }, '再来一张')),
          el('div', { className: 'dd-mono' }, '已保存：' + current.path),
          current.translated ? el('div', { className: 'dd-mono' }, '实际发送：' + current.translated) : null,
          current.translateFailed ? el('div', { className: 'dd-warn' }, '翻译失败，已直接发原文') : null)
      } else {
        resultBody = el('div', { className: 'dd-wait' }, '还没有图 —— 写句提示词，点「生成」')
      }
      rows.push(el('div', { className: 'dd-card dd-result', key: 'result' }, resultBody))

      if (history.length > 1) {
        rows.push(el('div', { className: 'dd-card', key: 'history' },
          el('div', { className: 'dd-label' }, '本次历史（点缩略图切换主图）'),
          el('div', { className: 'dd-hist' }, history.map(function (item) {
            return el('img', {
              key: item.url,
              className: 'dd-thumb' + (current && current.url === item.url ? ' is-on' : ''),
              src: item.url,
              alt: item.prompt,
              title: item.prompt,
              onClick: function () { setCurrent(item) },
            })
          }))))
      }

      return el('div', { className: 'dd-wrap' }, rows)
    }

    /** 侧边栏图标（画图 = 铅笔）。 */
    function Icon(props) {
      var edge = props && props.size ? props.size : 18
      return el('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        el('path', { d: 'M4 20h4L20 8l-4-4L4 16v4z' }),
        el('path', { d: 'M14 6l4 4' }))
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined || typeof slots.register !== 'function') return
      timerService = ctx.get('timer') || null
      ensureStyles()

      slots.inject('sidebar.panellist', function () {
        return slots.register({ name: 'sidebar.panellist', id: 'dsh-draw', label: '画图', order: 60 }, Icon)
      })
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: 'dsh-draw' }, Panel)
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
