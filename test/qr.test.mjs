// qr.js：把一串字画成二维码（零依赖移植自 dsh-fish）。
// 不拿"看着像二维码"当标准：定位图案、尺寸自洽、掩码全试、超长必抛，逐条测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeQr, qrSvg } from '../lib/qr.js'

const URL_TEXT = 'https://passport.biligame.com/crossDomain?DedeUserID=42&qrcode_key=abc123'

test('qr：同一段字两次编码结果一致，版本与尺寸自洽', () => {
  const a = encodeQr(URL_TEXT)
  const b = encodeQr(URL_TEXT)
  assert.equal(a.version, b.version)
  assert.equal(a.size, b.size)
  assert.equal(a.size, 17 + a.version * 4, '尺寸 = 17 + 4×版本')
  assert.equal(a.ec, 'M')
  assert.deepEqual(a.modules, b.modules)
})

test('qr：三个角上是 7×7 的定位图案（回字）', () => {
  const { modules, size } = encodeQr(URL_TEXT)
  const corners = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]
  for (const [ox, oy] of corners) {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const ring = x === 0 || x === 6 || y === 0 || y === 6
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4
        assert.equal(
          modules[oy + y][ox + x],
          ring || core ? 1 : 0,
          `定位图案 (${ox},${oy}) 的 (${x},${y}) 不对`,
        )
      }
    }
  }
})

test('qr：SVG 自包含、黑白写死、尺寸跟着 scale/margin 走', () => {
  const svg = qrSvg(URL_TEXT, { scale: 4, margin: 2 })
  const { size } = encodeQr(URL_TEXT)
  const dim = (size + 2 * 2) * 4
  assert.match(svg, /^<svg /)
  assert.ok(svg.includes(`width="${dim}"`), '宽度不对')
  assert.ok(svg.includes('fill="#fff"') && svg.includes('fill="#000"'), '要写死黑白，别跟主题')
  assert.equal(/<image|href=|xlink:href/.test(svg), false, 'SVG 里不许引用外部资源')
})

test('qr：内容太长会抛错，不给一张扫不出的图', () => {
  assert.throws(() => encodeQr('x'.repeat(400)), /装不进/)
  assert.throws(() => encodeQr(''), /空的/)
  assert.throws(() => encodeQr(URL_TEXT, { ec: 'X' }), /纠错级/)
})

test('qr：八种掩码都能出矩阵；四档纠错级都认', () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const r = encodeQr(URL_TEXT, { mask })
    assert.equal(r.mask, mask)
    assert.equal(r.modules.length, r.size)
    assert.equal(r.modules[0].length, r.size)
  }
  for (const ec of ['L', 'M', 'Q', 'H']) {
    const r = encodeQr(URL_TEXT, { ec })
    assert.ok(r.modules.length > 0, `${ec} 档没出矩阵`)
  }
})
