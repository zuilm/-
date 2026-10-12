import { CONFIG_KEY, PROMPT_VERSION, validateConfig, validateJob, buildMessages, buildGreetingMessages, parseModelResult, parseGreetingResult, recommendation } from './ai-model.js';
import { loadJobDetail } from './ai-detail-loader.js';
import { detailURL } from './ai-detail-loader.js';
import { runApplication } from './ai-application-runner.js';

// Resume and credentials belong to extension pages, not content scripts or the site.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const cache = new Map();
const requests = new Map();
const cancellations = new Map();
const APPLICATION_KEY = 'ai_application_history_v1';
const MATCHED_PREFIX = 'ai_matched_job_v1:';
const MATCHED_MAX_AGE = 6 * 60 * 60 * 1000;
let applicationOwner = null;
const configURL = chrome.runtime.getURL('ai-options.html');
let revision = 0;

async function configRead() {
  await ready;
  return validateConfig((await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {});
}

async function configSignature(config) {
  const bytes = new TextEncoder().encode(JSON.stringify([PROMPT_VERSION, config.endpoint, config.model, config.apiKey, config.resume, config.preferences]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

function matchedKey(owner, pathname) {
  return `${MATCHED_PREFIX}${owner}:${pathname}`;
}

async function clearMatchedJobs() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter(key => key.startsWith(MATCHED_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('请求来源无效。');
  if (sender.url === configURL) return 'settings';
  const url = new URL(sender.url || '');
  if (sender.tab?.id != null && (!sender.frameId || sender.frameId === 0) && url.origin === 'https://www.zhipin.com' && url.pathname.startsWith('/web/')) return 'page';
  throw new Error('请在 BOSS 直聘职位页使用 AI 匹配。');
}

async function analyze(config, job, sender, assertActive) {
  const owner = sender.tab?.id ?? 'settings';
  if (requests.has(owner)) throw new Error('已有分析正在进行，请等待或停止当前分析。');
  if (requests.size >= 3) throw new Error('同时分析的页面较多，请稍后再试。');
  const bytes = new TextEncoder().encode(JSON.stringify([PROMPT_VERSION, config.endpoint, config.model, config.resume, config.preferences, job]));
  const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
  assertActive();
  // Recheck after hashing so concurrent messages cannot both start a request.
  if (requests.has(owner)) throw new Error('已有分析正在进行。');
  if (cache.has(key)) return { result: cache.get(key), cached: true, recommendation: recommendation(cache.get(key), job.scope, config.threshold), model: config.model };
  const origin = new URL(config.endpoint).origin + '/*';
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('尚未允许访问模型服务，请打开 AI 设置重新保存。');
  assertActive();
  if (requests.has(owner)) throw new Error('已有分析正在进行。');
  const controller = new AbortController();
  requests.set(owner, controller);
  const startRevision = revision;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST', signal: controller.signal, credentials: 'omit', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: buildMessages(config, job), stream: false })
    });
    if (!response.ok) {
      const messages = { 401: 'API Key 无效或已过期。', 403: '模型服务拒绝访问，请检查账号权限。', 429: '模型服务限流或额度不足，请稍后重试。' };
      throw new Error(messages[response.status] || `模型服务请求失败（HTTP ${response.status}）。`);
    }
    const raw = await response.text();
    if (raw.length > 200000) throw new Error('模型返回的数据过大。');
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('接口未返回 JSON，请检查接口地址。'); }
    const result = parseModelResult(payload.choices?.[0]?.message?.content, config, job);
    if (controller.signal.aborted || revision !== startRevision) throw new Error('分析已停止或设置已更新，请重新分析。');
    cache.set(key, result);
    if (cache.size > 250) cache.delete(cache.keys().next().value);
    return { result, cached: false, recommendation: recommendation(result, job.scope, config.threshold), model: config.model };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? '模型响应超过 45 秒，请重试或更换模型。' : '分析已停止。');
    if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查网络、接口地址和访问权限。');
    throw error;
  } finally {
    clearTimeout(timer);
    if (requests.get(owner) === controller) requests.delete(owner);
  }
}

