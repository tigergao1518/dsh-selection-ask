/**
 * Floating 「询问 DeepSeek」 surface CSS. Plain CSS string injected via an
 * HMR-safe `<style data-plugin="dsh-selection-ask">` tag. Stable prefixed
 * class names (`dsa-*`), DSH theme vars — never hashed class names of other
 * packages.
 *
 * Theme variables use ONLY the published theme-token catalog
 * (`Theme.listTokens`): bg-base / bg-layer-1 / bg-overlay / border-l1 /
 * label-primary / label-secondary / brand-primary. Earlier revisions
 * invented `--dsw-alias-bg-module-platform`-style names that resolve to
 * nothing on the shipped themes, which left the compose card white-on-white
 * under the dark theme; keep new styles on the catalog names.
 *
 * The surface renders inside the composer's `conversation.input.overlay`
 * anchor, a `height:0; position:absolute` node. `position:fixed` escapes that
 * anchor (no transformed ancestor), so top/left are viewport coordinates fed
 * from `range.getBoundingClientRect()`.
 *
 * `.dsa-anchor` is the session-identity anchor: a zero-size, layout-free,
 * invisible node that always renders as the first child of every branch.
 * It exists so the button instance can ask "which conversation am I in?"
 * via `closest('[data-conversation-scroll]')` — with several conversations
 * on screen at once (a sidebar session beside the main one) each conversation
 * mounts its own instance, all listening to the same global `selectionchange`,
 * so without this check the pills overlap and a click lands on the wrong one.
 */
export const buttonCss = `
/* 会话隔离锚点：零尺寸、不参与布局、不接收事件、不可见。
   唯一作用是让本实例能确定自己属于哪个会话（见上面对 .dsa-anchor 的说明）。 */
.dsa-anchor {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.dsa-button {
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: 16px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 16%, transparent);
  transition: background 0.12s, box-shadow 0.12s, transform 0.12s;
}
.dsa-button:hover {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));
}
.dsa-button:active {
  transform: scale(0.97);
}
.dsa-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dsa-card {
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  width: 400px;
  max-width: calc(100vw - 16px);
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  box-shadow: 0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 22%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsa-card-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 96px;
  max-height: 240px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2329);
  caret-color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.dsa-card-input:focus {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 0;
}
.dsa-card-input::placeholder {
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.4));
}
.dsa-card-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.dsa-card-hint {
  margin-right: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.4));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsa-card-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, transform 0.12s;
}
.dsa-card-btn:hover {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));
}
.dsa-card-btn:active {
  transform: scale(0.97);
}
/*
 * 主按钮（存入本会话）。
 *
 * 深色模式踩过的坑（两轮才修对）：
 *
 * 第一版：background: brand-primary; color: #ffffff。
 * 浅色主题没问题；但 DSH 的**深色主题把 brand-primary 反转成近白色**
 * （实测 #f9fafb），白字压白底完全看不见——就是「亮得看不到字」。
 *
 * 第二版：改成 color: bg-overlay，想让它跟着主题反转。
 * 但深色主题下 bg-overlay 实测是 #61666b（中灰），白底灰字对比度仍不够。
 *
 * 最终方案：**不拿 brand-primary 当背景**。改用
 *   background: bg-layer-2（浅色主题=浅灰、深色主题=#2c2c2e 中深灰）
 *   color:       label-primary（两种主题下都是高对比前景）
 * 再加 border-l1 描边，让按钮在两种主题里都有清晰边界。
 * 这套组合不依赖品牌色的明暗，深浅主题都稳定。
 */
.dsa-card-btn-primary {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06));
  /* label-primary 在两种主题下都与 bg-layer-2 高对比。 */
  color: var(--dsw-alias-label-primary, #1f2329);
  font-weight: 600;
}
.dsa-card-btn-primary:hover {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));
}
.dsa-card-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
/* 创建旁路会话时的进行态：只读提示，不给可点按钮。 */
.dsa-card-status {
  box-sizing: border-box;
  padding: 10px 2px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
}
/* 创建失败时的错误条。用 catalog 内的 state-error-primary；
   不要发明 --dsw-alias-danger，那个名字在出厂主题上解析不出值。 */
.dsa-card-error {
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));
  color: var(--dsw-alias-state-error-primary, #d54941);
  font-size: 12px;
  line-height: 1.45;
}
@media (prefers-reduced-motion: reduce) {
  .dsa-button, .dsa-card-btn { transition: none; }
}
`;
/** Inject the style tag, owned by the client fiber (removed on dispose/HMR). */
export function injectStyle(ctx) {
    ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-selection-ask';
        tag.dataset.pluginCss = 'dsh-selection-ask/button.css';
        tag.textContent = buttonCss;
        document.head.appendChild(tag);
        return () => {
            tag.remove();
        };
    }, 'dsh-selection-ask: button css');
}
