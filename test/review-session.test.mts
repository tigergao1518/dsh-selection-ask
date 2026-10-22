// 复盘会话组装的端到端测试：
// 造一份真实的会话日志文件 → mountReviewSessionFactory →
// 验证「读日志 → 提炼 → 新开会话 + 只读预设 + 注入摘要」整条链路。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { mountReviewSessionFactory, REVIEW_PRESET_ID } from '../lib/reviewSession.js'
import { SESSION_LOG_FILENAME } from '../lib/sessionLogLocate.js'

/** 把若干事件编码成一帧 zstd。 */
function frameOf(events: unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
}

/** 造一个假 host：只提供 sessions/agents 两个服务。 */
function makeFakeHost() {
  const createCalls: Array<{ sessionId: string; meta?: any }> = []
  const sent: Array<{ agentId: string; message: any }> = []
  const ctx = {
    get(name: string) {
      if (name === 'sessions') {
        return { get: () => undefined, fork: () => { throw new Error('复盘不该 fork') } }
      }
      if (name === 'agents') {
        return {
          get: () => undefined,
          create: async (opts: { sessionId: string; meta?: any }) => {
            createCalls.push({ sessionId: opts.sessionId, meta: opts.meta })
            return {
              agent: {
                id: opts.sessionId,
                send: (message: unknown) => sent.push({ agentId: opts.sessionId, message: message as any }),
                // 兼容 inbox 投递签名
                followup: () => {},
                steer: () => {},
                inject: () => {},
              },
              dispose: async () => {},
            }
          },
        }
      }
      return undefined
    },
  }
  return { ctx: ctx as never, createCalls, sent }
}

const deps = {
  // sessionsRoot 在用例里覆盖
  sessionsRoot: '',
  readFile: (p: string) => readFileSync(p) as Buffer,
  decompress: (b: Buffer) => zstdDecompressSync(b),
}
void deps

// ── 正常路径：读日志 → 新开会话 + 只读预设 + 注入摘要 ────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'dsq-review-'))
  try {
    const targetId = 'session-target-1'
    const dir = join(root, '--proj--', targetId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, SESSION_LOG_FILENAME),
      Buffer.concat([
        frameOf([
          { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
          {
            seq: 1,
            type: 'user/message',
            time: 5,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我加个功能' }] },
          },
        ]),
        frameOf([
          { seq: 2, type: 'step/start', time: 10, data: { turn: 1, step: 1 } },
          { seq: 3, type: 'tool/call', time: 20, data: { turn: 1, step: 1, name: 'edit', arguments: '{}' } },
          { seq: 4, type: 'tool/result', time: 30, data: { turn: 1, step: 1, name: 'edit', error: { name: 'E', code: 'STALE' } } },
        ]),
        frameOf([
          { seq: 5, type: 'assistant/message', time: 40, data: { usage: { outputTokens: 500, totalTokens: 9000 }, message: {} } },
          { seq: 6, type: 'turn/end', time: 60, data: { turn: 1, reason: 'completed' } },
        ]),
      ]),
    )

    const host = makeFakeHost()
    const createReviewSession = mountReviewSessionFactory(host.ctx, {
      sessionsRoot: root,
      readFile: (p) => readFileSync(p) as Buffer,
      decompress: (b) => zstdDecompressSync(b),
    })

    const result = await createReviewSession({
      targetSessionId: targetId,
      cwd: 'D:/work',
    })

    // 1. 新开会话，预设是只读那份
    assert.equal(host.createCalls.length, 1, '要新开一个会话')
    assert.equal(host.createCalls[0].meta.agentPreset, REVIEW_PRESET_ID, '必须挂只读预设')
    assert.equal(host.createCalls[0].meta.cwd, 'D:/work', 'cwd 要传下去')
    assert.equal(result.agentPreset, REVIEW_PRESET_ID)
    assert.equal(result.digestTurns, 1, '提炼出 1 轮')

    // 2. 首条消息注入：要含身份边界、过程数据、工具用法、协议
    const text = host.sent[0]?.message?.content?.[0]?.text ?? ''
    assert.match(text, /复盘者/, '要声明复盘身份')
    assert.match(text, /不要修改任何文件/, '要声明只读边界')
    assert.match(text, /共 1 轮/, '要含过程数据概览')
    assert.match(text, /第 1 轮/, '要含轮次明细')
    assert.match(text, /read_session_log/, '要告诉模型怎么回查细节')
    assert.match(text, new RegExp(targetId), '要给出被复盘会话的 id 供回查')
    assert.match(text, /STALE/, '要把报错样例带进去')
    console.log('通过：复盘端到端（读日志→提炼→新开会话+只读预设+注入摘要）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 找不到日志要明确报错，而不是开一个空复盘会话 ─────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'dsq-review2-'))
  try {
    const host = makeFakeHost()
    const createReviewSession = mountReviewSessionFactory(host.ctx, {
      sessionsRoot: root,
      readFile: (p) => readFileSync(p) as Buffer,
      decompress: (b) => zstdDecompressSync(b),
    })
    await assert.rejects(
      () => createReviewSession({ targetSessionId: 'session-missing', cwd: 'D:/work' }),
      (error: unknown) => (error as { code?: string }).code === 'not-found',
    )
    assert.equal(host.createCalls.length, 0, '日志找不到时绝不开复盘会话')
    console.log('通过：日志找不到时报 not-found 且不开会话')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 日志损坏时要在摘要里如实说明，而不是假装数据完整 ─────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'dsq-review3-'))
  try {
    const targetId = 'session-torn'
    const dir = join(root, '--proj--', targetId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, SESSION_LOG_FILENAME),
      Buffer.concat([
        frameOf([
          { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } },
          { seq: 1, type: 'turn/end', time: 10, data: { turn: 1, reason: 'completed' } },
        ]),
        // 尾部半截帧：写入时进程被杀的正常现象
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x11, 0x22]),
      ]),
    )
    const host = makeFakeHost()
    const createReviewSession = mountReviewSessionFactory(host.ctx, {
      sessionsRoot: root,
      readFile: (p) => readFileSync(p) as Buffer,
      decompress: (b) => zstdDecompressSync(b),
    })
    await createReviewSession({ targetSessionId: targetId, cwd: 'D:/work' })
    const text = host.sent[0]?.message?.content?.[0]?.text ?? ''
    assert.match(text, /损坏帧/, '有坏帧时必须如实告知，避免模型以为数据完整')
    console.log('通过：坏帧如实上报（不假装数据完整）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('\n全部复盘组装测试通过')
