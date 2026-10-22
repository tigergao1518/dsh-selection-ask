import type { ReactElement } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** The slot's composed props: owner share {} + session kit + global kit. */
type SelectionAskProps = PropsRuntime<'conversation.input.overlay'>;
/**
 * The floating 「询问 DeepSeek」 surface.
 *
 * 两种用法，由卡片上的两个按钮区分：
 *
 *   「开侧栏追问」—— 在右侧栏开一个旁路会话：它 fork 自主会话、
 *     继承到目前为止的上下文，但有自己的对话流。主会话不被打断，
 *     侧栏里的问答也不会写回主会话的模型上下文。适合「问一下但不打断手头活」。
 *
 *   「存入本会话」—— 原有行为：把引用追加到当前输入框草稿，
 *     由用户自己决定何时发出去。适合「这段我要在主线里讨论」。
 *
 * 侧栏按钮在右侧栏服务不可用时隐藏，不给用户一个点了没反应的入口。
 */
export declare function SelectionAskButton({ useInput, inputActions, sessionId, }: SelectionAskProps): ReactElement | null;
export {};
