// settings.js —— 设置中心：`<root>/settings.json` 是面板能改的那份配置。
//
// 三条口径：
// 1. DEFAULTS 就是现在的行为：没有 settings.json 时 mergeConfig 出来的 cfg 与以前等价。
// 2. SCHEMA 是唯一规则表：面板只按 schema 渲染，服务端只按 schema 校验，两边都不写死。
// 3. 写盘原子（tmp → rename）且尽力 0600；Windows 不保留 POSIX 位，读回可能是 0666。
//
// 只做「容器与开关」：工具收窄这类行为留给后面的模块接；B 站登录状态走 `/bili` 与
// `owner.json`，不进 settings.json（cookie 不落在面板可写的文件里）。
import fs from 'node:fs'
import path from 'node:path'

export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_MODE = 0o600

export const DEFAULTS = {
  tools: { narrow: false, allow: 'hers' }, // hers | hers+files | all
  persona: { attach: true, guard: true },
  dual: { enabled: false, mode: 'A' },
  nightly: { auto: true, localModel: false },
  panel: { affinity: true, reveal: true },
  home: { auto: true },
  // 客厅：同一条家会话里让派希丝和普通鱼一起说话；默认关，开了要重启。
  room: { enabled: false, autoAbsorb: false },
  // 表情包：她可以发一张图。内置包只有占位图，用户把素材放进 <root>/memes/<包>/ 就能换。
  meme: { enabled: true },
  bili: { speak: false }, // 登录态在 owner.json（/bili），这里只留说话开关
  console: { enabled: true },
  // 隐藏项：语音回复总开关。默认允许，但没适配器时完全无效果；不进 SCHEMA。
  voice: { enabled: true },
}

/**
 * 每项：path / kind(bool|enum|string) / label / hint / options / restart / readOnly。
 * restart:true = 改完要重启插件才生效（这些值在 apply 时被读一次）。
 */
export const SCHEMA = [
  {
    path: 'tools.narrow',
    kind: 'bool',
    label: '工具收窄',
    hint: '只让她看见自己的工具，别的会话不受影响',
    restart: true,
  },
  {
    path: 'tools.allow',
    kind: 'enum',
    label: '工具范围',
    hint: '收窄时留下哪些：只她的 / 她加文件 / 全部',
    options: [
      { value: 'hers', label: '只她的工具' },
      { value: 'hers+files', label: '她的工具 + 文件' },
      { value: 'all', label: '全部' },
    ],
    restart: true,
  },
  {
    path: 'persona.attach',
    kind: 'bool',
    label: '提示词桥',
    hint: '只在她屋里那条会话挂上她的人设段',
    restart: true,
  },
  {
    path: 'dual.enabled',
    kind: 'bool',
    label: '双流',
    hint: '同一句话先算一遍再答（多一次模型调用）',
    restart: true,
  },
  {
    path: 'dual.mode',
    kind: 'enum',
    label: '双流档位',
    hint: 'A 暗栏多一次暗中重写（更圆、更长）；B 顺序先算约束再写（少一层重写，更直接）。只有双流开着才有用。',
    options: [
      { value: 'A', label: 'A 档（暗栏）：先暗中算一遍再重写，话更圆更长' },
      { value: 'B', label: 'B 档（顺序）：先算约束再写，少一层重写，更直接' },
    ],
    restart: true,
  },
  {
    path: 'nightly.auto',
    kind: 'bool',
    label: '夜间自动整理',
    hint: '到点了自己跑归因、做梦、核实、自学',
    restart: true,
  },
  {
    path: 'nightly.localModel',
    kind: 'bool',
    label: '夜间用本地模型',
    hint: '没装 ollama 时别打开；关着只用规则',
    restart: true,
  },
  {
    path: 'panel.affinity',
    kind: 'bool',
    label: '面板显示好感',
    hint: '状态页里的好感读数；关掉就不显示',
    restart: false,
  },
  {
    path: 'panel.reveal',
    kind: 'bool',
    label: '面板渐进揭开',
    hint: '成年鱼的数字聊深了才给',
    restart: false,
  },
  {
    path: 'home.auto',
    kind: 'bool',
    label: '自动建家',
    hint: '领养后在侧栏建一个工作区和一条会话',
    restart: true,
  },
  {
    path: 'room.enabled',
    kind: 'bool',
    label: '客厅（实验）',
    hint: '同一条家会话里让派希丝和普通鱼一起说话；开局三选项选 3 才用；改了要重启',
    restart: true,
  },
  {
    path: 'room.autoAbsorb',
    kind: 'bool',
    label: '客厅自动吸收',
    hint: '夜里把客厅记录自动吸进各自的库；默认关，关着就只能用邀请码手动收',
    restart: true,
  },
  {
    path: 'meme.enabled',
    kind: 'bool',
    label: '表情包',
    hint: '允许她发一张表情；素材放 <数据目录>/memes/<包>/，内置包只有占位图',
    restart: true,
  },
  {
    path: 'bili.speak',
    kind: 'bool',
    label: 'B 站说话',
    hint: '允许她在 B 站视频下面说一句',
    restart: true,
  },
  {
    path: 'console.enabled',
    kind: 'bool',
    label: '观测台',
    hint: '在 /dsh-pisces-api 给面板提供数据',
    restart: true,
  },
]

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings))
}

