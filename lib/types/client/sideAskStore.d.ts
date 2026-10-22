import type { SideAskClient } from './sideAskClient.ts';
/** 由 client 入口在 apply() 里调用一次。 */
export declare function setSideAskClient(next: SideAskClient | undefined): void;
/** 取旁路会话客户端；未就绪（服务不全或插件尚未加载）时为 undefined。 */
export declare function sideAsk(): SideAskClient | undefined;
/** 登记一条待回填草稿（由「开侧栏追问」调用）。 */
export declare function stagePendingDraft(sessionId: string, text: string): void;
/** 取走并删除某会话的待回填草稿；没有或已过期则返回 undefined。 */
export declare function takePendingDraft(sessionId: string): string | undefined;
