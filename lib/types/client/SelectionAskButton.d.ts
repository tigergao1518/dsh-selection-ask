import type { ReactElement } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** The slot's composed props: owner share {} + session kit + global kit. */
type SelectionAskProps = PropsRuntime<'conversation.input.overlay'>;
/**
 * The floating 「询问 DeepSeek」 surface. Rendered inside the composer's
 * `conversation.input.overlay` anchor (a zero-height absolute node); the
 * surface escapes it with `position: fixed` and floats over the transcript at
 * viewport coordinates derived from the selection rect.
 *
 * Clicking the pill transforms it in place into a small compose card: the
 * selection is pre-quoted into the textarea, the user types the follow-up
 * right there, and Enter sends it through the official input machine
 * (`setDraft` + `submit`) without ever touching the resident composer.
 */
export declare function SelectionAskButton({ inputActions, }: SelectionAskProps): ReactElement | null;
export {};