async function generateGreeting(config, job, sender, assertActive) {
  const owner = sender.tab?.id ?? 'settings';
  if (requests.has(owner)) throw new Error('已有 AI 请求正在进行，请等待或停止当前请求。');
  const bytes = new TextEncoder().encode(JSON.stringify(['greeting', PROMPT_VERSION, config.endpoint, config.model, config.resume, config.preferences, job]));
  const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  assertActive();
  if (cache.has(key)) return { ...cache.get(key), cached: true, model: config.model };
  const origin = new URL(config.endpoint).origin + '/*';
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('尚未允许访问模型服务，请打开 AI 设置重新保存。');
  assertActive();
  const controller = new AbortController();
  requests.set(owner, controller);
  const startRevision = revision;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      assertActive();
      const prompt = buildGreetingMessages(config, job);
      if (attempt > 0) prompt[0].content += '\n上次生成未通过格式校验。请重新生成，仅一条 40–80 字符的岗位专属文案，确保不超过 100 字符。严格返回 {"messages":["文案"]}，不要解释、不要额外字段。';
      const response = await fetch(config.endpoint, {
        method: 'POST', signal: controller.signal, credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages: prompt, stream: false })
      });
      if (!response.ok) {
        const messages = { 401: 'API Key 无效或已过期。', 403: '模型服务拒绝访问，请检查账号权限。', 429: '模型服务限流或额度不足，请稍后重试。' };
        throw new Error(messages[response.status] || `模型服务请求失败（HTTP ${response.status}）。`);
      }
      const raw = await response.text();
      if (raw.length > 200000) throw new Error('模型返回的数据过大。');
      let payload; try { payload = JSON.parse(raw); } catch { throw new Error('接口未返回 JSON，请检查接口地址。'); }
      assertActive();
      try { result = parseGreetingResult(payload.choices?.[0]?.message?.content); break; }
      catch (error) {
        if (attempt === 2) throw new Error(`打招呼语自动生成 3 次仍未通过校验；未打开沟通、未发送消息。${error.message}`);
      }
    }
    if (controller.signal.aborted || revision !== startRevision) throw new Error('生成已停止或设置已更新，请重试。');
    cache.set(key, result);
    if (cache.size > 250) cache.delete(cache.keys().next().value);
    return { ...result, cached: false, model: config.model };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? '模型响应超过 45 秒，请重试或更换模型。' : '生成已停止。');
    if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查网络、接口地址和访问权限。');
    throw error;
  } finally {
    clearTimeout(timer);
    if (requests.get(owner) === controller) requests.delete(owner);
  }
}

