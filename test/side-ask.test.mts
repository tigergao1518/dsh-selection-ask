// host 半离线冒烟测试：旁路会话工厂 + RPC 回环防护 + confirm 门禁。
// 全部用假服务驱动，不起真实 agent、不发网络请求。
import assert from 'node:assert/strict'

import { mountSideSessionFactory, mountFreshSessionFactory, SideSessionError } from '../lib/sideSession.js'
import { createRpcHandler, isLoopbackRequest, SideAskRpcError } from '../lib/sideAskRpc.js'

// ── 假宿主 ────────────────────────────────────────────────────────────────
interface FakeSession {
  id: string
  header: { id?: string; cwd?: string; parentSession?: string; agentPreset?: string }
  inheritedEventCount: number
  append?: (type: string, data: any, opts: any) => unknown
  snapshotEvents?: (from?: number) => readonly unknown[]
}

function makeFakeHost(options: { parentPreset?: string } = {}) {
  const sessions = new Map<string, FakeSession>()
  const forks: Array<{
    from: string
    atSeq?: number
    childSessionId?: string
  }> = []
  /** 记录 agents.create 的调用。fork 路**不该**调它（会撞 id）。 */
  const createCalls: Array<{ sessionId: string }> = []
  /** 记录 subagents.queuePrompt 的调用，用于验证首条提问投递。 */
  const queued: Array<{
    parentId: string
    childId: string
    content: any
    source: any
  }> = []
  /** 记录 agent.send 的调用（新开会话路用它投首条消息）。 */
  const sent: Array<{ agentId: string; message: any; target: unknown; wakeup: unknown }> = []
  /** 新开会话路传给 create 的预设与 cwd，用于断言「预设真正生效」。 */
  let createdPreset: string | undefined
  let createdCwd: string | undefined

  const parent: FakeSession = {
    id: 'parent-1',
    header: { cwd: 'D:/work', agentPreset: options.parentPreset ?? 'cordis' },
    inheritedEventCount: 0,
    // 父会话的事件快照：旁路会话的 seed 由它构造（复刻官方 buildForkSeed）。
    snapshotEvents: () => [
      { seq: 0, type: 'turn/start', time: 1 },
      { seq: 1, type: 'user/message', time: 2 },
    ],
  }
  sessions.set(parent.id, parent)

  let seq = 0
  const ctx = {
    get(name: string) {
      if (name === 'sessions') {
        return {
          get: (id: string) => sessions.get(id),
          // 仍然提供 fork（别的用例可能用），但旁路会话路已不再走它。
          fork: (source: FakeSession | string, boundary?: number, childSessionId?: string) => {
            const from = typeof source === 'string' ? source : source.id
            const id = childSessionId ?? `session-${++seq}`
            forks.push({ from, atSeq: boundary, childSessionId })
            const child: FakeSession = {
              id,
              header: { id, cwd: parent.header.cwd, parentSession: from },
              inheritedEventCount: boundary ?? 42,
              snapshotEvents: () => [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'user/message' }],
            }
            sessions.set(child.id, child)
            return child
          },
        }
      }
      if (name === 'agents') {
        return {
          get: (id: string) => (id === parent.id ? { id: parent.id } : undefined),
          // agents.create 一步完成「进 store + 落盘」，所以这里要记录
          // 它收到的 seed / inheritedEventCount / meta，并返回 agent。
          // 旁路会话路与新开会话路都走它。
          create: async (opts: any) => {
            const id = typeof opts.sessionId === 'string' ? opts.sessionId : `session-${++seq}`
            createCalls.push({
              sessionId: id,
              meta: opts.meta,
              seed: opts.seed,
              inheritedEventCount: opts.inheritedEventCount,
            })
            createdPreset = opts.meta?.agentPreset
            createdCwd = opts.meta?.cwd
            const agent = {
              id,
              send: (message: unknown, target: unknown, wakeup: unknown) => {
                sent.push({ agentId: id, message: message as any, target, wakeup })
              },
            }
            sessions.set(id, {
              id,
              header: { id, cwd: opts.meta?.cwd, agentPreset: opts.meta?.agentPreset },
              inheritedEventCount: opts.inheritedEventCount ?? 0,
            })
            return { agent, dispose: async () => {} }
          },
        }
      }
      if (name === 'subagents') {
        return {
          // 真实宿主：活跃就投 inbox、不活跃就 cold resume。
          // 两者都成功，所以这里直接记下来即可。
          queuePrompt: async (
            parent: { id: string },
            childId: string,
            content: any,
            source: any,
          ) => {
            queued.push({ parentId: parent.id, childId, content, source })
            return 'msg-1'
          },
        }
      }
      return undefined
    },
  }
  return {
    ctx: ctx as never,
    sessions,
    forks,
    createCalls,
    queued,
    sent,
    parent,
    // 用 getter 读，这样断言总能看到最新一次 create 的值。
    get createdPreset() {
      return createdPreset
    },
    get createdCwd() {
      return createdCwd
    },
  }
}