function optionValues(spec) {
  return (spec.options || []).map((o) => (isPlainObject(o) ? o.value : o)).map(String)
}

export function settingsPath(root) {
  return path.join(String(root ?? ''), SETTINGS_FILE)
}

/**
 * 读设置：缺失、坏 JSON、不是对象都回一份 DEFAULTS 的深拷贝。
 * 手改坏的类型/未知枚举值也回退默认（写入口会校验，读入口不能让坏值进 cfg）。
 */
export function readSettings(root) {
  const settings = cloneSettings(DEFAULTS)
  let raw
  try {
    const text = fs.readFileSync(settingsPath(root), 'utf8').replace(/^\uFEFF/, '')
    raw = JSON.parse(text)
  } catch {
    return settings
  }
  if (!isPlainObject(raw)) return settings

  const byPath = new Map(SCHEMA.map((spec) => [spec.path, spec]))
  // 遍历 DEFAULTS 而不是 SCHEMA：persona.guard 是隐藏项（schema 不列），
  // 但手改 settings.json 仍然能把它关掉，启动时 mergeConfig 也还得读它。
  for (const [group, def] of Object.entries(DEFAULTS)) {
    const g = raw[group]
    if (!isPlainObject(g)) continue
    for (const key of Object.keys(def)) {
      if (!(key in g)) continue
      const v = g[key]
      const spec = byPath.get(`${group}.${key}`)
      if (spec?.readOnly) {
        // 登录状态可以由别处落盘（扫码后续接），读的时候认这两个值。
        if (v === 'idle' || v === 'logged-in') settings[group][key] = v
        continue
      }
      if (typeof v !== typeof def[key]) continue
      if (spec?.kind === 'enum' && !optionValues(spec).includes(v)) continue
      settings[group][key] = v
    }
  }
  return settings
}

/**
 * 对接口公开的那份：隐藏项不列也不回值。
 * persona.guard 与 voice 都只在文件/宿主 config 里生效，面板和 GET /settings 都看不到。
 */
export function publicSettings(settings) {
  const out = cloneSettings(settings)
  delete out.persona.guard
  delete out.voice
  return out
}

