import type { Context as ClientContext } from '@deepseek-ai/cordis';
/**
 * Client entry: the browser half of the plugin.
 *
 * 两个能力共用一套「旁路会话」底座：
 *   - 选中追问（原有）：浮动按钮 → 侧边栏追问会话；
 *   - 会话复盘（新增）：会话头入口 → 侧边栏复盘会话（只读预设）。
 *
 * 浏览器半负责全部界面；创建子会话必须由 host 半完成
 * （子 agent 的预设、模型、父子关系都在宿主侧），所以经
 * `createSideAskClient()` 走同源 RPC。
 */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