// ── 工厂：正常路径 ────────────────────────────────────────────────────────
{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)

  const record = await createSideSession({ parentSessionId: 'parent-1' })
  assert.match(record.sessionId, /^session-side-/)
  assert.equal(record.agentPreset, 'cordis', '未指定预设时沿用父会话预设')

  // 关键回归：**必须走 agents.create**，不能走 fork。
  //
  // 三次报错的结论：
  //   fork 不落盘 → 侧栏发送报 SessionPersistenceNotFoundError（not found）
  //   自己补 persistence.create → resume 时 registerCreated 撞 writers，
  //                             报 already exists
  //   而 sessionPersistence 被 isolate，第三方插件根本拿不到
  //       （属性访问还抛 cannot get property … without inject）
  // agents.create 内部 createStoredSession 会 persistence.create(header)，
  // 一步同时完成「进 store + 落盘 + 拿 write 所有权」，没有冲突。
  assert.equal(host.forks.length, 0, '不许走 fork（它不落盘，且与后续 resume 冲突）')
  assert.equal(host.createCalls.length, 1, '必须用 agents.create 造子会话')
  assert.equal(host.createCalls[0].sessionId, record.sessionId, 'create 用的应是返回的那个 id')

  // seed 必须包含父会话前缀 + 一条 session/end-seed（复刻官方 buildForkSeed）。
  const seed = host.createCalls[0].seed as Array<{ type?: string; seq?: number }>
  assert.ok(Array.isArray(seed) && seed.length > 0, 'seed 不能为空，否则恢复出来没有继承的上下文')
  assert.equal(seed.at(-1)?.type, 'session/end-seed', 'seed 末尾必须是 session/end-seed')
  assert.ok(
    (host.createCalls[0].inheritedEventCount ?? 0) > 0,
    'inheritedEventCount 要反映继承了多少条事件',
  )

  // meta 要带上 cwd 与 parentSession，否则侧栏会话没有工作目录与血缘。
  assert.equal(host.createCalls[0].meta?.cwd, 'D:/work', 'meta 要带父会话的 cwd')
  assert.equal(host.createCalls[0].meta?.parentSession, 'parent-1', 'meta 要记父会话 id')

  // 落盘由 agents.create 负责，persist 直接报 ok。
  assert.equal(record.persist.ok, true)

  // 关键回归：默认不投递消息。用户要的是「带进输入框但不发送」，
  // 文本由浏览器半预填，不走 host 的 queuePrompt。
  assert.equal(host.queued.length, 0, '默认不投递首条消息（预填由浏览器半负责）')
  console.log('通过：工厂正常路径（agents.create + 自建 seed、不 fork、不投递、沿用父预设）')
}

// ── 工厂：预设继承（agentPreset 参数只是回显，不是切换） ──────────────────
// 真实限制：fork 的 meta 不接受 agentPreset，事后切换又被
// agent-preset/locked 拒绝（已开始的会话不能改预设）。
// 所以子会话预设恒等于父会话的；请求里的 agentPreset 只影响返回值回显。
{
  const host = makeFakeHost({ parentPreset: 'cordis' })
  const createSideSession = mountSideSessionFactory(host.ctx)
  const record = await createSideSession({
    parentSessionId: 'parent-1',
    agentPreset: 'session-review',
  })
  // 关键：create 的调用里不能出现预设相关参数（fork 的 meta 不认，
  // 而本路是「继承」语义，预设恒等于父会话的）。
  assert.equal(host.createCalls.length, 1)
  assert.equal(host.createCalls[0].meta?.agentPreset, undefined, '不通过 meta 切预设')
  assert.equal(record.agentPreset, 'session-review', '返回值回显调用方的声明')
  console.log('通过：预设为继承语义（agentPreset 仅回显，不作切换）')
}

// ── 工厂：父会话不存在 ────────────────────────────────────────────────────
{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  await assert.rejects(
    () => createSideSession({ parentSessionId: 'no-such' }),
    (error: unknown) => {
      assert.ok(error instanceof SideSessionError)
      assert.equal(error.code, 'parent-not-found')
      return true
    },
  )
  assert.equal(host.forks.length, 0, '父会话缺失时绝不能造子会话')
  assert.equal(host.createCalls.length, 0, '父会话缺失时绝不能调 agents.create')
  console.log('通过：工厂父会话不存在时报 parent-not-found 且不造子会话')
}