/** 原子写：tmp → rename，tmp 用 0600 建；失败清掉 tmp 再抛。 */
function persist(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = `${JSON.stringify(settings, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: SETTINGS_MODE })
    try {
      fs.chmodSync(tmp, SETTINGS_MODE)
    } catch {
      /* Windows 不保留 POSIX 位，尽力而为 */
    }
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, SETTINGS_MODE)
    } catch {
      /* 同上 */
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 没有 tmp 可清就算了 */
    }
    throw e
  }
}

/** 把 patch 摊成 [path, value]；同时接受嵌套 `{tools:{narrow:true}}` 和扁平的 `{'tools.narrow':true}`。 */
function entriesOf(patch, issues) {
  const out = []
  for (const [key, val] of Object.entries(patch)) {
    if (key.includes('.')) {
      out.push([key, val])
      continue
    }
    if (!isPlainObject(val)) {
      issues.push(`没有这个设置项：${key}`)
      continue
    }
    for (const [k, v] of Object.entries(val)) out.push([`${key}.${k}`, v])
  }
  return out
}

function checkValue(spec, value) {
  if (spec.kind === 'bool') return value === true || value === false ? null : '只能是 true / false'
  if (spec.kind === 'enum') {
    return optionValues(spec).includes(String(value)) ? null : `只能是 ${optionValues(spec).join(' / ')}`
  }
  if (spec.kind === 'string') return typeof value === 'string' ? null : '只能是字符串'
  return '这个设置项没有可接受的类型'
}

/**
 * 写设置：先校验全部，再浅合并到已有文件（缺的值保持原样），最后原子写。
 * @returns {{ok:true, settings:object, changed:string[], needsRestart:string[], ignored?:string[], note?:string}
 *   | {ok:false, reason:string, problems:string[], settings:object, changed:[], needsRestart:[]}}
 */
export function writeSettings(root, patch) {
  const file = settingsPath(root)
  const current = readSettings(root)
  if (!isPlainObject(patch)) {
    return { ok: false, reason: 'patch 要是一个对象', problems: ['patch 要是一个对象'], settings: current, changed: [], needsRestart: [] }
  }

  const known = new Map(SCHEMA.map((spec) => [spec.path, spec]))
  const issues = []
  const values = new Map()
  const ignored = []
  for (const [p, value] of entriesOf(patch, issues)) {
    const spec = known.get(p)
    if (!spec) {
      // 隐藏项：收到就静默丢弃（不落盘、不报错、也不回提示）。
      if (p === 'persona.guard') continue
      issues.push(`没有这个设置项：${p}`)
      continue
    }
    if (spec.readOnly) {
      ignored.push(p)
      continue
    }
    const problem = checkValue(spec, value)
    if (problem) issues.push(`${p}：${problem}`)
    else values.set(p, spec.kind === 'enum' ? String(value) : value)
  }
  if (issues.length) {
    return { ok: false, reason: issues.join('；'), problems: issues, settings: current, changed: [], needsRestart: [] }
  }

  const changed = []
  for (const [p, value] of values) {
    const [group, key] = p.split('.')
    if (current[group][key] !== value) changed.push(p)
    current[group][key] = value
  }

  if (values.size === 0) {
    const out = { ok: true, settings: current, changed: [], needsRestart: [] }
    if (ignored.length) {
      out.ignored = ignored
      out.note = 'B 站登录状态只读，面板不写'
    }
    return out
  }

  try {
    persist(file, current)
  } catch (e) {
    return {
      ok: false,
      reason: `写不进去：${String(e?.message ?? e).slice(0, 120)}`,
      problems: [],
      settings: readSettings(root),
      changed: [],
      needsRestart: [],
    }
  }

  const changedSet = new Set(changed)
  // 按 SCHEMA 顺序给，面板/测试不用猜对象键序。
  const needsRestart = SCHEMA.filter((spec) => spec.restart && changedSet.has(spec.path)).map((spec) => spec.path)
  const out = { ok: true, settings: current, changed, needsRestart }
  if (ignored.length) {
    out.ignored = ignored
    out.note = 'B 站登录状态只读，面板不写'
  }
  return out
}

/**
 * 启动期合并：DEFAULTS ← settings ← 宿主 config（逐键，宿主优先）。
 * 宿主 config 里 DEFAULTS 没有的键原样保留；`tools:false` 这类非对象逃生口也原样保留。
 */
export function mergeConfig(config, settings) {
  const host = isPlainObject(config) ? config : {}
  const st = isPlainObject(settings) ? settings : {}
  const out = { ...host }
  for (const [group, def] of Object.entries(DEFAULTS)) {
    const hv = host[group]
    if (hv !== undefined && !isPlainObject(hv)) {
      out[group] = hv
      continue
    }
    const merged = { ...def }
    const sv = st[group]
    if (isPlainObject(sv)) {
      for (const key of Object.keys(def)) {
        if (sv[key] !== undefined) merged[key] = sv[key]
      }
    }
    if (isPlainObject(hv)) {
      for (const [key, value] of Object.entries(hv)) merged[key] = value
    }
    out[group] = merged
  }
  return out
}
