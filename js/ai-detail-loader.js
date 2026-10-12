import { validateJob } from './ai-model.js';

export function detailURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('岗位详情链接无效。'); }
  if (url.origin !== 'https://www.zhipin.com' || !/^\/job_detail\/[^/]+\.html$/.test(url.pathname) || url.username || url.password) throw new Error('岗位详情链接无效。');
  return url;
}

export async function createJobTab(url) {
  try {
    return await chrome.tabs.create({ url, active: false });
  } catch (error) {
    // The in-app Owl browser rejects extension-created background tabs.
    // Retry in the foreground only for this specific browser restriction.
    if (!/Owl extension-created tabs must be active/i.test(error?.message || '')) throw error;
    return chrome.tabs.create({ url, active: true });
  }
}

export async function loadJobDetail(value, signal, assertActive, timeout = 20000) {
  const expected = detailURL(value);
  let tab;
  try {
    assertActive();
    tab = await createJobTab(expected.href);
    const deadline = Date.now() + timeout;
    let previous = '';
    while (Date.now() < deadline) {
      assertActive();
      if (signal.aborted) throw new Error('详情读取已停止。');
      let snapshot;
      try { snapshot = await chrome.tabs.sendMessage(tab.id, { type: 'ai/readDetailSnapshot' }); } catch { /* Reader may not have loaded yet. */ }
      assertActive();
      if (snapshot?.job) {
        const actual = detailURL(snapshot.url);
        if (actual.pathname !== expected.pathname || detailURL(snapshot.job.url).pathname !== expected.pathname) throw new Error('岗位详情与列表链接不一致，已跳过。');
        const job = validateJob(snapshot.job);
        if (job.scope !== 'detail') throw new Error('详情页未返回 JD 正文，已跳过。');
        const fingerprint = JSON.stringify(job);
        // Require two consecutive stable snapshots so a partially loaded JD is not analyzed.
        if (fingerprint === previous) return { ...job, url: expected.href };
        previous = fingerprint;
      } else previous = '';
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 400);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    throw new Error('未能读取完整 JD（可能需登录、验证，或岗位已下线），已跳过。');
  } finally {
    if (tab?.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
