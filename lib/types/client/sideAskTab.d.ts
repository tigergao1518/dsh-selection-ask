import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** tab 类型 id，也是 `sidebar.right.pane.tab` 的 key。 */
export declare const SIDE_ASK_TAB_ID = "side-ask";
/** 资源地址前缀。 */
export declare const SIDE_ASK_ADDRESS = "dsh-resource://side-ask/session/";
/** 一个旁路会话地址。 */
interface SideAskAddress {
    readonly kind: 'session';
    readonly sessionId: string;
}
/** 把地址字符串解析成 `{ sessionId }`，不合法返回 undefined。 */
export declare function parseSideAskAddress(address: unknown): SideAskAddress | undefined;
/** 由 sessionId 生成资源地址。 */
export declare function sideAskAddressFor(sessionId: string): string;
/**
 * 挂载右侧栏旁路会话 tab。
 *
 * @param ctx - 需要 `resources`、`sessions`、`slots`、`sidebarRightTabs` 四个 client 服务。
 * @returns 打开一个旁路会话 tab 的函数；服务不全时返回 undefined（插件其余部分仍可用）。
 */
export declare function mountSideAskTab(ctx: ClientContext): ((sessionId: string) => void) | undefined;
export {};