// ── 工厂：父会话没有活动 agent ────────────────────────────────────────────
{
  const host = makeFakeHost()
  // 把父会话从 agents 注册表里摘掉，模拟「会话还在但 agent 已退出」
  const originalGet = host.ctx.get.bind(host.ctx)
  host.ctx.get = ((name: string) => {
    if (name === 'agents') {
      return { get: () => undefined }
    }
    return originalGet(name)
  }) as never
  const createSideSession = mountSideSessionFactory(host.ctx)
  await assert.rejects(
    () => createSideSession({ parentSessionId: 'parent-1' }),
    (error: unknown) => {
      assert.ok(error instanceof SideSessionError)
      assert.equal(error.code, 'parent-not-live')
      return true
    },
  )
  assert.equal(host.createCalls.length, 0, '父会话没有活 agent 时不该造子会话')
  console.log('通过：工厂父会话无活动 agent 时报 parent-not-live 且不造子会话')
}

// ── 工厂：必须显式给子会话 id ─────────────────────────────────────────────
// 显式 id 让日志可读，也把「这是旁路会话」编码进 id（side 前缀）。
{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  await createSideSession({ parentSessionId: 'parent-1' })
  assert.equal(host.createCalls.length, 1)
  const childId = host.createCalls[0].sessionId
  assert.ok(
    typeof childId === 'string' && childId !== '',
    `必须显式传入 sessionId，实际收到 ${String(childId)}`,
  )
  assert.match(childId, /^session-side-/, '子会话 id 应带 side 前缀便于识别')
  console.log(`通过：工厂显式指定子会话 id（${childId}）`)
}

{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  // 连续创建两次，id 必须不同（自增撞车的本质是 id 复用）。
  await createSideSession({ parentSessionId: 'parent-1' })
  await createSideSession({ parentSessionId: 'parent-1' })
  const ids = host.createCalls.map((c) => c.sessionId)
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1], '两次创建的子会话 id 不能相同')
  console.log('通过：连续创建的子会话 id 互不相同')
}

// ── 工厂：boundary 不随意透传（它是数组索引，不是 seq） ───────────────────
{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  // 即使调用方请求了 atSeq，也不改继承边界：seed 取父会话「最新一条」，
  // 与官方 fork 省略 boundary 时的行为一致（内部取 lastEvent.seq）。
  await createSideSession({ parentSessionId: 'parent-1', atSeq: 12 })
  const seed = host.createCalls[0].seed as Array<{ type?: string }>
  assert.equal(seed.at(-1)?.type, 'session/end-seed')
  assert.equal(
    host.createCalls[0].inheritedEventCount,
    2,
    'inheritedEventCount = 继承的父会话事件数（不含 end-seed）',
  )
  console.log('通过：atSeq 不改继承边界（始终继承到最新一条）')
}

// ── 工厂：首条提问预填 ────────────────────────────────────────────────────
{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  await createSideSession({
    parentSessionId: 'parent-1',
    firstMessage: '> 选中这段\n\n它为什么这么写？',
  })
  assert.equal(host.queued.length, 1, '给了 firstMessage 就必须投递一条')
  const q = host.queued[0]
  assert.equal(q.childId, host.createCalls[0].sessionId, '要投给新建的子会话')
  assert.equal(q.parentId, 'parent-1', '投递要以活着的父 agent 授权')
  assert.equal(
    q.source.kind,
    'user',
    "归属必须是 'user'，否则会被当成插件注入、不进用户对话流",
  )
  assert.equal(q.content[0].type, 'text')
  assert.match(q.content[0].text, /它为什么这么写/, '引用与问题都要带上')
  console.log('通过：工厂经 subagents.queuePrompt 投递首条提问（归属 user）')
}

{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  // 空串与纯空白都不该投递。
  await createSideSession({ parentSessionId: 'parent-1', firstMessage: '   ' })
  assert.equal(host.queued.length, 0, '空白 firstMessage 不该投递')
  console.log('通过：工厂空白 firstMessage 不投递')
}

{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  // 投递抛错时旁路会话仍算创建成功——用户在侧栏手动问即可。
  const originalGet = host.ctx.get.bind(host.ctx)
  host.ctx.get = ((name: string) => {
    if (name === 'subagents') {
      return {
        queuePrompt: async () => {
          throw new Error('cold resume failed')
        },
      }
    }
    return originalGet(name)
  }) as never
  const record = await createSideSession({ parentSessionId: 'parent-1', firstMessage: '问一句' })
  assert.equal(
    record.sessionId,
    host.createCalls[0].sessionId,
    '投递失败不能作废已建好的旁路会话',
  )
  console.log('通过：投递失败不作废旁路会话')
}

