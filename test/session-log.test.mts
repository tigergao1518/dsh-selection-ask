// 会话日志读取 + 提炼 + 定位的离线测试。
// 用真 zstd 压缩构造多帧样本，验证「不许只解第一帧」这条关键约束。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  readSessionLog,
  decompressFrames,
  parseEvents,
  SessionLogError,
} from '../lib/sessionLog.js'
import { digestSession, renderDigest } from '../lib/sessionDigest.js'
import { locateSessionLog, listKnownSessions } from '../lib/sessionLogLocate.js'

const deps = {
  readFile: (path: string) => readFileSync(path) as Buffer,
  decompress: (frame: Buffer) => zstdDecompressSync(frame),
}

/** 把若干事件编码成一帧 zstd。 */
function frameOf(events: unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
}

// ── 多帧：关键回归。单次解压只能拿第一帧，必须逐帧 ─────────────────────────
{
  const f1 = frameOf([{ seq: 0, type: 'turn/start', data: { turn: 1 } }])
  const f2 = frameOf([{ seq: 1, type: 'step/start', data: { turn: 1, step: 1 } }])
  const f3 = frameOf([{ seq: 2, type: 'turn/end', data: { turn: 1, reason: 'completed' } }])
  const multi = Buffer.concat([f1, f2, f3])

  // 先证明陷阱真实存在：单次解压拿不到全部内容。
  const single = parseEvents(zstdDecompressSync(multi).toString('utf8'))
  assert.equal(single.events.length, 1, '单次解压确实只拿到第一帧（这正是要防的坑）')

  // 逐帧解压必须拿全。
  const { parts, frames, skipped } = decompressFrames(multi, (b) => zstdDecompressSync(b))
  assert.equal(frames, 3, '三个帧都要被识别')
  assert.equal(skipped, 0, '不该有跳过')
  const all = parseEvents(Buffer.concat(parts).toString('utf8'))
  assert.equal(all.events.length, 3, '逐帧解压必须拿到全部 3 条事件')
  assert.deepEqual(
    all.events.map((e) => e.type),
    ['turn/start', 'step/start', 'turn/end'],
  )
  console.log('通过：多帧 zstd 逐帧解压（对照单次解压只拿 1 条）')
}

// ── 损坏帧容错：尾部半截帧是追加写的正常现象，不该整体失败 ─────────────────
{
  const good = frameOf([{ seq: 0, type: 'turn/start', data: { turn: 1 } }])
  const torn = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]) // 假魔数 + 垃圾
  const buf = Buffer.concat([good, torn])
  const { parts, frames, skipped } = decompressFrames(buf, (b) => zstdDecompressSync(b))
  assert.equal(frames, 2)
  assert.equal(skipped, 1, '坏帧要被计入 skipped 而不是抛错')
  assert.equal(parts.length, 1, '好帧仍要解出来')
  console.log('通过：坏帧跳过并计数，好帧不受影响')
}

// ── 单帧（新会话日志量小）也要正常 ───────────────────────────────────────
{
  const one = frameOf([{ seq: 0, type: 'session', data: {} }])
  const { frames, skipped } = decompressFrames(one, (b) => zstdDecompressSync(b))
  assert.equal(frames, 1)
  assert.equal(skipped, 0)
  console.log('通过：单帧日志正常')
}

// ── 空文件与坏行 ─────────────────────────────────────────────────────────
{
  const { events, badLines } = parseEvents('{"seq":0,"type":"ok"}\n不是JSON\n\n{"seq":1,"type":"ok2"}\n')
  assert.equal(events.length, 2, '两条合法事件')
  assert.equal(badLines, 1, '一条坏行被计数而非抛错')
  assert.deepEqual(events.map((e) => e.seq), [0, 1], '按 seq 升序')
  console.log('通过：坏行计数、空行忽略、按 seq 排序')
}

// ── 缺失字段的 JSON 行要被算作坏行（不是合法事件） ────────────────────────
{
  const { events, badLines } = parseEvents('{"seq":0}\n{"seq":1,"type":"ok"}\n')
  assert.equal(events.length, 1)
  assert.equal(badLines, 1, '没有 type 的 JSON 不是合法事件')
  console.log('通过：缺 type 的行算坏行')
}