export async function handleAIMessage(message, sender) {
  try {
    const kind = senderKind(sender);
    if (message.type === 'ai/openSettings') { await chrome.runtime.openOptionsPage(); return { success: true }; }
    if (message.type === 'ai/saveConfig' || message.type === 'ai/clearConfig') {
      if (kind !== 'settings') throw new Error('请在扩展设置页修改简历和模型配置。');
      await ready;
      const next = message.type === 'ai/saveConfig' ? validateConfig(message.config) : null;
      if (!next && applicationOwner !== null) throw new Error('自动沟通正在执行，请先停止并等待完成，再清除全部 AI 数据。');
      revision++;
      for (const controller of requests.values()) controller.abort();
      cache.clear();
      await clearMatchedJobs();
      if (next) await chrome.storage.local.set({ [CONFIG_KEY]: next });
      else await chrome.storage.local.remove([CONFIG_KEY, APPLICATION_KEY]);
      return { success: true };
    }
    if (message.type === 'ai/cancel') {
      const owner = sender.tab?.id ?? 'settings';
      cancellations.set(owner, (cancellations.get(owner) || 0) + 1);
      requests.get(owner)?.abort();
      return { success: true };
    }
    if (message.type === 'ai/status') {
      try {
        const config = await configRead();
        return { success: true, configured: true, model: config.model, threshold: config.threshold, batchLimit: config.batchLimit };
      } catch { return { success: true, configured: false }; }
    }
    if (message.type === 'ai/readJobDetail') {
      if (kind !== 'page') throw new Error('请从 BOSS 直聘职位列表读取详情。');
      const owner = sender.tab.id;
      if (requests.has(owner) || requests.size >= 3) throw new Error('已有 AI 请求正在进行，请稍后重试。');
      const epoch = cancellations.get(owner) || 0;
      const startedRevision = revision;
      const controller = new AbortController();
      const assertActive = () => {
        if (controller.signal.aborted || (cancellations.get(owner) || 0) !== epoch || startedRevision !== revision) throw new Error('详情读取已停止或设置已更新。');
      };
      requests.set(owner, controller);
      try {
        return { success: true, job: await loadJobDetail(message.url, controller.signal, assertActive) };
      } finally {
        if (requests.get(owner) === controller) requests.delete(owner);
      }
    }
    if (message.type === 'ai/analyze') {
      const owner = sender.tab?.id ?? 'settings';
      const epoch = cancellations.get(owner) || 0;
      const startedRevision = revision;
      const assertActive = () => {
        if ((cancellations.get(owner) || 0) !== epoch || startedRevision !== revision) throw new Error('分析已停止或设置已更新，请重新分析。');
      };
      const config = await configRead();
      assertActive();
      const job = validateJob(message.job);
      const response = await analyze(config, job, sender, assertActive);
      assertActive();
      if (kind === 'page' && job.scope === 'detail' && message.job.url) {
        const url = detailURL(message.job.url);
        const signature = await configSignature(config);
        assertActive();
        const key = matchedKey(owner, url.pathname);
        const record = { job: { ...job, url: url.href }, result: response.result, signature, analyzedAt: Date.now() };
        await chrome.storage.local.set({ [key]: record });
        try { assertActive(); }
        catch (error) {
          if ((await chrome.storage.local.get(key))[key]?.analyzedAt === record.analyzedAt) await chrome.storage.local.remove(key);
          throw error;
        }
      }
      return { success: true, ...response };
    }
    if (message.type === 'ai/applyMatched') {
      if (kind !== 'page') throw new Error('请在 BOSS 职位列表启动 AI 自动沟通。');
      if (applicationOwner !== null) throw new Error('已有 AI 自动沟通正在执行，请先停止或等待完成。');
      const owner = sender.tab.id;
      const url = detailURL(message.url);
      const epoch = cancellations.get(owner) || 0;
      const startedRevision = revision;
      const controller = new AbortController();
      const assertActive = () => {
        if (controller.signal.aborted || (cancellations.get(owner) || 0) !== epoch || startedRevision !== revision) throw new Error('AI 自动沟通已停止或设置已更新。');
      };
      applicationOwner = owner;
      try {
        const config = await configRead();
        assertActive();
        const matched = (await chrome.storage.local.get(matchedKey(owner, url.pathname)))[matchedKey(owner, url.pathname)];
        const signature = await configSignature(config);
        assertActive();
        if (!matched || matched.signature !== signature || !Number.isFinite(matched.analyzedAt) || Date.now() - matched.analyzedAt > MATCHED_MAX_AGE ||
            matched.job?.scope !== 'detail' || detailURL(matched.job.url).pathname !== url.pathname) {
          throw new Error('该岗位的完整 JD 分析已失效，请重新筛选后勾选。');
        }
        const resumeName = String(message.resumeName || '').trim();
        if (resumeName.length > 300) throw new Error('附件简历名称过长。');
        const history = (await chrome.storage.local.get(APPLICATION_KEY))[APPLICATION_KEY] || {};
        assertActive();
        const previous = history[url.pathname];
        // Only this readiness failure proves no AI send was attempted. Ambiguous
        // send failures and completed contacts still require manual inspection.
        const recover = previous?.phase === 'interrupted' && previous.greetingSent === false &&
          previous.error === '未找到与该岗位、公司对应的聊天窗口；已停止发送。' &&
          previous.title === matched.job.title && previous.company === matched.job.company &&
          Array.isArray(previous.messages) && previous.messages.length > 0 &&
          previous.messages.every(value => typeof value === 'string' && value.length >= 10 && value.length <= 100);
        if (previous && !recover) return { success:true, application:{status:'本地已有执行记录，跳过重复沟通', ...previous, duplicate:true} };
        // Regenerate against the current resume and preferences; a previous
        // unsent draft may have been created before the settings changed.
        const greeting = await generateGreeting(config, matched.job, sender, assertActive);
        assertActive();
        requests.set(owner, controller);
        const save = async record => {
          history[url.pathname] = { ...record, title:matched.job.title, company:matched.job.company, updatedAt:new Date().toISOString() };
          await chrome.storage.local.set({ [APPLICATION_KEY]:history });
        };
        const application = await runApplication(matched.job, greeting.messages, resumeName, controller.signal, assertActive, save);
        return {success:true,application};
      } finally {
        if (requests.get(owner) === controller) requests.delete(owner);
        applicationOwner = null;
      }
    }
    throw new Error('未知的 AI 请求。');
  } catch (error) {
    return { success: false, message: error.message || 'AI 分析失败，请重试。' };
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  cancellations.set(tabId, (cancellations.get(tabId) || 0) + 1);
  requests.get(tabId)?.abort();
});
