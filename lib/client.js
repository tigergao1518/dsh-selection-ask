window.__ModuleLoader__.load({
	id: "dsh-selection-ask",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region lib/client/quote.js
		/**
		* Pure draft-quoting helpers (no DOM, no framework). Kept in their own module
		* so `scripts/verify.mjs` can exercise them offline after the build.
		*/
		/**
		* Turn a raw selection into a Markdown blockquote: one `> ` prefix per line.
		* Multi-line selections become a single quoted block.
		*/
		function buildQuote(selection) {
			return selection.split("\n").map((line) => `> ${line}`).join("\n");
		}
		/**
		* Append a quote to the current draft. An empty (or whitespace-only) draft is
		* replaced outright; otherwise the quote is appended on its own paragraph.
		* `setDraft` is a full-draft replace, so the join must happen here.
		*/
		function appendQuote(draft, quote) {
			return draft.trim() === "" ? quote : `${draft}\n\n${quote}`;
		}
		//#endregion
		//#region lib/client/sideAskClient.js
		/**
		* 浏览器半的旁路会话客户端。
		*
		* 静态客户端插件没有 `host.call`，所以与宿主半通信走所有出厂插件都在用的
		* 那条路：同源 POST 到 host 注册的 `/dsh-side-ask/rpc`。
		* 信封统一为 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
		*/
		/** host 半路由，与 `src/sideAskRpc.ts` 的 ROUTE_PATH 一致。 */
		const RPC_PATH = "/dsh-side-ask/rpc";
		/** RPC 失败时抛出，带 host 给的稳定 code。 */
		var SideAskError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
				this.name = "SideAskError";
			}
		};
		/** 把人类可读的原因映射给用户看。 */
		function describeSideAskError(error) {
			if (error instanceof SideAskError) switch (error.code) {
				case "parent-not-found": return "找不到当前会话，可能已关闭";
				case "parent-not-live": return "当前会话已归档，无法继承它的上下文";
				case "forbidden": return "请求被拒绝（非本机来源）";
				case "not-confirmed": return "创建请求未获确认";
				case "bad-request": return `请求参数有误：${error.message}`;
				default: return error.message || "创建旁路会话失败";
			}
			return error instanceof Error ? error.message : "创建旁路会话失败";
		}
		/** 构造旁路会话客户端。 */
		function createSideAskClient(deps) {
			/** 统一的 RPC 调用：发请求、解信封、把错误转成 SideAskError。 */
			async function call(method, params) {
				let payload;
				try {
					payload = await (await fetch(RPC_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						credentials: "same-origin",
						body: JSON.stringify({
							method,
							params: {
								...params,
								confirm: true
							}
						})
					})).json();
				} catch (error) {
					throw new SideAskError("network", error instanceof Error ? error.message : String(error));
				}
				if (payload?.ok !== true) throw new SideAskError(typeof payload?.error?.code === "string" ? payload.error.code : "internal", typeof payload?.error?.message === "string" ? payload.error.message : "");
				return payload.value ?? {};
			}
			return {
				async openSideSession(request) {
					const value = await call("createSideSession", {
						parentSessionId: request.parentSessionId,
						...request.atSeq === void 0 ? {} : { atSeq: request.atSeq },
						...request.agentPreset === void 0 ? {} : { agentPreset: request.agentPreset },
						...request.cwd === void 0 ? {} : { cwd: request.cwd },
						...request.firstMessage === void 0 || request.firstMessage === "" ? {} : { firstMessage: request.firstMessage }
					});
					const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
					if (sessionId === "") throw new SideAskError("internal", "宿主未返回子会话 id");
					deps.openSideAsk?.(sessionId);
					return {
						sessionId,
						inheritedEventCount: Number(value.inheritedEventCount ?? 0),
						agentPreset: typeof value.agentPreset === "string" ? value.agentPreset : "",
						persist: value.persist !== void 0 && typeof value.persist === "object" ? {
							ok: value.persist.ok === true,
							error: typeof value.persist.error === "string" ? value.persist.error : void 0
						} : void 0
					};
				},
				async openReviewSession(request) {
					const value = await call("openReviewSession", {
						targetSessionId: request.targetSessionId,
						cwd: request.cwd,
						...request.agentPreset === void 0 ? {} : { agentPreset: request.agentPreset }
					});
					const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
					if (sessionId === "") throw new SideAskError("internal", "宿主未返回复盘会话 id");
					deps.openSideAsk?.(sessionId);
					return {
						sessionId,
						agentPreset: typeof value.agentPreset === "string" ? value.agentPreset : "",
						digestTurns: Number(value.digestTurns ?? 0)
					};
				}
			};
		}
		//#endregion
		//#region lib/client/sideAskStore.js
		/**
		* 旁路会话客户端的 fiber 内单例。
		*
		* 单独放一个模块（而不是挂在 index.tsx 上）是为了避免循环引用：
		* 入口要注册用到它的组件，而那些组件又要 import 它。
		* 入口在 apply() 里 setSlot，其余模块只读。
		*/
		let client;
		/** 由 client 入口在 apply() 里调用一次。 */
		function setSideAskClient(next) {
			client = next;
		}
		/** 取旁路会话客户端；未就绪（服务不全或插件尚未加载）时为 undefined。 */
		function sideAsk() {
			return client;
		}
		/** 草稿有效期：超过就丢弃，避免陈旧文本突袭。 */
		const DRAFT_TTL_MS = 300 * 1e3;
		/** childSessionId → 待回填的草稿。 */
		const pendingDrafts = /* @__PURE__ */ new Map();
		/** 登记一条待回填草稿（由「开侧栏追问」调用）。 */
		function stagePendingDraft(sessionId, text) {
			if (typeof sessionId !== "string" || sessionId === "") return;
			if (text.trim() === "") return;
			pendingDrafts.set(sessionId, {
				text,
				at: Date.now()
			});
		}
		/** 取走并删除某会话的待回填草稿；没有或已过期则返回 undefined。 */
		function takePendingDraft(sessionId) {
			const entry = pendingDrafts.get(sessionId);
			if (entry === void 0) return void 0;
			pendingDrafts.delete(sessionId);
			if (Date.now() - entry.at > DRAFT_TTL_MS) return void 0;
			return entry.text;
		}
		//#endregion
		//#region lib/client/SelectionAskButton.js
		/** Gap (px) between the selection edge and the floating surface. */
		const GAP = 8;
		/** Viewport edge padding (px) used when clamping the floating position. */
		const MARGIN = 8;
		/** 取元素所属的会话根：`[data-conversation-scroll]` 就是整个会话面板。 */
		function conversationRootOf(node) {
			return node?.closest("[data-conversation-scroll]") ?? null;
		}
		/**
		* Read the current DOM selection when it qualifies for quoting: non-empty,
		* inside the conversation transcript (`[data-conversation-scroll]`) OR inside
		* an in-app document preview (`[data-document-preview]` / the rendered
		* markdown body / a text preview tab), but NOT inside the composer card
		* (quoting the draft back into itself is nonsense). Returns null otherwise —
		* including selections scrolled fully off-screen.
		*
		* `ownRoot` is the conversation this button instance belongs to (resolved from
		* its persistent anchor). Selections belonging to another conversation are
		* rejected — see the check below.
		*/
		function readSelection(ownRoot) {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
			const text = selection.toString().trim();
			if (!text) return null;
			const range = selection.getRangeAt(0);
			const ancestor = range.commonAncestorContainer;
			const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
			if (!node) return null;
			const inTranscript = node.closest("[data-conversation-scroll]");
			const inDocPreview = node.closest("[data-document-preview]") || node.closest("[data-document-markdown]") || node.closest("[data-textpreview-state]");
			if (!inTranscript && !inDocPreview) return null;
			if (node.closest("[data-composer-card]")) return null;
			if (inTranscript && (ownRoot === null || conversationRootOf(node) !== ownRoot)) return null;
			const rect = range.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) return null;
			if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null;
			return {
				text,
				rect
			};
		}
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
		function SelectionAskButton({ useInput, inputActions, sessionId }) {
			const draft = useInput((s) => s.draft);
			const [sel, setSel] = (0, react.useState)(null);
			const [mode, setMode] = (0, react.useState)("pill");
			const [pos, setPos] = (0, react.useState)(null);
			const [text, setText] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [sideAvailable, setSideAvailable] = (0, react.useState)(false);
			const pillRef = (0, react.useRef)(null);
			const cardRef = (0, react.useRef)(null);
			const anchorRef = (0, react.useRef)(null);
			const composingRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				setSideAvailable(sideAsk() !== void 0);
			}, []);
			const updateSelection = (0, react.useCallback)(() => {
				if (composingRef.current) return;
				setSel(readSelection(conversationRootOf(anchorRef.current)));
			}, []);
			(0, react.useEffect)(() => {
				document.addEventListener("selectionchange", updateSelection);
				document.addEventListener("mouseup", updateSelection);
				document.addEventListener("keyup", updateSelection);
				document.addEventListener("scroll", updateSelection, {
					capture: true,
					passive: true
				});
				window.addEventListener("resize", updateSelection);
				return () => {
					document.removeEventListener("selectionchange", updateSelection);
					document.removeEventListener("mouseup", updateSelection);
					document.removeEventListener("keyup", updateSelection);
					document.removeEventListener("scroll", updateSelection, { capture: true });
					window.removeEventListener("resize", updateSelection);
				};
			}, [updateSelection]);
			(0, react.useLayoutEffect)(() => {
				const el = mode === "pill" ? pillRef.current : cardRef.current;
				if (!sel || !el) {
					setPos(null);
					return;
				}
				const w = el.offsetWidth;
				const h = el.offsetHeight;
				let left = sel.rect.right - w;
				let top = sel.rect.top - h - GAP;
				if (top < MARGIN) top = sel.rect.bottom + GAP;
				left = Math.min(Math.max(MARGIN, left), window.innerWidth - w - MARGIN);
				top = Math.min(Math.max(MARGIN, top), window.innerHeight - h - MARGIN);
				setPos({
					top,
					left
				});
			}, [sel, mode]);
			(0, react.useEffect)(() => {
				if (mode !== "compose") return;
				const ta = cardRef.current?.querySelector("textarea");
				if (ta) {
					ta.focus({ preventScroll: true });
					ta.setSelectionRange(ta.value.length, ta.value.length);
				}
			}, [mode]);
			const close = (0, react.useCallback)(() => {
				composingRef.current = false;
				setMode("pill");
				setSel(null);
				setPos(null);
				setText("");
				setNotice("");
			}, []);
			const openCompose = (0, react.useCallback)(() => {
				if (!sel) return;
				composingRef.current = true;
				setText(buildQuote(sel.text) + "\n\n");
				setNotice("");
				setMode("compose");
				window.getSelection()?.removeAllRanges();
			}, [sel]);
			/** 「存入本会话」：把引用追加到当前输入框草稿，由用户自己发。 */
			const save = (0, react.useCallback)(() => {
				const body = text.trim();
				if (!body) {
					close();
					return;
				}
				inputActions.setDraft(appendQuote(draft, body));
				close();
			}, [
				text,
				draft,
				inputActions,
				close
			]);
			/**
			* 「开侧栏追问」：fork 主会话到当前轮，在右侧栏开一个旁路会话，
			* 并把「引用 + 问题」**带进那个会话的输入框，但不发送**。
			*
			* 继承边界取当前会话最后一条事件（host 侧省略 atSeq 即取最新），
			* 所以侧栏会话拿得到主会话到目前为止的全部上下文；
			* 追问沿用主会话的预设与模型，问完即弃。
			*/
			const askInSidebar = (0, react.useCallback)(async () => {
				const body = text.trim();
				if (!body) {
					close();
					return;
				}
				const client = sideAsk();
				if (client === void 0 || typeof sessionId !== "string" || sessionId === "") {
					setNotice("当前会话不可用，无法开侧栏追问");
					return;
				}
				setMode("sending");
				setNotice("正在准备侧栏会话…");
				try {
					const result = await client.openSideSession({
						parentSessionId: sessionId,
						agentPreset: void 0
					});
					stagePendingDraft(result.sessionId, body);
					if (result.persist !== void 0 && result.persist.ok !== true) {
						setNotice(`侧栏会话未能落盘，发送可能失败：${result.persist.error ?? "未知原因"}`);
						return;
					}
					close();
				} catch (error) {
					setMode("compose");
					setNotice(describeSideAskError(error));
				}
			}, [
				text,
				sessionId,
				close
			]);
			const onCardKeyDown = (event) => {
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					save();
				} else if (event.key === "Escape") {
					event.preventDefault();
					close();
				}
			};
			const anchor = (0, react_jsx_runtime.jsx)("span", {
				ref: anchorRef,
				"aria-hidden": "true",
				className: "dsa-anchor"
			});
			if (!sel) return anchor;
			const style = pos ? {
				position: "fixed",
				top: pos.top,
				left: pos.left
			} : {
				position: "fixed",
				top: -9999,
				left: -9999,
				opacity: 0
			};
			if (mode === "sending") return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [anchor, (0, react_jsx_runtime.jsx)("div", {
				ref: cardRef,
				className: "dsa-card",
				style,
				onMouseDown: (event) => event.stopPropagation(),
				children: (0, react_jsx_runtime.jsx)("div", {
					className: "dsa-card-status",
					children: notice || "正在准备侧栏会话…"
				})
			})] });
			if (mode === "compose") return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [anchor, (0, react_jsx_runtime.jsxs)("div", {
				ref: cardRef,
				className: "dsa-card",
				style,
				onMouseDown: (event) => event.stopPropagation(),
				children: [
					(0, react_jsx_runtime.jsx)("textarea", {
						className: "dsa-card-input",
						value: text,
						onChange: (event) => setText(event.target.value),
						onKeyDown: onCardKeyDown,
						placeholder: "补充你的问题或评论…"
					}),
					notice !== "" && (0, react_jsx_runtime.jsx)("div", {
						className: "dsa-card-error",
						children: notice
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dsa-card-actions",
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "dsa-card-hint",
								children: sideAvailable ? "Enter 存入本会话 · Shift+Enter 换行 · Esc 取消" : "Enter 保存 · Shift+Enter 换行 · Esc 取消"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsa-card-btn",
								onMouseDown: (event) => event.preventDefault(),
								onClick: close,
								children: "取消"
							}),
							sideAvailable && (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsa-card-btn",
								onMouseDown: (event) => event.preventDefault(),
								onClick: () => void askInSidebar(),
								title: "在右侧栏开一个继承当前上下文的新会话追问，不打断主会话",
								children: "开侧栏追问"
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsa-card-btn dsa-card-btn-primary",
								onMouseDown: (event) => event.preventDefault(),
								onClick: save,
								title: "把引用追加到当前会话的输入框，由你决定何时发送",
								children: "存入本会话"
							})
						]
					})
				]
			})] });
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [anchor, (0, react_jsx_runtime.jsx)("button", {
				ref: pillRef,
				type: "button",
				className: "dsa-button",
				style,
				onMouseDown: (event) => event.preventDefault(),
				onClick: openCompose,
				children: "询问 DeepSeek"
			})] });
		}
		//#endregion
		//#region lib/client/styles.js
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
		const buttonCss = `
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
		function injectStyle$1(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-selection-ask";
				tag.dataset.pluginCss = "dsh-selection-ask/button.css";
				tag.textContent = buttonCss;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "dsh-selection-ask: button css");
		}
		//#endregion
		//#region lib/client/sideAskTab.js
		/**
		* 右侧栏「旁路会话」tab。
		*
		* 目标：在右侧栏里渲染「另一个会话的完整官方对话」——输入框、工具卡片、
		* 审批、流式渲染全部复用官方那一套，不自己画。
		*
		* 实现照官方子代理对话（ui-subagent 的 registerSidebarChat）那一套，
		* 因为那是右侧栏嵌入另一个会话对话的唯一正路。但有两处**必须**与官方不同，
		* 否则插件根本加载不起来（slot 系统对重复注册是抛异常，不是覆盖）：
		*
		*   1. `sidebar.chat.conversation` 是 single 插槽，官方子代理 tab 已经占用。
		*      SlotCore.register 对 single 插槽遇到同优先级占用会直接 throw
		*      （`single slot ... already has a registration`）。
		*      → 本插件声明并使用**自己的**子插槽 `side-ask.conversation`。
		*
		*   2. `sidebar.right.pane.tab` 的 `children` 表同样会查重
		*      （`slot ... is already declared`），所以子插槽名绝不能撞官方的。
		*
		* 于是链路变成：
		*   资源协议 side-ask ──→ tab 类型 side-ask ──→ tab 正文（自己的 key）
		*       └─ children 声明独有子插槽 side-ask.conversation
		*            └─ 正文里 renderSlot 渲染它，内容 = 官方 conversation.content 工厂
		*/
		/** 资源协议名。 */
		const SIDE_ASK_PROTOCOL = "side-ask";
		/** tab 类型 id，也是 `sidebar.right.pane.tab` 的 key。 */
		const SIDE_ASK_TAB_ID = "side-ask";
		/** 资源地址前缀。 */
		const SIDE_ASK_ADDRESS = `dsh-resource://${SIDE_ASK_PROTOCOL}/session/`;
		/**
		* 本插件独有的子插槽名。
		* 不能用官方的 `sidebar.chat.conversation`——那是 single 插槽且已被占用，
		* 重复注册会抛异常。加插件自己的前缀即可既表达同一用途又避开冲突。
		*/
		const SIDE_ASK_CONVERSATION_SLOT = "side-ask.conversation";
		/** 把地址字符串解析成 `{ sessionId }`，不合法返回 undefined。 */
		function parseSideAskAddress(address) {
			if (typeof address !== "string" || !address.startsWith(SIDE_ASK_ADDRESS)) return void 0;
			const sessionId = address.slice(SIDE_ASK_ADDRESS.length).split("?", 1)[0] ?? "";
			return sessionId === "" ? void 0 : {
				kind: "session",
				sessionId
			};
		}
		/** 由 sessionId 生成资源地址。 */
		function sideAskAddressFor(sessionId) {
			return `${SIDE_ASK_ADDRESS}${encodeURIComponent(sessionId)}`;
		}
		/**
		* 固定为 Chat 视图的嵌入对话。
		* 与官方子代理 tab 同一处理：把局部 View 钉在 chat，省略主会话的页头与宽度控制。
		*/
		function FixedChatConversationView(props) {
			return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: props.renderSlot("conversation.session", { view: "chat" }) });
		}
		/**
		* 渲染官方对话工厂 `conversation.content`。
		*
		* `variant: 'embedded'` 是官方给「嵌在别处的一次对话」用的形态；
		* phase 与官方一致：settling（还在加载）→ hero（空白会话）→ active。
		* 旁路会话总是带着父会话前缀，所以正常路径就是 active。
		*/
		function SideAskConversation(props) {
			const session = props.useSession((value) => value);
			const conversation = props.useConversation((value) => value);
			const sessions = props.useSessions((state) => state);
			const shellPhase = (conversation?.activeTargets?.size ?? 0) > 0 || !session?.blank ? "active" : session?.promptAttempted ? "engaging" : "blank";
			const summaryBlank = sessions?.byId?.[props.sessionId]?.blank;
			const settling = shellPhase === "blank" && session?.openState === "loading" && summaryBlank !== true;
			const hero = shellPhase === "blank" && (session?.openState === "open" || summaryBlank === true);
			return props.renderFactorySlot("conversation.content", {
				variant: "embedded",
				phase: settling ? "settling" : hero ? "hero" : "active",
				hero
			}, { slots: { views: FixedChatConversationView } }) ?? null;
		}
		/**
		* tab 正文。
		*
		* ⚠️ 结构上有个必须遵守的约束：**`SessionProvider` 必须无条件挂载**。
		*
		* 曾经写成「`resource.value === undefined` 就先 return null、有了再渲染
		* SessionProvider」，结果 React 报 #310（Rendered more hooks than during the
		* previous render）：resource 从「未就绪」变成「就绪」时整棵树的 hooks
		* 数量变了。SessionProvider 内部是带 hooks 的组件，不能时而挂载时而消失。
		*
		* 所以这里是「SessionProvider 始终渲染，未就绪的判断放进它的 children」。
		*/
		function SideAskTab(props) {
			const { tab } = props.useTabInfo();
			const resource = props.useResource(tab.contentId);
			const ready = resource.value !== void 0;
			return (0, react_jsx_runtime.jsx)("div", {
				"data-side-ask": "",
				className: "dsq-side-ask",
				children: props.SessionProvider({
					session: ready ? resource.value.reference : void 0,
					children: ready ? props.renderSlot(SIDE_ASK_CONVERSATION_SLOT, {}) : (0, react_jsx_runtime.jsx)("div", {
						className: "dsq-side-ask-loading",
						children: "正在载入会话…"
					})
				})
			});
		}
		/**
		* 资源提供者：`open()` 里 retain 目标会话，tab 关闭时 release。
		* 与官方 subagent 资源同构——直接按地址取引用，不刷新任何目录。
		*/
		function sideAskResourceProvider(sessions) {
			return {
				protocol: SIDE_ASK_PROTOCOL,
				async *open(resourceAddress, { signal }) {
					const address = parseSideAskAddress(resourceAddress);
					if (address === void 0) throw new Error(`dsh-selection-ask: 非法旁路会话地址 "${resourceAddress}"`);
					if (signal.aborted) return;
					const reference = sessions.retain(address.sessionId, {
						source: "sideAsk",
						signal
					});
					try {
						yield {
							ok: true,
							value: {
								address,
								reference
							}
						};
						await new Promise((resolve) => {
							if (signal.aborted) {
								resolve();
								return;
							}
							signal.addEventListener("abort", () => resolve(), { once: true });
						});
					} finally {
						reference.release();
					}
				}
			};
		}
		/** 外层容器样式（对话本体是官方的，这里只保证容器能吃满高度）。 */
		const SIDE_ASK_CSS = `
.dsq-side-ask {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.dsq-side-ask-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 16px;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
  font-size: 13px;
}
/*
 * 开始页入口胶囊。
 *
 * 只使用已发布的主题 token catalog（Theme.listTokens 那 14 个）。
 * 踩过的坑：用过 catalog 外的 --dsw-alias-label-tertiary 等名字，
 * 出厂主题上解析不出值，浅色主题下图标/文字几乎不可见。
 */
.dsq-guide-entry {
  box-sizing: border-box;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 88px;
  max-width: 132px;
  padding: 14px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.04));
  color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.dsq-guide-entry:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08));
}
.dsq-guide-entry:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsq-guide-entry:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dsq-guide-entry-glyph {
  display: inline-flex;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
}
.dsq-guide-entry-glyph svg {
  width: 22px;
  height: 22px;
}
.dsq-guide-entry-text {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  text-align: center;
}
.dsq-guide-entry-desc {
  font-size: 11px;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
  text-align: center;
}
`;
		/** 注入样式，随 fiber 生命周期清理。 */
		function injectStyle(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-selection-ask";
				tag.dataset.pluginCss = "dsh-selection-ask/side-ask.css";
				tag.textContent = SIDE_ASK_CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "dsh-selection-ask: side-ask css");
		}
		/**
		* 挂载右侧栏旁路会话 tab。
		*
		* @param ctx - 需要 `resources`、`sessions`、`slots`、`sidebarRightTabs` 四个 client 服务。
		* @returns 打开一个旁路会话 tab 的函数；服务不全时返回 undefined（插件其余部分仍可用）。
		*/
		function mountSideAskTab(ctx) {
			const slots = ctx.get("slots");
			const sessions = ctx.get("sessions");
			const resources = ctx.get("resources");
			const sidebarRightTabs = ctx.get("sidebarRightTabs");
			const sidebarRight = ctx.get("sidebarRight");
			if (slots === void 0 || resources === void 0 || sidebarRightTabs === void 0) return;
			injectStyle(ctx);
			ctx.effect(() => resources.register(sideAskResourceProvider(sessions)), "dsh-selection-ask: side-ask resources");
			ctx.effect(() => sidebarRightTabs.register({
				id: SIDE_ASK_TAB_ID,
				kind: SIDE_ASK_PROTOCOL,
				patterns: [`${SIDE_ASK_ADDRESS}**`],
				priority: "addon",
				canOpen: (address) => parseSideAskAddress(address) !== void 0,
				title: (address) => {
					const parsed = parseSideAskAddress(address);
					if (parsed === void 0) return "旁路会话";
					const title = sessions.list.getSnapshot().byId[parsed.sessionId]?.title;
					return typeof title === "string" && title !== "" ? title : "旁路会话";
				},
				guide: [{
					id: "side-ask-start",
					order: 20,
					title: () => "发起旁路对话",
					description: () => "继承当前上下文，不打断主会话"
				}]
			}), "dsh-selection-ask: side-ask tab type");
			ctx.effect(() => slots.inject("sidebar.right.tab.guide.entry", () => slots.register({
				name: "sidebar.right.tab.guide.entry",
				key: SIDE_ASK_TAB_ID
			}, (props) => (0, react_jsx_runtime.jsx)(SideAskGuideEntry, {
				...props,
				openSideSession: openViaGuide
			}))), "dsh-selection-ask: side-ask guide entry");
			ctx.effect(() => slots.inject("sidebar.right.pane.tab", () => slots.register({
				name: "sidebar.right.pane.tab",
				key: SIDE_ASK_TAB_ID,
				children: { [SIDE_ASK_CONVERSATION_SLOT]: {
					kind: "single",
					scope: "session"
				} }
			}, (props) => (0, react_jsx_runtime.jsx)(SideAskTab, { ...props }))), "dsh-selection-ask: side-ask tab body");
			ctx.effect(() => slots.inject(SIDE_ASK_CONVERSATION_SLOT, () => slots.register({ name: SIDE_ASK_CONVERSATION_SLOT }, (props) => (0, react_jsx_runtime.jsx)(SideAskConversation, { ...props }))), "dsh-selection-ask: side-ask conversation");
			const openBySessionId = (sessionId) => {
				if (typeof sidebarRight?.openResource !== "function") return;
				sidebarRight.openResource(sideAskAddressFor(sessionId));
			};
			const openViaGuide = async (currentSessionId) => {
				const client = sideAsk();
				if (client === void 0 || typeof currentSessionId !== "string" || currentSessionId === "") return;
				try {
					const result = await client.openSideSession({
						parentSessionId: currentSessionId,
						agentPreset: void 0
					});
					if (result.persist !== void 0 && result.persist.ok !== true) console.error(`[dsh-selection-ask] 旁路会话未落盘，侧栏发送将报 SessionPersistenceNotFoundError：${result.persist.error ?? "未知原因"}`);
				} catch (error) {
					console.warn("[dsh-selection-ask] 开始页发起旁路对话失败:", describeSideAskError(error));
				}
			};
			return openBySessionId;
		}
		/**
		* 开始页里的「发起旁路对话」入口。
		*
		* 官方默认渲染器（EntryBox）点击后只 `openTab(kind)` 开一个**空 tab**——
		* 没有 address，SideAskTab 会一直停在「正在载入会话」。
		* 所以这里自己画一个胶囊：点击先 fork 旁路会话，再用 address 打开。
		*
		* props 由框架传入：`entryId` / `kind` / `title` / `description`（来自 tab 注册的
		* guide 字段），加上 session 标准 kit 里的 `sessionId`（当前会话）。
		*/
		function SideAskGuideEntry(props) {
			const title = typeof props.title === "function" ? props.title() : props.title;
			const description = typeof props.description === "function" ? props.description() : props.description;
			const onClick = () => {
				if (typeof props.sessionId === "string" && props.sessionId !== "") props.openSideSession?.(props.sessionId);
			};
			const disabled = typeof props.sessionId !== "string" || props.sessionId === "";
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dsq-guide-entry",
				disabled,
				title: disabled ? "需要先打开一个会话" : "开一个继承当前上下文的旁路会话，不打断主会话",
				onClick,
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						key: "glyph",
						className: "dsq-guide-entry-glyph",
						"aria-hidden": true,
						children: (0, react_jsx_runtime.jsx)("svg", {
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: 2,
							strokeLinecap: "round",
							strokeLinejoin: "round",
							children: [(0, react_jsx_runtime.jsx)("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }, "a")]
						})
					}),
					(0, react_jsx_runtime.jsx)("span", {
						key: "text",
						className: "dsq-guide-entry-text",
						children: title ?? "发起旁路对话"
					}),
					description === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
						key: "desc",
						className: "dsq-guide-entry-desc",
						children: description
					})
				]
			});
		}
		//#endregion
		//#region lib/client/reviewEntry.js
		/**
		* 会话头「复盘本会话」入口。
		*
		* 点它在右侧栏开一个**只读**复盘会话。三条关键设计：
		*
		* 1. **新开会话，不 fork** —— fork 出的会话已经「开始过」，官方
		*    `agent-preset/locked` 拒绝再切预设，只读约束就落不了地。新开会话的
		*    id 不在 store 里，`meta.agentPreset` 能一步把只读工具集定死。
		*
		* 2. **数据来自日志文件，不是对话继承** —— host 侧读取并解压该会话的
		*    `session.v4.jsonl.zstd`，提炼出每轮 token / 工具调用 / 报错 / 耗时，
		*    作为复盘的第一段输入。这样复盘有据可依，而不是靠模型回忆。
		*
		* 3. **细节可回查** —— 复盘会话挂着 `read_session_log` 工具，需要看某轮
		*    到底发生了什么时按需查原始事件，不必把整份日志塞进上下文。
		*
		* 于是「复盘不占用工作区对话任务」成立：
		*   - 主会话的任务流不被打断，也不被复盘内容污染；
		*   - 复盘会话的工具集是只读的，即便跑偏也碰不坏工作区；
		*   - 复盘结论由人带回主会话，而不是自动写回去。
		*
		* 挂载点：`conversation.session.header.utilities`（会话头右侧功能区，
		* 官方 schedule 插件也在这里注册条目）。
		*/
		/** 图标：回看时钟（描边风格，与官方图标行一致）。 */
		function ReviewIcon() {
			return (0, react_jsx_runtime.jsx)("svg", {
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M3 12a9 9 0 1 0 3-6.7" }, "a"),
					(0, react_jsx_runtime.jsx)("path", { d: "M3 4v5h5" }, "b"),
					(0, react_jsx_runtime.jsx)("path", { d: "M12 7v5l4 2" }, "c")
				]
			});
		}
		/** 复盘入口按钮。 */
		function ReviewEntry({ sessionId, cwd }) {
			const onClick = async () => {
				const client = sideAsk();
				if (client === void 0 || typeof sessionId !== "string" || sessionId === "") return;
				if (typeof cwd !== "string" || cwd === "") {
					console.warn("[dsh-selection-ask] 复盘入口拿不到会话的工作目录，无法新开复盘会话");
					return;
				}
				try {
					await client.openReviewSession({
						targetSessionId: sessionId,
						cwd
					});
				} catch (error) {
					console.warn("[dsh-selection-ask] 复盘入口失败:", describeSideAskError(error));
				}
			};
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dsq-review-btn",
				title: "在右侧栏开一个只读复盘会话：读本会话的日志分析报错、上下文、跑偏与可回退点，不碰工作区",
				"aria-label": "复盘本会话",
				onClick: () => void onClick(),
				children: (0, react_jsx_runtime.jsx)(ReviewIcon, {})
			});
		}
		/**
		* 入口按钮样式。
		*
		* 只使用已发布的主题 token catalog（Theme.listTokens 列出的 14 个）：
		* bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2 /
		* brand-primary / label-primary / label-secondary / state-* / sidebar-fill。
		*
		* 不要发明 `--dsw-alias-label-tertiary`、`--dsw-alias-interactive-bg-hover`、
		* `--dsw-radius-sm` 这类 catalog 外的名字——它们在出厂主题上解析不出值：
		* 前者让图标在浅色主题下变成几乎看不见的浅灰，正是 0.3.0 首版踩的坑。
		* 尺寸同理，一律写固定值。
		*/
		const REVIEW_CSS = `
.dsq-review-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  /* label-secondary 在 catalog 内；tertiary 不在，勿用。 */
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
  cursor: pointer;
}
.dsq-review-btn svg {
  width: 15px;
  height: 15px;
}
.dsq-review-btn:hover {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dsq-review-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
`;
		//#endregion
		//#region lib/client/SideDraftRestore.js
		/**
		* 旁路会话的草稿回填器。
		*
		* 「开侧栏追问」的预期是**把文本带进侧栏会话的输入框、但不发送**。
		* 点击时文本暂存在 `pendingDrafts`（按 childSessionId 索引），
		* 这个条目在子会话的 composer 挂载时把它取出来写进输入框。
		*
		* 挂在 `conversation.input.left`（session-scoped，输入框工具行左侧）：
		* 该条目无可见界面，纯粹是个执行时机——子会话一渲染就会挂载。
		* 机制与 dsh-turn-actions 的回填器相同，那条路已实测可用。
		*/
		function SideDraftRestore({ sessionId, inputActions }) {
			(0, react.useEffect)(() => {
				if (typeof sessionId !== "string" || sessionId === "") return void 0;
				const RETRIES = 6;
				const STEP_MS = 100;
				const WRITE_DELAY_MS = 80;
				let attempt = 0;
				let timer;
				const run = () => {
					const text = takePendingDraft(sessionId);
					if (text === void 0) {
						attempt += 1;
						if (attempt < RETRIES) timer = setTimeout(run, STEP_MS);
						return;
					}
					timer = setTimeout(() => {
						try {
							inputActions?.setDraft(text);
						} catch {}
					}, WRITE_DELAY_MS);
				};
				run();
				return () => {
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [sessionId, inputActions]);
			return null;
		}
		//#endregion
		//#region lib/client/index.js
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
		const inject = [
			"slots",
			"resources",
			"sessions",
			"sidebarRightTabs",
			"sidebarRight"
		];
		function apply(ctx) {
			injectStyle$1(ctx);
			setSideAskClient(createSideAskClient({ openSideAsk: mountSideAskTab(ctx) }));
			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "dsh-selection-ask"
			}, SelectionAskButton));
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-selection-ask";
				tag.dataset.pluginCss = "dsh-selection-ask/review-entry.css";
				tag.textContent = REVIEW_CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "dsh-selection-ask: review entry css");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-selection-ask-draft-restore"
			}, SideDraftRestore));
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "dsh-selection-ask-review",
				order: 20
			}, (props) => {
				const sessionId = props.sessionId ?? "";
				let cwd = typeof props.cwd === "string" ? props.cwd : void 0;
				if (cwd === void 0 && sessionId !== "") try {
					cwd = (ctx.get("sessions")?.list?.getSnapshot?.())?.byId?.[sessionId]?.cwd;
				} catch {}
				return (0, react_jsx_runtime.jsx)(ReviewEntry, {
					sessionId,
					cwd
				});
			}));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map