// ── readSessionLog：不存在 / 空文件 / 正常 ───────────────────────────────
{
  // readSessionLog 是同步函数，抛同步异常，所以用 throws 而非 rejects。
  assert.throws(
    () => readSessionLog('/definitely/missing.log', deps),
    (e: unknown) => e instanceof SessionLogError && e.code === 'not-found',
  )
  console.log('通过：日志不存在报 not-found')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'dsq-log-'))
  try {
    const p = join(dir, 'a.zstd')
    writeFileSync(p, Buffer.alloc(0))
    assert.throws(
      () => readSessionLog(p, deps),
      (e: unknown) => e instanceof SessionLogError && e.code === 'empty',
    )
    console.log('通过：空日志报 empty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'dsq-log2-'))
  try {
    const p = join(dir, 'b.zstd')
    writeFileSync(
      p,
      Buffer.concat([
        frameOf([{ seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } }]),
        frameOf([
          { seq: 1, type: 'step/start', time: 1100, data: { turn: 1, step: 1 } },
          { seq: 2, type: 'user/message', time: 1200, data: { content: [{ type: 'text', text: '帮我看看' }], source: { kind: 'user' } } },
        ]),
        frameOf([{ seq: 3, type: 'turn/end', time: 5000, data: { turn: 1, reason: 'completed' } }]),
      ]),
    )
    const log = readSessionLog(p, deps)
    assert.equal(log.frames, 3)
    assert.equal(log.events.length, 4)
    assert.equal(log.badLines, 0)
    assert.equal(log.skippedFrames, 0)
    assert.ok(log.compressedBytes > 0 && log.rawBytes > 0)
    console.log('通过：readSessionLog 端到端（3 帧 4 事件）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 提炼：轮次数据要算对 ─────────────────────────────────────────────────
{
  const events = [
    { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
    { seq: 1, type: 'user/message', time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }] } },
    { seq: 2, type: 'step/start', time: 20, data: { turn: 1, step: 1 } },
    { seq: 3, type: 'tool/call', time: 30, data: { turn: 1, step: 1, name: 'read', arguments: '{}' } },
    { seq: 4, type: 'tool/result', time: 40, data: { turn: 1, step: 1, name: 'read' } },
    { seq: 5, type: 'tool/call', time: 50, data: { turn: 1, step: 1, name: 'edit', arguments: '{}' } },
    { seq: 6, type: 'tool/result', time: 60, data: { turn: 1, step: 1, name: 'edit', error: { name: 'EditError', code: 'STALE', reason: '文件已变' } } },
    { seq: 7, type: 'llm/retry', time: 70, data: {} },
    // 注意 usage 口径：totalTokens 每步都含完整上下文（不累加），
    // outputTokens 才是模型真正产出的（累加）。
    { seq: 8, type: 'assistant/message', time: 80, data: { usage: { inputTokens: 7, outputTokens: 300, totalTokens: 1234 }, message: {} } },
    { seq: 9, type: 'turn/end', time: 1000, data: { turn: 1, reason: 'completed' } },
    { seq: 10, type: 'turn/start', time: 2000, data: { turn: 2 } },
    { seq: 11, type: 'user/message', time: 2010, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二个问题' }] } },
    { seq: 12, type: 'step/start', time: 2020, data: { turn: 2, step: 1 } },
    { seq: 13, type: 'assistant/message', time: 2100, data: { usage: { outputTokens: 500, totalTokens: 5000 }, message: {} } },
    { seq: 14, type: 'turn/end', time: 3000, data: { turn: 2, reason: 'completed' } },
  ]
  const d = digestSession(events)
  assert.equal(d.turnCount, 2)
  assert.equal(d.totalOutputTokens, 800, '300 + 500（模型实际产出）')
  assert.equal(d.finalContextTokens, 5000, '末尾上下文取最后一轮的最新值，不累加')
  assert.equal(d.turns[0].contextTokens, 1234, '第 1 轮末的上下文规模')
  assert.equal(d.totalToolCalls, 2)
  assert.equal(d.totalToolErrors, 1)
  assert.equal(d.totalRetries, 1)
  assert.equal(d.turns[0].prompt, '第一个问题')
  assert.equal(d.turns[0].durationMs, 1000)
  assert.equal(d.turns[0].steps, 1)
  assert.equal(d.turns[1].prompt, '第二个问题')
  assert.match(d.turns[0].errorSamples[0], /edit.*STALE.*文件已变/)
  console.log('通过：提炼轮次数据（token/工具/报错/耗时/提问）')
}

// ── 提炼：注入块不能被当成人打的提问 ─────────────────────────────────────
// 实测：DSH 把 system-reminder、插件提示也归在 user 消息流里，
// 只看 source.kind==='user' 会让首轮「提问」变成一段 system-reminder。
{
  const events = [
    { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
    {
      seq: 1,
      type: 'user/message',
      time: 1,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '<system-reminder>\n工作区指令\n</system-reminder>' }],
      },
    },
    {
      seq: 2,
      type: 'user/message',
      time: 2,
      data: {
        source: { kind: 'user', plugin: 'some-plugin' },
        content: [{ type: 'text', text: '插件注入的提示' }],
      },
    },
    {
      seq: 3,
      type: 'user/message',
      time: 3,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我真正想问的问题' }] },
    },
    { seq: 4, type: 'turn/end', time: 100, data: { turn: 1, reason: 'completed' } },
  ]
  const d = digestSession(events)
  assert.equal(
    d.turns[0].prompt,
    '我真正想问的问题',
    '要跳过 system-reminder 与插件注入，取到人真正打的那句',
  )
  console.log('通过：注入块被排除，取到真正的人类提问')
}