// ── 回环防护 ──────────────────────────────────────────────────────────────
function fakeReq(remoteAddress: string, host = '127.0.0.1:19387', extra: Record<string, string> = {}) {
  return { socket: { remoteAddress }, headers: { host, ...extra } } as never
}

assert.equal(isLoopbackRequest(fakeReq('127.0.0.1')), true, '本机 IPv4 回环应放行')
assert.equal(isLoopbackRequest(fakeReq('::1', '[::1]:19387')), true, 'IPv6 回环应放行')
assert.equal(isLoopbackRequest(fakeReq('::ffff:127.0.0.1')), true, 'IPv4 映射回环应放行')
assert.equal(isLoopbackRequest(fakeReq('192.168.1.5')), false, '局域网地址必须拒绝')
assert.equal(isLoopbackRequest(fakeReq('10.0.0.2')), false, '内网地址必须拒绝')
assert.equal(
  isLoopbackRequest(fakeReq('127.0.0.1', 'evil.example.com')),
  false,
  'Host 头不是本机时必须拒绝',
)
assert.equal(
  isLoopbackRequest(fakeReq('127.0.0.1', '127.0.0.1:19387', { 'x-forwarded-for': '8.8.8.8' })),
  true,
  'X-Forwarded-For 一律不采信',
)
assert.equal(
  isLoopbackRequest(fakeReq('127.0.0.1', '127.0.0.1:19387', { 'sec-fetch-site': 'cross-site' })),
  false,
  '跨站请求必须拒绝',
)
assert.equal(
  isLoopbackRequest(fakeReq('127.0.0.1', '127.0.0.1:19387', { origin: 'http://evil.com' })),
  false,
  'Origin 与 Host 不一致必须拒绝',
)
console.log('通过：回环防护（回环放行、局域网/内网/Host 劫持/跨站/Origin 不符全拒绝）')

// ── RPC：confirm 门禁与方法分发 ───────────────────────────────────────────
async function rpcCall(
  host: ReturnType<typeof makeFakeHost>,
  body: unknown,
  req: unknown = fakeReq('127.0.0.1'),
): Promise<{ status: number; payload: any }> {
  const createSideSession = mountSideSessionFactory(host.ctx)
  const handler = createRpcHandler({ createSideSession })
  let status = 0
  let payload: any = null
  const res = {
    writeHead(code: number) {
      status = code
    },
    end(text: string) {
      payload = JSON.parse(text)
    },
  } as never
  const chunks = [Buffer.from(JSON.stringify(body))]
  const request = Object.assign(req as object, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }) as never
  await handler(request, res)
  return { status, payload }
}

{
  const host = makeFakeHost()
  const result = await rpcCall(host, { method: 'createSideSession', params: { parentSessionId: 'parent-1' } })
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, false, '缺少 confirm 必须被拒')
  assert.equal(result.payload.error.code, 'not-confirmed')
  assert.equal(host.forks.length, 0, '未确认时绝不能 fork')
  console.log('通过：RPC confirm 门禁（缺 confirm 不 fork）')
}

