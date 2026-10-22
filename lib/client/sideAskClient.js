/**
 * 浏览器半的旁路会话客户端。
 *
 * 静态客户端插件没有 `host.call`，所以与宿主半通信走所有出厂插件都在用的
 * 那条路：同源 POST 到 host 注册的 `/dsh-side-ask/rpc`。
 * 信封统一为 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
 */
/** host 半路由，与 `src/sideAskRpc.ts` 的 ROUTE_PATH 一致。 */
const RPC_PATH = '/dsh-side-ask/rpc';
/** RPC 失败时抛出，带 host 给的稳定 code。 */
export class SideAskError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SideAskError';
    }
}
/** 把人类可读的原因映射给用户看。 */
export function describeSideAskError(error) {
    if (error instanceof SideAskError) {
        switch (error.code) {
            case 'parent-not-found':
                return '找不到当前会话，可能已关闭';
            case 'parent-not-live':
                return '当前会话已归档，无法继承它的上下文';
            case 'forbidden':
                return '请求被拒绝（非本机来源）';
            case 'not-confirmed':
                return '创建请求未获确认';
            case 'bad-request':
                return `请求参数有误：${error.message}`;
            default:
                return error.message || '创建旁路会话失败';
        }
    }
    return error instanceof Error ? error.message : '创建旁路会话失败';
}
/** 构造旁路会话客户端。 */
export function createSideAskClient(deps) {
    /** 统一的 RPC 调用：发请求、解信封、把错误转成 SideAskError。 */
    async function call(method, params) {
        let payload;
        try {
            const response = await fetch(RPC_PATH, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // 同源请求必须带 cookie，否则宿主认不出来源。
                credentials: 'same-origin',
                // confirm: true 是所有创建方法的门禁（host 侧强制）。
                body: JSON.stringify({ method, params: { ...params, confirm: true } }),
            });
            payload = await response.json();
        }
        catch (error) {
            throw new SideAskError('network', error instanceof Error ? error.message : String(error));
        }
        if (payload?.ok !== true) {
            const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'internal';
            const message = typeof payload?.error?.message === 'string' ? payload.error.message : '';
            throw new SideAskError(code, message);
        }
        return payload.value ?? {};
    }
    return {
        async openSideSession(request) {
            const value = await call('createSideSession', {
                parentSessionId: request.parentSessionId,
                ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }),
                ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                ...(request.firstMessage === undefined || request.firstMessage === ''
                    ? {}
                    : { firstMessage: request.firstMessage }),
            });
            const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
            if (sessionId === '')
                throw new SideAskError('internal', '宿主未返回子会话 id');
            // 会话已建好，剩下就是把它显示出来。右侧栏服务不全是降级路径：
            // 会话不会丢，只是不在侧栏打开。
            deps.openSideAsk?.(sessionId);
            return {
                sessionId,
                inheritedEventCount: Number(value.inheritedEventCount ?? 0),
                agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : '',
                persist: value.persist !== undefined && typeof value.persist === 'object'
                    ? {
                        ok: value.persist.ok === true,
                        error: typeof value.persist.error === 'string' ? value.persist.error : undefined,
                    }
                    : undefined,
            };
        },
        async openReviewSession(request) {
            const value = await call('openReviewSession', {
                targetSessionId: request.targetSessionId,
                cwd: request.cwd,
                ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
            });
            const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
            if (sessionId === '')
                throw new SideAskError('internal', '宿主未返回复盘会话 id');
            deps.openSideAsk?.(sessionId);
            return {
                sessionId,
                agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : '',
                digestTurns: Number(value.digestTurns ?? 0),
            };
        },
    };
}