// ── 提炼：全是注入块时 prompt 为空（而不是塞一段 reminder） ──────────────
{
  const events = [
    { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
    {
      seq: 1,
      type: 'user/message',
      time: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<reminder>x</reminder>' }] },
    },
    { seq: 2, type: 'turn/end', time: 100, data: { turn: 1, reason: 'completed' } },
  ]
  const d = digestSession(events)
  assert.equal(d.turns[0].prompt, '', '没有人类提问时留空，不要拿注入块充数')
  console.log('通过：全注入块时提问留空')
}

// ── 提炼：未结束的最后一轮不能丢 ─────────────────────────────────────────
{
  const events = [
    { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 10, data: { turn: 1, step: 1 } },
    { seq: 2, type: 'tool/call', time: 20, data: { turn: 1, step: 1, name: 'read', arguments: '{}' } },
  ]
  const d = digestSession(events)
  assert.equal(d.turnCount, 1, '正在跑的那一轮也要收进结果，否则复盘漏掉最新进展')
  assert.equal(d.turns[0].turn, 1)
  assert.equal(d.turns[0].toolCalls, 1)
  assert.equal(d.turns[0].durationMs, undefined)
  console.log('通过：未结束的最后一轮不丢')
}

// ── 提炼：自动续跑轮次（无用户提问）──
{
  const events = [
    { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
    { seq: 1, type: 'turn/end', time: 100, data: { turn: 1, reason: 'completed' } },
  ]
  const d = digestSession(events)
  assert.equal(d.turns[0].prompt, '', '没有人类提问的轮次 prompt 为空')
  assert.match(renderDigest(d), /自动续跑/, '渲染时要标出来')
  console.log('通过：自动续跑轮次识别')
}

// ── 渲染：不能崩，且包含关键信息 ─────────────────────────────────────────
{
  const events = [
    { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
    { seq: 1, type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] } },
    { seq: 2, type: 'assistant/message', time: 2, data: { usage: { outputTokens: 100, totalTokens: 900 }, message: {} } },
    { seq: 3, type: 'turn/end', time: 5000, data: { turn: 1, reason: 'completed' } },
  ]
  const text = renderDigest(digestSession(events))
  assert.match(text, /共 1 轮/)
  assert.match(text, /100 tok/)
  assert.match(text, /第 1 轮/)
  console.log('通过：digest 渲染包含概览与轮次')
}

// ── 日志定位：不依赖目录名编码规则 ───────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'dsq-locate-'))
  try {
    // 造两个不同编码风格的项目目录，模拟 DSH 的编码差异。
    mkdirSync(join(root, '--D-some-project--', 'session-aaa'), { recursive: true })
    writeFileSync(join(root, '--D-some-project--', 'session-aaa', 'session.v4.jsonl.zstd'), Buffer.from('x'))
    mkdirSync(join(root, '--D-~4E2A~4EBA--', 'session-bbb'), { recursive: true })
    writeFileSync(join(root, '--D-~4E2A~4EBA--', 'session-bbb', 'session.v4.jsonl.zstd'), Buffer.from('y'))

    const a = locateSessionLog(root, 'session-aaa')
    assert.ok(a?.endsWith(join('session-aaa', 'session.v4.jsonl.zstd')), `定位到 a：${a}`)
    const b = locateSessionLog(root, 'session-bbb')
    assert.ok(b?.endsWith(join('session-bbb', 'session.v4.jsonl.zstd')), `定位到 b：${b}`)
    assert.equal(locateSessionLog(root, 'session-missing'), undefined, '找不到就返回 undefined')
    assert.deepEqual(listKnownSessions(root).sort(), ['session-aaa', 'session-bbb'])
    console.log('通过：日志定位（跨不同目录编码风格，不依赖编码规则）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 日志定位：老版本文件名兜底 ───────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'dsq-locate2-'))
  try {
    mkdirSync(join(root, '--proj--', 'session-old'), { recursive: true })
    writeFileSync(join(root, '--proj--', 'session-old', 'session.v3.jsonl.zstd'), Buffer.from('z'))
    const p = locateSessionLog(root, 'session-old')
    assert.ok(p?.endsWith('.zstd'), `老文件名也要能兜到：${p}`)
    console.log('通过：日志定位对旧文件名兜底')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('\n全部 sessionLog / digest / locate 测试通过')