{
  const host = makeFakeHost()
  const result = await rpcCall(host, {
    method: 'createSideSession',
    params: { parentSessionId: 'parent-1', confirm: true, agentPreset: 'session-review' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.value.agentPreset, 'session-review')
  assert.equal(host.forks.length, 0, 'RPC 路径也不许走 fork')
  assert.equal(host.createCalls.length, 1, 'RPC 路径同样走 agents.create')
  console.log('通过：RPC 正常创建旁路会话')
}

{
  const host = makeFakeHost()
  const result = await rpcCall(host, { method: 'nope', params: { confirm: true } })
  assert.equal(result.payload.error.code, 'unknown-method')
  console.log('通过：RPC 未知方法报 unknown-method')
}

{
  const host = makeFakeHost()
  // 非回环来源必须 403
  const result = await rpcCall(
    host,
    { method: 'createSideSession', params: { parentSessionId: 'parent-1', confirm: true } },
    fakeReq('192.168.1.9'),
  )
  assert.equal(result.status, 403)
  assert.equal(result.payload.error.code, 'forbidden')
  assert.equal(host.forks.length, 0, '非回环请求绝不能 fork')
  console.log('通过：RPC 非回环来源 403 且不 fork')
}

{
  const host = makeFakeHost()
  const result = await rpcCall(host, { method: 'createSideSession', params: { confirm: true } })
  assert.equal(result.payload.error.code, 'bad-request', 'parentSessionId 缺失应报 bad-request')
  console.log('通过：RPC 参数校验（parentSessionId 缺失）')
}

// ── 新开会话（复盘路）：预设必须真正传给 agents.create ───────────────────
// 这是复盘能真正只读的关键：新 id 不在 store 里，所以 create 不会撞车，
// meta.agentPreset 能一步把只读预设定下来。
{
  const host = makeFakeHost()
  const createFreshSession = mountFreshSessionFactory(host.ctx)
  const record = await createFreshSession({
    cwd: 'D:/work',
    agentPreset: 'session-review',
    firstMessage: '复盘提示词',
  })
  assert.match(record.sessionId, /^session-side-/)
  assert.equal(record.agentPreset, 'session-review')
  assert.equal(host.forks.length, 0, '新开会话不该走 fork')
  assert.equal(host.createCalls.length, 1, '新开会话要用 agents.create')
  assert.equal(host.createdPreset, 'session-review', '预设必须真正传给 create')
  assert.equal(host.createdCwd, 'D:/work', 'cwd 必须传（header 要求绝对路径）')
  assert.equal(host.sent.length, 1, '首条消息要投给新会话的 agent')
  assert.equal(host.sent[0].target, 'next-turn')
  assert.equal(host.sent[0].wakeup, true)
  console.log('通过：新开会话（预设真正生效、cwd 必填、首条消息投递）')
}

{
  const host = makeFakeHost()
  const createFreshSession = mountFreshSessionFactory(host.ctx)
  // 缺 cwd 必须明确报错，而不是让 host 抛一个难懂的校验错。
  await assert.rejects(
    () => createFreshSession({ cwd: '', agentPreset: 'session-review' }),
    (error: unknown) => error instanceof SideSessionError && error.code === 'create-failed',
  )
  assert.equal(host.createCalls.length, 0, '缺 cwd 时不该调 create')
  console.log('通过：新开会话缺 cwd 时报 create-failed 且不建会话')
}

{
  const host = makeFakeHost()
  const createFreshSession = mountFreshSessionFactory(host.ctx)
  // 不指定预设时用默认的复盘预设。
  const record = await createFreshSession({ cwd: 'D:/work' })
  assert.equal(record.agentPreset, 'session-review', '默认预设是 session-review')
  assert.equal(host.createdPreset, 'session-review')
  console.log('通过：新开会话默认预设')
}

// ── 端到端回归：三次 already exists / not found 都必须不再出现 ────────────
// 同一个坑修了三次，单独锁死：
//   0.3.0/0.3.1  session "…" already exists（fork 后又调 agents.create）
//   0.4.x        SessionPersistenceNotFoundError（fork 不落盘）
//   0.5.x        already exists（自己补 persistence.create，resume 时撞 writers）
// 正解是「自建 seed + agents.create」：它内部 createStoredSession 一步完成
// 进 store + 落盘 + 拿 write 所有权，全程只 create 一次，没有冲突面。
{
  const host = makeFakeHost()
  const createSideSession = mountSideSessionFactory(host.ctx)
  const record = await createSideSession({
    parentSessionId: 'parent-1',
    agentPreset: 'session-review',
    firstMessage: '复盘本会话',
  })
  // 1) 子会话确实建出来了
  assert.match(record.sessionId, /^session-side-/)
  // 2) 只 create 一次，且不走 fork（两条冲突路径都避开）
  assert.equal(host.createCalls.length, 1)
  assert.equal(host.forks.length, 0, '不许走 fork')
  // 3) 显式传 firstMessage 时才投递（归属 user）——默认不投
  assert.equal(host.queued.length, 1)
  assert.equal(host.queued[0].source.kind, 'user')
  assert.equal(host.queued[0].childId, record.sessionId)
  // 4) 连续再建一个也不受影响（id 不复用，create 各一次）
  const second = await createSideSession({ parentSessionId: 'parent-1' })
  assert.notEqual(second.sessionId, record.sessionId)
  assert.equal(host.createCalls.length, 2, '每次创建各自 create 一次')
  // 第二次没传 firstMessage，所以不该再投递
  assert.equal(host.queued.length, 1, '不传 firstMessage 就不投递')
  // 5) 两次的 seed 都完整
  for (const call of host.createCalls) {
    const seed = call.seed as Array<{ type?: string }>
    assert.equal(seed.at(-1)?.type, 'session/end-seed', '每次的 seed 都要带 end-seed')
  }
  console.log('通过：端到端回归（只 create 一次、不 fork、seed 完整、按需投递）')
}

console.log('\n全部 host 半测试通过')
