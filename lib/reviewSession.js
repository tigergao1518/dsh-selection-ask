/**
 * 复盘会话的组装。
 *
 * 「复盘」与「选中追问」是两条不同的路径，差别在**要不要继承父会话的对话**：
 *
 * | | 选中追问 | 会话复盘 |
 * |---|---|---|
 * | 会话 | fork 父会话 | **新开会话** |
 * | 上下文 | 完整继承对话 | 不继承；改为读**日志文件**提炼过程数据 |
 * | 预设 | 继承父会话 | **指定只读预设，真正生效** |
 * | 数据 | 实时 | 从磁盘日志读，可重复读、可追溯 |
 *
 * 为什么复盘不 fork：fork 出的子会话已经「开始过」，官方
 * `agent-preset/locked` 拒绝再切预设，只读约束落不了地。新开会话的 id 不在
 * store 里，`meta.agentPreset` 能一步把只读工具集定死。
 *
 * 为什么复盘不继承对话：复盘需要的是**过程事实**（每轮花了多少、哪里报错、
 * 哪轮跑偏），不是把几万 token 的原对话再喂一遍。日志文件里有更准确、更省
 * 的答案；需要细节时模型还能用 `read_session_log` 回查原始事件。
 *
 * @module dsh-selection-ask/reviewSession
 */
import { readSessionLog, SessionLogError } from "./sessionLog.js";
import { digestSession, renderDigest } from "./sessionDigest.js";
import { locateSessionLog } from "./sessionLogLocate.js";
import { mountFreshSessionFactory, resolveRoute } from "./sideSession.js";
/** 复盘会话默认用的只读预设 id，与 profile 里 preset-session-review 一致。 */
export const REVIEW_PRESET_ID = 'session-review';
/** 摘要注入的上限：超过就截断，避免第一句话就把上下文顶满。 */
const MAX_DIGEST_CHARS = 12000;
/** 组装复盘会话的创建函数。 */
export function mountReviewSessionFactory(ctx, deps) {
    const createFreshSession = mountFreshSessionFactory(ctx);
    // 复盘会话要沿用被复盘会话在用的模型，所以取它的 agent 解析路由。
    const agents = ctx.get('agents');
    return async function createReviewSession(request) {
        // 1. 定位并读取被复盘会话的日志。
        const path = locateSessionLog(deps.sessionsRoot, request.targetSessionId);
        if (path === undefined) {
            throw new SessionLogError('not-found', `找不到会话 ${request.targetSessionId} 的日志文件，无法复盘`);
        }
        const log = readSessionLog(path, {
            readFile: deps.readFile,
            decompress: deps.decompress,
        });
        // 2. 提炼过程数据。
        const digest = digestSession(log.events);
        let digestText = renderDigest(digest);
        let truncated = false;
        if (digestText.length > MAX_DIGEST_CHARS) {
            digestText = `${digestText.slice(0, MAX_DIGEST_CHARS)}\n…（摘要过长已截断，可用 read_session_log 回查完整数据）`;
            truncated = true;
        }
        // 3. 组装复盘提示词：身份边界 + 数据 + 协议 + 工具用法。
        const firstMessage = [
            '请复盘下面这个会话的执行过程。',
            '',
            '你是复盘者，不是实现者：本次对话只做分析，不要修改任何文件、不要执行任何命令。',
            '',
            `## 被复盘的会话`,
            `会话 id：${request.targetSessionId}`,
            `日志：${log.frames} 帧 / ${log.events.length} 个事件` +
                `${log.skippedFrames > 0 ? `（有 ${log.skippedFrames} 个损坏帧被跳过，数据可能不全）` : ''}` +
                `${log.badLines > 0 ? `（有 ${log.badLines} 行无法解析）` : ''}`,
            '',
            '## 过程数据',
            '```',
            digestText,
            '```',
            truncated ? '（摘要已截断）' : '',
            '',
            '## 需要细节时',
            `用 read_session_log 工具回查原始事件：action=events、session_id=${request.targetSessionId}，`,
            '可以用 turn 指定轮次、type 筛选（tool / error / message）。',
            '比如「第 3 轮那 7 次报错到底是什么」就去查第 3 轮的 tool/result。',
            '',
            '## 复盘协议',
            '1. 先看上面的过程数据，找出可疑轮次：报错集中、重试异常多、',
            '   上下文接近窗口上限、耗时特别长的轮次。',
            '2. 对每个可疑轮次，用 read_session_log 查原始事件确认原因，',
            '   不要凭印象下结论。',
            '3. 按四类问题给结论，每类都要有轮次编号和证据：',
            '   - 报错与重试：失败是环境、参数还是工具选错？同类失败是否重复出现？',
            '   - 上下文膨胀：看「上下文组成」那一节，指出最大头是什么、该砍什么。',
            '     只说「token 多」不算结论——要说出是哪类内容在占地方、',
            '     以及具体怎么减（换工具、缩小输出、拆任务）。',
            '   - 跑偏轮次：哪几轮偏离了最初目标？之后有没有回到主线？',
            '   - 可回退点：哪些轮次可以安全放弃？回退能省什么、会丢什么？',
            '4. 结论落到「改什么」，按优先级：工作方式 → 提示词 → 插件配置 →',
            '   工具选择 → 回退。每条都要能被下一轮直接执行。',
            '',
            '## 输出格式',
            '固定四段：数据概览、四类问题、改进建议、回退建议。',
            '证据不足的地方明确写「证据不足」，不要用推测填补。',
        ]
            .filter((line) => line !== '')
            .join('\n');
        // 4. 模型路由：复盘会话是全新会话，没有父会话可继承，只能从「被复盘的
        //    会话」的 agent 上取——复盘入口就在那个会话里触发，它的 agent 一定在，
        //    且带着用户实际在用的路由。拿不到就拒绝建会话（建了也发不出消息）。
        const route = resolveRoute(agents?.get(request.targetSessionId));
        if (route === undefined) {
            throw new SessionLogError('no-route', `拿不到被复盘会话 ${request.targetSessionId} 的模型路由（provider/model），` +
                '无法创建复盘会话。请先在该会话里发一条消息，再发起复盘。');
        }
        // 5. 新开会话，预设真正生效。
        const record = await createFreshSession({
            cwd: request.cwd,
            agentPreset: request.agentPreset ?? REVIEW_PRESET_ID,
            firstMessage,
            route,
        });
        deps.log?.(`复盘会话已创建：${record.sessionId}（预设 ${record.agentPreset}，` +
            `基于 ${request.targetSessionId} 的 ${digest.turnCount} 轮数据）`);
        return {
            sessionId: record.sessionId,
            agentPreset: record.agentPreset,
            digestTurns: digest.turnCount,
        };
    };
}
