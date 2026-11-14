// 设置页（settings.section）：六个页签的只读面板。
//
// 形态照 dsh-fish / 知识库 n22：纯客户端 bundle，只 require('react')，不打包、不 JSX。
// 注册走宿主现行 API（参考文档 §1.3、app.asar 里的 ui-settings 同形）：
//   ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Panel))
// 插件对象自己声明 inject:['slots']；少了它 fiber 不 active（页面报 1 entry did not activate）。
//
// 这一份只回答"她现在是什么样"：没有数值输入，不把服务端规则复制到客户端。

window.__ModuleLoader__.load({
  id: 'dsh-pisces-core',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'dsh-pisces'
    const TITLE = '鱼肥生双'
    const ORDER = 70
    const API = '/dsh-pisces-api'
    const FEEDBACK_KEY = 'dsh-pisces.feedback'
    const CSS_TAG = 'dsh-pisces/client.css'
    const EFFECT_LABEL = 'dsh-pisces: settings section'

    const TABS = [
      { id: 'status', label: '状态' },
      { id: 'settings', label: '设置' },
      { id: 'mind', label: '心理活动' },
      { id: 'principle', label: '原理' },
      { id: 'feedback', label: '反馈' },
      { id: 'thanks', label: '鸣谢' },
    ]

    // 观测台 /events 的 type 过滤由服务端做；这里只列"哪些算她说的话"。
    const TALK_TYPES = ['utterance', 'revise', 'reunion', 'narration', 'refusal', 'answer', 'dream_sim']

    const TYPE_NAMES = {
      utterance: '她说',
      revise: '改口',
      reunion: '重逢',
      narration: '自述',
      refusal: '拒绝',
      answer: '回答',
      dream_sim: '梦',
    }

    const ORDER_NAMES = {
      'E=R': '两边都听',
      'R>E': '先算一遍',
      'E>R': '先凭感觉',
      single: '一条线',
      none: '一条线',
    }

    const QUESTION_NAMES = { open: '悬着', answered: '答过', dropped: '放下', observed: '留意过' }

    // -------------------------------------------------------------------------
    // 小工具
    // -------------------------------------------------------------------------

    const two = (n) => String(n).padStart(2, '0')

    function when(ts) {
      const n = Number(ts)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const d = new Date(n)
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
    }

    function age(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '还没整理过'
      const gap = Date.now() - n
      if (gap < 60_000) return '刚刚'
      if (gap < 3_600_000) return `${Math.floor(gap / 60_000)} 分钟前`
      if (gap < 86_400_000) return `${Math.floor(gap / 3_600_000)} 小时前`
      return when(n).slice(0, 10)
    }

    function orderText(order) {
      if (!order) return '一条线'
      return ORDER_NAMES[order] || String(order)
    }

    function typeName(type) {
      return TYPE_NAMES[type] || String(type || '事件')
    }

    async function getJson(path) {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || (data && data.ok === false)) {
        const why = (data && data.error) || `HTTP ${res.status}`
        const hint = res.status === 401 || res.status === 403 ? '（请从应用内的设置页打开）' : ''
        throw new Error(why + hint)
      }
      return data
    }

    async function postJson(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || (data && data.ok === false)) {
        const problems = Array.isArray(data && data.problems) ? data.problems.join('；') : ''
        const why = (data && (data.error || problems)) || `HTTP ${res.status}`
        throw new Error(String(why))
      }
      return data
    }

    // 读 schema 里的两级路径（tools.narrow）→ 当前值；读不到就是 undefined。
    const readPath = (obj, p) =>
      String(p || '')
        .split('.')
        .reduce((v, k) => (v != null && typeof v === 'object' ? v[k] : undefined), obj)

    // textarea → 段：空行和换行都算分隔，去掉空段。
    function splitTexts(raw) {
      return String(raw == null ? '' : raw)
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    }

    // -------------------------------------------------------------------------
    // 样式：只注入一次，类名统一 .dp 前缀
    // -------------------------------------------------------------------------

    const CSS = `
.dp { color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 14px; font-size: 13px; line-height: 19px; }
.dp .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dp h2 { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.dp .sub { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; line-height: 19px; }
.dp .tabs { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: .5px solid var(--dsw-alias-border-l2); padding-bottom: 8px; }
.dp .tab { height: 28px; padding: 0 12px; border-radius: 7px; border: .5px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.dp .tab:hover { background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, .10)); }
.dp .tab.on { background: rgba(128, 128, 128, .18); border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dp .page { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; align-items: start; }
.dp .card { border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.dp .card.full { grid-column: 1 / -1; }
.dp .cardTop { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dp .card h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary); }
.dp .card .right { color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }
.dp .note { margin: 0 0 9px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dp .hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dp .err { margin: 0; color: #e5484d; font-size: 12.5px; line-height: 18px; white-space: pre-wrap; }
.dp .limits { margin: 0 0 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dp .red { margin: 0 0 8px; color: #e5484d; font-size: 12px; }
.dp .biases { display: grid; gap: 4px; margin: 8px 0 4px; }
.dp .opt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dp .opt em { color: var(--dsw-alias-label-tertiary); font-style: normal; font-size: 11.5px; }
.dp .adult { margin-top: 10px; border-top: .5px dashed var(--dsw-alias-border-l2); padding-top: 10px; }
.dp .adultBox { margin: 8px 0 0 22px; }
.dp .stats { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.dp .stat { border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; min-width: 0; }
.dp .stat .k { display: block; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dp .stat b { font-size: 18px; font-weight: 600; line-height: 26px; }
.dp .stat b.small { font-size: 13px; font-weight: 500; }
.dp .stat .u { margin-left: 3px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dp .hearts { color: #e5484d; letter-spacing: 2px; font-size: 15px; }
/* 还没揭开的块：真模糊（不是小字），悬停也不变清晰；提示放在模糊层外面才读得到。 */
.dp .stat .veil { filter: blur(4px); user-select: none; pointer-events: none; }
.dp .stat .veil b.q { font-size: 22px; letter-spacing: 2px; color: var(--dsw-alias-label-tertiary); }
.dp .stat .tip { display: block; margin-top: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 16px; }
.dp .list { list-style: none; margin: 0; padding: 0; }
.dp .list li { padding: 8px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.dp .list li:last-child { border-bottom: 0; padding-bottom: 0; }
.dp .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 17px; }
.dp .tag { display: inline-block; border-radius: 4px; padding: 0 5px; background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, .12)); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dp .tag.warn { color: #b8860b; }
.dp .tag.ok { color: #30a46c; }
.dp .text { margin: 3px 0 0; color: var(--dsw-alias-label-primary); word-break: break-word; }
.dp .dim { opacity: .72; }
.dp .empty { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; }
.dp .kv { display: grid; grid-template-columns: 110px minmax(0, 1fr) minmax(120px, auto); gap: 7px 12px; align-items: baseline; }
.dp .kv b { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.dp .kv em { color: var(--dsw-alias-label-tertiary); font-style: normal; font-size: 11.5px; text-align: right; }
.dp .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.dp button { height: 28px; padding: 0 12px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; cursor: pointer; }
.dp button:hover { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l2)); }
.dp textarea { width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical; padding: 8px 10px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; }
.dp textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.dp .field { border-top: .5px solid var(--dsw-alias-border-l2); padding: 10px 0; display: grid; gap: 5px; } .dp .field:first-child { border-top: 0; padding-top: 0; }
.dp .fieldTop { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; } .dp .fieldTop b { font-weight: 500; } .dp .badge { color: #b8860b; font-size: 11px; white-space: nowrap; }
.dp select, .dp .field input[type=text], .dp .row input[type=text] { height: 28px; box-sizing: border-box; padding: 0 8px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; } .dp .field input[type=checkbox] { width: 15px; height: 15px; margin: 0; }
.dp .qr { display: block; width: 200px; height: auto; margin-top: 8px; padding: 6px; border-radius: 8px; background: #fff; }
.dp .principle p { margin: 0 0 6px; color: var(--dsw-alias-label-secondary); line-height: 20px; }
.dp .principle p:last-child { margin-bottom: 0; }
.dp .thanksLink { color: var(--dsw-alias-state-business-primary, #4a7dff); font-size: 12px; line-height: 18px; text-decoration: none; word-break: break-all; }
.dp .thanksLink:hover { text-decoration: underline; }
.dp .thanksFoot { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
`

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === 'undefined') return
        if (document.querySelector(`style[data-tag="${CSS_TAG}"]`)) return
        const el = document.createElement('style')
        el.setAttribute('data-tag', CSS_TAG)
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // -------------------------------------------------------------------------
    // 通用块：每张卡 = 标题 + 一句人话 + 内容
    // -------------------------------------------------------------------------

    function Card({ title, note, right, full, children }) {
      return h(
        'section',
        { className: `card${full ? ' full' : ''}` },
        h('div', { className: 'cardTop' }, h('h3', null, title), right ? h('span', { className: 'right' }, right) : null),
        note ? h('p', { className: 'note' }, note) : null,
        children,
      )
    }

    function Stat({ label, value, unit, hint, small }) {
      return h(
        'div',
        { className: 'stat', title: hint || undefined },
        h('span', { className: 'k' }, label),
        h('div', null, h('b', { className: small ? 'small' : undefined }, value), unit ? h('span', { className: 'u' }, unit) : null),
      )
    }

    // 还没揭开的统计块：值的位置是 ？？？，整块真模糊，下面一行说她还要走多远。
    function nextTip(next) {
      if (!next) return '已经全都能看见了'
      const parts = []
      if (next.needEvents > 0) parts.push(`再聊 ${next.needEvents} 次`)
      if (next.needDays > 0) parts.push(`多陪她 ${next.needDays} 天`)
      return parts.length ? `${parts.join('，或')}就告诉你` : '就快揭开了'
    }

    function VeilStat({ label, next }) {
      return h(
        'div',
        { className: 'stat' },
        h(
          'div',
          { className: 'veil' },
          h('span', { className: 'k' }, label),
          h('div', null, h('b', { className: 'q' }, '？？？')),
        ),
        h('span', { className: 'tip' }, nextTip(next)),
      )
    }

    function List({ rows, empty, render }) {
      if (!rows || !rows.length) return h('p', { className: 'empty' }, empty || '还没有。')
      return h(
        'ul',
        { className: 'list' },
        rows.map((row, i) => h('li', { key: row.id || row.key || i }, render(row, i))),
      )
    }

    function EventLine({ ev }) {
      return h(
        'div',
        null,
        h('div', { className: 'meta' }, h('span', { className: 'tag' }, typeName(ev.type)), h('span', null, when(ev.ts))),
        h('p', { className: 'text' }, ev.text || '（没有正文）'),
      )
    }

    // -------------------------------------------------------------------------
    // 页签：状态
    // -------------------------------------------------------------------------

    // 状态页顶部的「起点」：照观测台网页版，没有起点时写三句话，或者领养成年鱼。
    function SeedCard({ seed, seedOverride, adultPicked, textOverride, biasOverride, onChanged }) {
      const data = seedOverride !== undefined ? seedOverride : seed
      const [form, setForm] = useState(() => ({
        text: textOverride || '',
        bias: biasOverride || 'balanced',
        adult: adultPicked === true,
        busy: false,
        note: '',
      }))

      // 读不到就说读不到，不伪装成"没有起点"。
      if (!data || data.seedError) {
        return h(
          Card,
          { title: '起点', note: '她是怎么开始的。', right: '只写一次', full: true },
          h('p', { className: data ? 'err' : 'empty' }, data ? '起点状态没读到' : '正在读起点…'),
        )
      }

      const cur = data.current || {}
      if (data.hasSeed) {
        const frags =
          Array.isArray(cur.fragments) && cur.fragments.length ? cur.fragments : cur.text ? [String(cur.text)] : []
        return h(
          Card,
          { title: '起点', note: '她是怎么开始的。', right: '只写一次', full: true },
          h('p', { className: 'hint' }, '起点已写'),
          frags.map((t, i) => h('p', { key: i, className: 'text' }, String(t))),
          form.note ? h('p', { className: 'hint' }, form.note) : null,
          h('p', { className: 'hint' }, '起点只写一次，不能改'),
        )
      }

      const lim = data.limits || {}
      const adult = data.adult || {}
      const biases = Array.isArray(data.biases) ? data.biases : []
      const radio = (name, value, checked, onPick) => h('input', { type: 'radio', name, value, checked, onChange: onPick })

      // 两个提交共用一个壳：禁用 → POST → 落结果 → 刷新；失败只显示后端的人话。
      async function send(path, body, done) {
        if (form.busy) return
        setForm((f) => ({ ...f, busy: true, note: '' }))
        try {
          await postJson(path, body)
          setForm((f) => ({ ...f, busy: false, note: done }))
          if (typeof onChanged === 'function') await onChanged()
        } catch (e) {
          setForm((f) => ({ ...f, busy: false, note: String((e && e.message) || e) }))
        }
      }

      return h(
        Card,
        { title: '起点', note: '她是谁，只写这一次。', right: '只写一次', full: true },
        h('p', { className: 'note' }, '还没开始。写三句话给她，或者领一条已经长大的鱼。'),
        lim.fragments ? h('p', { className: 'limits' }, `最多 ${lim.fragments} 段、每段不超过 ${lim.fragment} 字、合计不超过 ${lim.total} 字；写完就定下来，不能改。`) : null,
        h(
          'div',
          { className: 'biases' },
          biases.map((b) =>
            h(
              'label',
              { key: b.id, className: 'opt' },
              radio('bias', b.id, form.bias === b.id, () => setForm((f) => ({ ...f, bias: b.id }))),
              h('span', null, b.name),
              b.hint ? h('em', null, b.hint) : null,
            ),
          ),
        ),
        h('p', { className: 'red' }, '养鱼新手不要调整，默认就行'),
        adult.available === false
          ? null
          : h(
              'div',
              { className: 'adult' },
              h('label', { className: 'opt' }, radio('startMode', 'adult', form.adult, () => setForm((f) => ({ ...f, adult: !f.adult }))), h('span', null, adult.label || '')),
              form.adult
                ? h(
                    'div',
                    { className: 'adultBox' },
                    h('p', { className: 'text' }, '她叫：', h('b', null, adult.name || '派希丝')),
                    h(
                      'div',
                      { className: 'row' },
                      h('button', { type: 'button', disabled: form.busy, onClick: () => send('/adopt', {}, `她来了：${adult.name || '派希丝'}（重启后工具面变 9 个）`) }, '领养这条成年鱼'),
                    ),
                    h('p', { className: 'hint' }, '领养后要重启一次，工具面才会从 7 个变 9 个'),
                  )
                : null,
            ),
        form.adult ? null : h('textarea', { value: form.text, rows: 6, placeholder: '三句话就够了。比如：喜欢下雨天；讨厌被催；想学做菜。', onChange: (e) => setForm((f) => ({ ...f, text: e.target.value })) }),
        form.adult
          ? null
          : h('div', { className: 'row' }, h('button', { type: 'button', disabled: form.busy, onClick: () => send('/seed', { texts: splitTexts(form.text), bias: form.bias }, '写好了') }, '写下去')),
        form.note ? h('p', { className: 'hint' }, form.note) : null,
      )
    }

    // 成年鱼专属：称呼。固定名字仍是派希丝；这里只是"他平时怎么叫她"，改了就用新的自称。
    function NicknameCard({ nickname }) {
      const [draft, setDraft] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      async function save() {
        if (busy) return
        setBusy(true)
        setNote('')
        try {
          const r = await postJson('/nickname', { name: draft.trim() })
          setNote(`以后她自称 ${(r && r.name) || draft.trim()}`)
          setDraft('')
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      return h(
        Card,
        { title: '称呼', note: '固定名字仍是派希丝；他给你的昵称，她拿来自称。', right: '成年鱼', full: true },
        h('p', { className: 'hint' }, nickname ? `现在叫：${nickname}` : '还没起昵称'),
        h(
          'div',
          { className: 'row' },
          h('input', {
            type: 'text',
            className: 'nick',
            maxLength: 12,
            value: draft,
            placeholder: '1–12 个字',
            onChange: (e) => setDraft(e.target.value),
          }),
          h('button', { type: 'button', disabled: busy, onClick: save }, '就叫这个'),
        ),
        note ? h('p', { className: /^以后/.test(note) ? 'hint' : 'err' }, note) : null,
      )
    }

    // 「看谁」切换（2026-11-14）：状态页/心理活动页共用；鲸歌走主库，派希丝走第二库。
    function BankSwitch({ bank, onChange }) {
      const pick = (id, label) =>
        h(
          'button',
          { key: id, onClick: () => { if (bank !== id) onChange(id) }, disabled: bank === id, 'aria-pressed': bank === id },
          label,
        )
      return h(
        'div',
        { className: 'row' },
        h('span', { className: 'note' }, '看谁：'),
        pick('main', '鲸歌'),
        pick('pisces', '派希丝'),
      )
    }

    // 客厅邀请码（2026-11-14）：放在设置页最上面。一次生成两张，各贴各自的家会话。
    function RoomInviteCard() {
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const [door, setDoor] = useState(null)
      const [code, setCode] = useState('')
      useEffect(() => {
        // 回来的时候码还在：面板只显示当前那张，不因为离开页面就丢。
        getJson('/room-invite')
          .then((r) => {
            setDoor((r && r.door) || null)
            if (r && r.code) setCode(String(r.code))
          })
          .catch(() => setDoor(null))
      }, [])
      async function make() {
        setBusy(true)
        try {
          const r = await postJson('/room-invite', {})
          if (!r || !r.ok) {
            setNote((r && r.error) || '没生成出来')
            return
          }
          const next = ((r.codes || [])[0] || {}).code || ''
          setCode(next)
          const mins = Math.max(1, Math.round((Number(r.expiresAt) - Date.now()) / 60000))
          setNote(`${next}（${mins} 分钟内有效）：贴到客厅会话里发出去，门就开了。`)
        } catch {
          setNote('没生成出来')
        } finally {
          setBusy(false)
        }
      }
      const doorText = door && door.open
        ? `门开着${door.until ? `（到 ${new Date(Number(door.until)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）` : ''}`
        : '门关着'
      return h(
        Card,
        {
          title: '去客厅 / 从客厅回来',
          note: '去客厅要通行码：拿一张，贴到客厅会话里就开门（开 90 分钟）。回来不用码——到各自的家会话里说一句「我回来了」，她俩各自把客厅那段收进自己的库；两只都回来门才关（或者 90 分钟自己到点）。',
          right: doorText,
          full: true,
        },
        code ? h('p', { className: 'hint' }, `当前通行码：`, h('b', null, code)) : null,
        note ? h('p', { className: 'hint' }, note) : null,
        h(
          'div',
          { className: 'row' },
          h('button', { onClick: make, disabled: busy }, busy ? '生成中…' : code ? '换一张通行码' : '拿一张通行码'),
          h('span', { className: 'note' }, code ? '这张还没用；离开设置页再回来也还在。换一张会作废现在这张。' : ''),
        ),
      )
    }

    function StatusTab({ snap, loading, seed, seedOverride, adultPicked, textOverride, biasOverride, onChanged, bankBar, bank }) {
      const seedCard = bank === 'pisces'
        ? null
        : h(SeedCard, { seed, seedOverride, adultPicked, textOverride, biasOverride, onChanged })
      if (!snap) {
        return h(
          'div',
          { className: 'page' },
          bankBar || null,
          seedCard,
          h(
            Card,
            { title: '状态', note: '只回答"她现在是什么样"。', right: '只读', full: true },
            h('p', { className: 'empty' }, loading ? '正在读她的状态…' : '还没有读到。'),
          ),
        )
      }
      const s = snap.state || {}
      const a = s.attribution || {}
      const last = snap.nightly ? snap.nightly.last : null
      // 普通鱼没有 reveal：走原来那 8 块，行为与现在完全一致。
      // 成年鱼按 reveal.locked 把没揭开的块换成模糊 + ？？？，提示写在模糊层外面。
      const rv = s.reveal || null
      const locked = (rv && rv.locked) || {}
      const tipNext = rv ? rv.next : null
      // 好感是推导出来的读数：普通鱼直接给；成年鱼被 reveal 遮住时只有心意（tier/label）可见。
      const aff = s.affinity || null
      const affMasked = Boolean(aff && aff.masked)
      const hearts =
        aff && Number.isFinite(Number(aff.tier)) ? '♥'.repeat(Math.max(1, Math.min(5, Number(aff.tier) + 1))) : ''
      const affValue = !aff ? '—' : affMasked || aff.value == null ? '？？？' : String(aff.value)
      const stat = (key, props) =>
        rv && locked[key] ? h(VeilStat, { label: props.label, next: tipNext }) : h(Stat, props)
      return h(
        'div',
        { className: 'page' },
        bankBar || null,
        seedCard,
        h(
          'div',
          { className: 'stats' },
          stat('day', { label: '存在', value: s.day == null ? '—' : s.day, unit: '天' }),
          stat('events', { label: '事件', value: s.events == null ? '—' : s.events }),
          stat('attribution', {
            label: '归因分布',
            value: `d ${a.d == null ? '—' : a.d} · i ${a.i == null ? '—' : a.i} · 空 ${a.null == null ? '—' : a.null}`,
            hint: 'd = 算过再说，i = 先凭感觉，空 = 纯描述',
            small: true,
          }),
          rv && (locked.order || locked.dominance)
            ? h(VeilStat, { label: '主导', next: tipNext })
            : h(Stat, {
                label: '主导',
                value: orderText(s.order),
                unit: Number.isFinite(Number(s.dominance)) ? Number(s.dominance).toFixed(2) : '',
                hint: 'order 只决定先靠哪边，不是分数',
              }),
          stat('openQuestions', { label: '悬着的问题', value: s.openQuestions == null ? '—' : s.openQuestions }),
          stat('dreams', { label: '梦', value: s.dreams == null ? '—' : s.dreams }),
          stat('verified', { label: '核实', value: s.verified == null ? '—' : s.verified, hint: '梦里的假设后来对上了几条' }),
          h(Stat, {
            label: '双流',
            value: s.dual ? `${s.dual.mode || '—'} · 先算 ${s.dual.plans ?? 0} · 缓存 ${s.dual.cacheHits ?? 0}` : '没开',
            hint: s.dual
              ? `退回 ${s.dual.fallbacks ?? 0}${s.dual.seconds ? ` · 最近 ${Number(s.dual.seconds).toFixed(1)}s` : ''}`
              : '设置页可开；改完重启',
            small: true,
          }),
          h(Stat, {
            label: '语料标记',
            value: s.style ? `${s.style.flagged ?? 0} 条` : '—',
            hint:
              s.style && Object.keys(s.style.counts || {}).length
                ? Object.entries(s.style.counts).map(([k, v]) => `${k} ${v}`).join(' · ')
                : '新回复命中才计数；不存原文',
            small: true,
          }),
          rv ? stat('refusals', { label: '拒绝', value: s.refusals == null ? '—' : s.refusals, hint: '她说过"不"的事' }) : null,
          rv ? stat('scars', { label: '疤', value: s.scars == null ? '—' : s.scars, hint: '他难过之后留下的' }) : null,
          h(Stat, { label: '上次整理', value: age(last), hint: last ? when(last) : '夜间流水线还没跑过' }),
        ),
        h(
          Card,
          {
            title: '好感',
            note: '从她和你来去的这些事里长出来的，不是谁给她打的分。',
            right: '只读',
            full: true,
          },
          h(
            'div',
            { className: 'row' },
            h('b', { className: 'hearts' }, hearts),
            h('span', null, aff && aff.label ? aff.label : '—'),
            h('b', null, affValue),
            aff && aff.nextAt != null ? h('span', { className: 'hint' }, `到 ${aff.nextAt} 再上一档`) : null,
          ),
          affMasked ? h('p', { className: 'hint' }, '聊深一点才告诉你') : null,
          aff ? null : h('p', { className: 'empty' }, '还没读到好感。'),
        ),
        s.demo ? h(NicknameCard, { nickname: snap.nickname || null }) : null,
        h(
          Card,
          {
            title: '她最近说的话',
            note: '最近 10 条，带日期和类型。只摆原话，不解释。',
            right: '只读',
            full: true,
          },
          h(List, { rows: snap.recent, empty: '还没有她说的话。', render: (ev) => h(EventLine, { ev }) }),
        ),
        h(
          Card,
          {
            title: '这些数字从哪来',
            note: '宿主从她的事件流里算出来的；她看不见自己这些数。',
            right: '只读',
            full: true,
          },
          h('p', { className: 'hint' }, '数字只是读数。面板不改事件、不改判断，也不给她打分。'),
        ),
      )
    }

    // 页签：设置（由 /settings 的 schema 驱动，客户端不写死规则）

    function SettingsTab({ data, onSaved }) {
      const schema = Array.isArray(data && data.schema) ? data.schema : []
      const items = schema.filter((it) => it && !it.readOnly)
      const cur = (data && data.settings) || {}
      const [draft, setDraft] = useState(() => {
        const d = {}
        for (const it of items) d[it.path] = readPath(cur, it.path)
        return d
      })
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      if (!data || data.settingsError) {
        return h(Card, { title: '设置', note: '改她的开关；存盘后重启生效。', full: true },
          h('p', { className: data ? 'err' : 'empty' }, data ? `设置没读到：${data.settingsError}` : '正在读设置…'))
      }

      const set = (path, value) => setDraft((d) => ({ ...d, [path]: value }))

      async function save() {
        if (busy) return
        setBusy(true)
        setNote('')
        const patch = {}
        for (const it of items) {
          const [group, key] = String(it.path).split('.')
          if (!patch[group]) patch[group] = {}
          patch[group][key] = draft[it.path]
        }
        try {
          const r = await postJson('/settings', { patch })
          setNote('存好了，重启后生效')
          if (typeof onSaved === 'function') onSaved(r)
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      function field(it) {
        const v = draft[it.path]
        let input
        if (it.kind === 'bool') {
          input = h('input', { type: 'checkbox', checked: v === true, onChange: (e) => set(it.path, e.target.checked) })
        } else if (it.kind === 'enum') {
          const opts = (it.options || []).map((o) => {
            const val = o && typeof o === 'object' ? o.value : o
            return h('option', { key: String(val), value: String(val) }, String(o && typeof o === 'object' ? o.label || o.value : o))
          })
          input = h('select', { value: v == null ? '' : String(v), onChange: (e) => set(it.path, e.target.value) }, opts)
        } else {
          input = h('input', { type: 'text', value: v == null ? '' : String(v), onChange: (e) => set(it.path, e.target.value) })
        }
        return h(
          'div',
          { className: 'field', key: it.path },
          h(
            'div',
            { className: 'fieldTop' },
            h('b', null, it.label || it.path),
            it.restart ? h('span', { className: 'badge' }, '保存后需重启') : null,
          ),
          it.hint ? h('p', { className: 'hint' }, it.hint) : null,
          input,
        )
      }

      return h(
        'div',
        { className: 'page' },
        h(RoomInviteCard, null),
        h('p', { className: 'hint' }, `她的数据：${data.root || '未读到'}（只读）`),
        h(
          Card,
          { title: '设置', note: '这些开关决定她怎么活；存盘后重启一次才生效。', right: '本地文件', full: true },
          h('div', { className: 'fields' }, items.map(field)),
          h('div', { className: 'row' }, h('button', { type: 'button', disabled: busy, onClick: save }, '保存设置')),
          note ? h('p', { className: note === '存好了，重启后生效' ? 'hint' : 'err' }, note) : null,
        ),
        h(BiliCard, null),
        h(BaiduCard, null),
      )
    }

    // 登录卡（B 站 / 百度贴吧共用）：扫码或粘贴 cookie → 后端验证 → 状态就地刷新。
    // B 站那张多给一条扫码路：二维码由宿主现画（lib/qr.js），页面只拿 SVG 和「登的是谁」。
    function CookieCard({ title, api, placeholder, hint, qr }) {
      const [status, setStatus] = useState(null)
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [q, setQ] = useState(null)

      useEffect(() => {
        let alive = true
        getJson(api)
          .then((d) => { if (alive) setStatus(d) })
          .catch(() => { if (alive) setStatus({ loggedIn: false }) })
        return () => { alive = false }
      }, [api])

      const key = q && q.key ? String(q.key) : ''
      const state = q && q.state ? String(q.state) : ''
      const polling = Boolean(key) && (state === 'waiting' || state === 'scanned')

      // 轮询只在这一张码还活着的时候跑；状态变了（confirmed/expired）就停。
      useEffect(() => {
        if (!polling) return undefined
        let alive = true
        const timer = setInterval(() => {
          getJson(`${api}/qr?key=${encodeURIComponent(key)}`)
            .then((r) => { if (alive) setQ((prev) => (prev && prev.key === key ? { ...prev, ...r } : prev)) })
            .catch(() => {})
        }, 1200)
        return () => { alive = false; clearInterval(timer) }
      }, [api, key, polling])

      const logged = !!(status && status.loggedIn)
      const name = status && status.name ? String(status.name) : ''

      async function save() {
        if (busy) return
        setBusy(true)
        setNote('')
        try {
          const r = await postJson(api, { cookie: text })
          setStatus(r)
          setText('')
          setNote(r.name ? `登上了：${r.name}` : '登上了')
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      async function startQr() {
        if (busy) return
        setBusy(true)
        setNote('')
        try {
          setQ({ ...(await postJson(`${api}/qr`, {})), state: 'waiting' })
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      async function saveQr() {
        if (busy || !key) return
        setBusy(true)
        try {
          const r = await postJson(`${api}/qr/save`, { key })
          setStatus(r)
          setQ(null)
          setNote(r.name ? `登上了：${r.name}` : '登上了')
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      function dropQr() {
        const k = key
        setQ(null)
        if (k) postJson(`${api}/qr/drop`, { key: k }).catch(() => {})
      }

      const qrLine = !q
        ? ''
        : state === 'confirmed'
          ? (q.account && q.account.name
            ? `登的是 ${q.account.name}${q.account.mid ? `（uid ${q.account.mid}）` : ''}`
            : '扫码成功，认不出是哪个号')
          : state === 'scanned'
            ? '扫到了，在手机上点一下「确认登录」'
            : state === 'expired'
              ? '二维码过期了，点「换一张」'
              : (q.why || '用手机 B 站扫一下')

      return h(
        Card,
        { title, right: 'Cookie' },
        h('p', { className: 'hint' }, `登录状态：${logged ? (name ? `已登录 ${name}` : '已登录') : '未登录'}`),
        qr ? h('div', { className: 'row' }, h('button', { type: 'button', disabled: busy, onClick: startQr }, q ? '换一张' : '用手机扫码登录')) : null,
        q ? h('div', { className: 'qr' },
          q.svg ? h('img', {
            className: 'qrimg',
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(q.svg))}`,
            alt: '登录二维码',
            width: 180,
            height: 180,
          }) : null,
          h('p', { className: 'hint' }, qrLine),
          h('div', { className: 'row' },
            state === 'confirmed' ? h('button', { type: 'button', disabled: busy, onClick: saveQr }, '就是这个号，保存') : null,
            h('button', { type: 'button', onClick: dropQr }, '收起'),
          ),
        ) : null,
        h('textarea', {
          value: text,
          rows: 3,
          placeholder,
          onChange: (e) => setText(e.target.value),
        }),
        h('div', { className: 'row' }, h('button', { type: 'button', disabled: busy, onClick: save }, '保存并验证')),
        note ? h('p', { className: note.startsWith('登上了') ? 'hint' : 'err' }, note) : null,
        h('p', { className: 'hint' }, hint),
      )
    }

    // B 站登录：手机扫码为主，粘贴 SESSDATA/bili_jct 是退路；登录态落 owner.json。
    function BiliCard() {
      return h(CookieCard, {
        title: 'B 站',
        api: '/bili',
        qr: true,
        placeholder: '把浏览器的 SESSDATA=…; bili_jct=… 贴进来',
        hint: '不想扫码：浏览器 F12 → Application → Cookies → bilibili.com → 复制 SESSDATA 和 bili_jct',
      })
    }

    // 百度贴吧登录：粘贴 BDUSS/STOKEN；只影响贴吧，不碰 B 站。
    function BaiduCard() {
      return h(CookieCard, {
        title: '百度贴吧',
        api: '/baidu',
        placeholder: '把浏览器的 BDUSS=…; STOKEN=… 贴进来',
        hint: '浏览器 F12 → Application → Cookies → tieba.baidu.com → 复制 BDUSS 和 STOKEN',
      })
    }

    // -------------------------------------------------------------------------
    // 页签：心理活动
    // -------------------------------------------------------------------------

    function MindTab({ snap, bankBar }) {
      if (!snap) {
        return h(
          Card,
          { title: '心理活动', note: '她最近在想什么。', right: '只读', full: true },
          bankBar || null,
          h('p', { className: 'empty' }, '还没有读到。'),
        )
      }
      const events = snap.events || []
      const beliefs = events
        .filter((ev) => ev.type === 'narration' || ev.type === 'revise' || ev.type === 'refusal')
        .slice(0, 8)
      const open = ((snap.questions && snap.questions.questions) || []).filter((q) => q.status === 'open').slice(0, 12)
      const dreams = ((snap.dreams && snap.dreams.dreams) || []).slice(0, 6)
      return h(
        'div',
        { className: 'page' },
        bankBar || null,
        h(
          Card,
          {
            title: '最近的判断',
            note: '她说出口的判断、改口和拒绝；只摆原话，不替你裁决。',
            right: '只读',
            full: true,
          },
          h(List, {
            rows: beliefs,
            empty: '还没有。她还没说过哪句像判断的话。',
            render: (ev) => h(EventLine, { ev }),
          }),
        ),
        h(
          Card,
          { title: '悬着的问题', note: '她问过、还没人答的。', right: '只读' },
          h(List, {
            rows: open,
            empty: '还没有悬着的问题。',
            render: (q) =>
              h(
                'div',
                null,
                h(
                  'div',
                  { className: 'meta' },
                  h('span', { className: 'tag' }, QUESTION_NAMES[q.status] || q.status || '悬着'),
                  h('span', null, when(q.since)),
                ),
                h('p', { className: 'text' }, q.text || '（没有正文）'),
              ),
          }),
        ),
        h(
          Card,
          { title: '最近的梦', note: '梦只是模拟，不进判断；没做成的也留一句为什么。', right: '只读' },
          h(List, {
            rows: dreams,
            empty: '还没有做过梦。',
            render: (d) => {
              const rejected = d.status === 'rejected'
              const why = rejected && Array.isArray(d.rejected) && d.rejected.length ? d.rejected.join('；') : '没过闸'
              return h(
                'div',
                { className: rejected ? 'dim' : undefined },
                h(
                  'div',
                  { className: 'meta' },
                  rejected
                    ? h('span', { className: 'tag warn' }, '没做成')
                    : h('span', { className: d.verified ? 'tag ok' : 'tag' }, d.verified ? '核对过' : '没核过'),
                  h('span', null, when(d.ts)),
                ),
                h('p', { className: 'text' }, rejected ? `这次没做成梦：${why}` : d.hypothesis || d.text || '（没有正文）'),
              )
            },
          }),
        ),
        h(
          Card,
          { title: '这页怎么读', note: '心理活动不是任务列表。', right: '只读', full: true },
          h('p', { className: 'hint' }, '判断、问题、梦是三种东西：判断是她认下来的话，问题是还没想通的，梦是模拟出来的假设。'),
          h('p', { className: 'hint' }, '面板只摆出来，不替她决定哪条算数。'),
        ),
      )
    }

    // -------------------------------------------------------------------------
    // 页签：原理（静态说明书，不是提示词）
    // -------------------------------------------------------------------------

    const PRINCIPLES = [
      {
        title: '事件流只能追加',
        note: '她的经历是一条只能往后写的流水账。',
        lines: [
          '她说过的话、别人回过的话、系统记下的事，都在这条流里，一条接一条。',
          '写进去就不能改、不能删；哈希链让"悄悄改一条"能被发现。',
          '面板上的天数、判断、疤，都是从这条流里算出来的。',
        ],
      },
      {
        title: '三本库',
        note: '一本记经历，一本记常识，一本只是索引。',
        lines: [
          'events.db 是经历，只追加；world.db 是常识，记东西和它们的关系。',
          'index.db 是索引，可删可重建，丢了不影响她是谁。',
          '前两本不是缓存，删了就真的丢了。',
        ],
      },
      {
        title: '归因 d / i / 空',
        note: '她每说一句带立场的话，夜里会被判一次。',
        lines: [
          'd 是"算过再说"，i 是"先凭感觉"，空是"纯描述，没有立场"。',
          '判不动才问本地模型；规则能判的，不花钱。',
          '空也是一个结论，会落库——所以不会每晚重问同一句。',
        ],
      },
      {
        title: '分流四条门槛',
        note: '不是一开始就两条；证据够了才分。',
        lines: [
          '至少 12 条归因、两边各 3 条、占比在 0.30–0.70、至少 1 条 tension 证据；四条都满足才分流。',
          '分流之后主导每步最多挪 0.05；换档要过 30 天冷却，还要带至少 2 条引用。',
          '提示词只给口吻，不给数字；分流前一个字都不提两种想法。',
        ],
      },
      {
        title: '人设卡八道闸',
        note: '她能改自己的卡，但每次都要过八道闸。',
        lines: [
          '类型和字数、证据、一次不改超过 25%、同一处 24 小时一次、抬头的"# 我"不许动。',
          '不许写数值；和今天开始时比漂移超过 35%，或者独立复审不点头，都先不写。',
          '写成功、被拒、被 held 都会落一条事件，所以改不动也看得见理由。',
        ],
      },
      {
        title: '夜间的六步',
        note: '你睡着之后，她按固定顺序做六件事。',
        lines: [
          '归因 → 折进分流 → 同步问题 → 做梦 → 核实 → 自学。',
          '默认 02:00–05:00，一天一次；哪一步失败都不影响后面。',
          'force 跳过时间窗，dryRun 只预览、不落库。',
        ],
      },
    ]

    function PrincipleTab() {
      return h(
        'div',
        { className: 'page' },
        PRINCIPLES.map((p) =>
          h(
            Card,
            { key: p.title, title: p.title, note: p.note, right: '只读', full: true },
            h('div', { className: 'principle' }, p.lines.map((line, i) => h('p', { key: i }, line))),
          ),
        ),
      )
    }

    // -------------------------------------------------------------------------
    // 页签：反馈（只存本地浏览器）
    // -------------------------------------------------------------------------

    function FeedbackTab({ value, note, onChange, onSave }) {
      return h(
        'div',
        { className: 'page' },
        h(
          Card,
          {
            title: '写点什么',
            note: '反馈先只存在本地浏览器里，明天再定怎么落地。',
            right: '可改',
            full: true,
          },
          h('textarea', {
            value,
            rows: 6,
            placeholder: '哪里看不懂、哪里不对、想要什么。',
            onChange: (e) => onChange(e.target.value),
          }),
          h(
            'div',
            { className: 'row' },
            h('button', { type: 'button', onClick: onSave }, '暂存'),
            h('span', { className: 'note' }, note || '不会提交，也不会发出去。'),
          ),
        ),
        h(
          Card,
          { title: '明天再定', note: '现在不做假提交。', right: '只读' },
          h('p', { className: 'hint' }, '按钮只把这段话放进这台浏览器的本地存储；换一台机器、换一个浏览器就看不到。'),
        ),
        h(
          Card,
          { title: '加群', note: '想聊养鱼、报问题，来这里。', right: 'QQ 群', full: true },
          h('p', { className: 'text' }, h('b', null, '鱼肥生双交流群')),
          h(
            'div',
            { className: 'row' },
            h('span', null, '群号：129448233'),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  try {
                    navigator.clipboard.writeText('129448233')
                  } catch {
                    /* 浏览器不让复制就算，群号就在旁边 */
                  }
                },
              },
              '复制群号',
            ),
          ),
          h(
            'p',
            null,
            h(
              'a',
              { href: 'https://qm.qq.com/q/hIEOH1zT2M', target: '_blank', rel: 'noreferrer' },
              'https://qm.qq.com/q/hIEOH1zT2M',
            ),
          ),
          h('img', { className: 'qr', src: API + '/qq', alt: '鱼肥生双交流群二维码', width: 200 }),
        ),
      )
    }

    // -------------------------------------------------------------------------
    // 页签：鸣谢（列借鉴过的想法与项目；只读）
    // -------------------------------------------------------------------------

    const THANKS = [
      // 2026-11-10 定稿：八条；用户自己的插件/前作不鸣谢，dsh-fish 排第一。
      { name: 'dsh-fish', what: '事件流 + 纯函数派生 + 面板形态，本项目的骨架从它长出来。', href: 'https://www.npmjs.com/package/@ssamurias/dsh-fish' },
      { name: 'dsh-fish-memory', what: '记忆鲜活度与半衰期、中文检索。' },
      { name: 'Character Card V2', what: '`export.js` 的 CCv2 导出格式。' },
      { name: 'dsh-companion', what: '好感分档、关系产品化的样本。' },
      { name: 'Generative Agents', what: 'memory stream + 定期 reflection 的启发。' },
      { name: 'DeepSeek Harness', what: '宿主、插件体系、slots / systemPrompt / tools。' },
      { name: '双鱼座性格的公开资料', what: '（经 Exa 检索整理）她的性格起点。' },
      { name: '所有养过鱼的人', what: '社区里"把 AI 当室友养"的尝试。' },
    ]

    function ThanksTab() {
      return h(
        'div',
        { className: 'page' },
        THANKS.map((t) =>
          h(
            Card,
            { key: t.name, title: t.name, note: t.what, right: '借鉴', full: true },
            t.href ? h('a', { className: 'thanksLink', href: t.href, target: '_blank', rel: 'noreferrer' }, t.href) : null,
          ),
        ),
        h('p', { className: 'thanksFoot' }, '如果你觉得某个想法该被写在这里，发反馈告诉我们。（反馈页有加群方式）'),
      )
    }

    // -------------------------------------------------------------------------
    // 面板外壳
    // -------------------------------------------------------------------------

    function Panel() {
      useStyleOnce()
      const [tab, setTab] = useState('status')
      const [snap, setSnap] = useState(null)
      const [err, setErr] = useState('')
      const [loading, setLoading] = useState(true)
      const [seed, setSeed] = useState(null)
      const [settings, setSettings] = useState(null)
      const [feedback, setFeedback] = useState('')
      const [feedbackNote, setFeedbackNote] = useState('')
      const [bank, setBank] = useState('main')
      const [piscesSnap, setPiscesSnap] = useState(null)
      const [piscesLoading, setPiscesLoading] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        setErr('')
        try {
          // /state 是硬依赖；/seed 与 /settings 并行，读不到只标一行，不拖垮整页。
          const [state, seedInfo, cfgInfo, nickInfo] = await Promise.all([
            getJson('/state'),
            getJson('/seed').catch((e) => ({ seedError: String((e && e.message) || e) })),
            getJson('/settings').catch((e) => ({ settingsError: String((e && e.message) || e) })),
            getJson('/nickname').catch(() => null),
          ])
          setSeed(seedInfo)
          setSettings(cfgInfo)
          const [nightly, questions, dreams, ...talks] = await Promise.all([
            getJson('/nightly').catch(() => null),
            getJson('/questions').catch(() => ({ questions: [] })),
            getJson('/dreams').catch(() => ({ dreams: [] })),
            ...TALK_TYPES.map((type) => getJson(`/events?type=${type}&limit=12`).catch(() => ({ events: [] }))),
          ])
          const events = talks
            .flatMap((r) => (r && Array.isArray(r.events) ? r.events : []))
            .slice()
            .sort((a, b) => Number(b.ts) - Number(a.ts) || Number(b.seq) - Number(a.seq))
          setSnap({ state, nightly, questions, dreams, events, recent: events.slice(0, 10), nickname: (nickInfo && nickInfo.nickname) || null })
        } catch (e) {
          setErr(`读不到她的状态：${String((e && e.message) || e)}`)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      // 派希丝的第二库：同一套版式，换 /pisces/* 前缀。
      const loadPisces = useCallback(async () => {
        setPiscesLoading(true)
        try {
          const [state, dreams, ...talks] = await Promise.all([
            getJson('/pisces/state'),
            getJson('/pisces/dreams').catch(() => ({ dreams: [] })),
            ...TALK_TYPES.map((type) => getJson(`/pisces/events?type=${type}&limit=12`).catch(() => ({ events: [] }))),
          ])
          const events = talks
            .flatMap((r) => (r && Array.isArray(r.events) ? r.events : []))
            .slice()
            .sort((a, b) => Number(b.ts) - Number(a.ts) || Number(b.seq) - Number(a.seq))
          setPiscesSnap({ state, questions: { questions: [] }, dreams, events, recent: events.slice(0, 10), nickname: null })
        } catch {
          setPiscesSnap({
            state: { ok: false, reason: '第二个库没读到（setup.together 关着？）' },
            questions: { questions: [] },
            dreams: { dreams: [] },
            events: [],
            recent: [],
            nickname: null,
          })
        } finally {
          setPiscesLoading(false)
        }
      }, [])

      useEffect(() => {
        try {
          const saved = window.localStorage.getItem(FEEDBACK_KEY)
          if (saved) setFeedback(saved)
        } catch {
          // 本地存储不可用就空着，不影响面板。
        }
      }, [])

      function saveFeedback() {
        const text = feedback.trim()
        if (!text) {
          setFeedbackNote('还没写，先不用暂存。')
          return
        }
        try {
          window.localStorage.setItem(FEEDBACK_KEY, text)
          setFeedbackNote('已暂存到这台浏览器。')
        } catch {
          setFeedbackNote('这台浏览器不让写本地存储，暂时存不下。')
        }
      }

      const s = snap ? snap.state : null
      const bankBar = h(BankSwitch, {
        bank,
        onChange: (next) => {
          setBank(next)
          if (next === 'pisces' && !piscesSnap) loadPisces()
        },
      })
      const shownSnap = bank === 'pisces' ? piscesSnap : snap
      const shownLoading = bank === 'pisces' ? piscesLoading : loading
      const sub = s
        ? `第 ${s.day == null ? '—' : s.day} 天 · 她记下 ${s.events == null ? '—' : s.events} 条 · 只看不改`
        : loading
          ? '读取中…'
          : '读不到她的状态'

      let body
      if (tab === 'settings') {
        body = settings
          ? h(SettingsTab, {
              data: settings,
              onSaved: (r) => setSettings((p) => (p ? { ...p, settings: r.settings || p.settings } : p)),
            })
          : h('p', { className: 'hint' }, '正在读设置…')
      }
      else if (tab === 'mind') body = h(MindTab, { snap: shownSnap, bankBar })
      else if (tab === 'principle') body = h(PrincipleTab)
      else if (tab === 'feedback')
        body = h(FeedbackTab, { value: feedback, note: feedbackNote, onChange: setFeedback, onSave: saveFeedback })
      else if (tab === 'thanks') body = h(ThanksTab)
      else body = h(StatusTab, { snap: shownSnap, loading: shownLoading, seed, onChanged: load, bankBar, bank })

      return h(
        'div',
        { className: 'dp' },
        h(
          'header',
          { className: 'head' },
          h('div', null, h('h2', null, TITLE), h('p', { className: 'sub' }, sub)),
          err ? h('button', { type: 'button', onClick: load }, '再读一次') : null,
        ),
        h(
          'div',
          { className: 'tabs' },
          TABS.map((t) =>
            h(
              'button',
              {
                key: t.id,
                type: 'button',
                className: `tab${tab === t.id ? ' on' : ''}`,
                onClick: () => setTab(t.id),
              },
              t.label,
            ),
          ),
        ),
        err ? h('p', { className: 'err' }, err) : null,
        loading && !snap ? h('p', { className: 'hint' }, '读取中…') : null,
        body,
      )
    }

    // 表情工具视图（n186）：回执尾部有 `[表情 包/id]` 就换成一张图，否则退回一行字。
    const MEME_TOKEN = /\[表情 ([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,40})\]/
    const MEME_IMG = { width: 180, height: 180, objectFit: 'contain', borderRadius: 18, background: 'var(--dsw-alias-bg-base)' }
    const MEME_LABEL = { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }
    function MemeRow(props) {
      const text = ((props?.block?.content) || []).filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      const m = MEME_TOKEN.exec(text)
      const [broken, setBroken] = useState(false)
      if (!m) return h('div', { style: MEME_LABEL }, '表情')
      const caption = text.replace(MEME_TOKEN, '').trim()
      const src = `${API}/meme/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}.png?v=2`
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 2px' } },
        broken ? h('div', { style: MEME_LABEL }, caption || '（表情没加载出来）') : h('img', { src, alt: caption || '表情', onError: () => setBroken(true), style: MEME_IMG }),
        caption ? h('div', { style: MEME_LABEL }, caption) : null)
    }

    // -------------------------------------------------------------------------
    // 注册：插件对象自己声明 inject:['slots']（n22）
    // -------------------------------------------------------------------------

    const inject = ['slots']

    function apply(ctx) {
      const mount = () =>
        ctx.slots.inject(
          'settings.section',
          () =>
            ctx.slots.register(
              { name: 'settings.section', id: NS, order: ORDER, label: () => TITLE },
              Panel,
            ),
          EFFECT_LABEL,
        )
      // 表情：只替换 pisces_meme 这一种工具行，别的工具不受影响。
      const mountMeme = () =>
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'pisces_meme' }, MemeRow), `${EFFECT_LABEL}: meme`)
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(mount, EFFECT_LABEL)
        ctx.effect(mountMeme, `${EFFECT_LABEL}: meme`)
      } else {
        mount()
        mountMeme()
      }
    }

    return { name: 'dsh-pisces-settings', inject, apply, Panel, StatusTab, SettingsTab, FeedbackTab, ThanksTab, MemeRow, TABS, THANKS }
  },
})
