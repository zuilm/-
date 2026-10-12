import { detailURL, createJobTab } from './ai-detail-loader.js';

export async function runApplication(job, messages, resumeName, signal, assertActive, save) {
  let tab;
  const createdTabs = new Set();
  const track = child => {
    if (createdTabs.has(child.openerTabId)) { createdTabs.add(child.id); tab = child; }
  };
  const stop = () => {
    for (const id of createdTabs) chrome.tabs.sendMessage(id, { type: 'ai/stopApplication' }).catch(() => {});
  };
  const outcome = { greeting: '未发送', greetingSent: false, resume: '未发送', messages };
  try {
    assertActive();
    tab = await createJobTab(detailURL(job.url).href);
    createdTabs.add(tab.id);
    chrome.tabs.onCreated?.addListener(track);
    signal.addEventListener('abort', stop, { once:true });
    async function ready(phase, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        assertActive();
        let response;
        try { response = await chrome.tabs.sendMessage(tab.id, { type: 'ai/applicationProbe', job, phase }); } catch { /* navigation/loading */ }
        assertActive();
        if (response?.ready) return;
        if (response?.error) throw new Error(response.error);
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 300);
          signal.addEventListener('abort', done, { once: true });
        });
      }
      throw new Error(phase === 'open' ? '岗位沟通入口未加载或信息不匹配。' : '未找到与该岗位、公司对应的聊天窗口；已停止发送。');
    }
    async function action(phase) {
      assertActive();
      if (phase !== 'close') await save({ ...outcome, phase: `${phase}-started`, status: '执行中' });
      assertActive();
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'ai/applicationAction', job, phase, messages, resumeName });
      assertActive();
      if (!response?.success) throw new Error(response?.error || '操作响应丢失，请检查会话；不会自动重发。');
      return response;
    }
    await ready('open');
    // Opening communication may navigate before the reply arrives. Never retry the click.
    try { await action('open'); } catch (error) {
      assertActive();
      if (!/Receiving end does not exist|message port closed|channel closed|frame was removed/i.test(error.message)) throw error;
    }
    await ready('greeting', 25000);
    const greeting = await action('greeting');
    outcome.greeting = greeting.status;
    outcome.greetingSent = greeting.sent === true;
    await save({ ...outcome, phase: 'greeting-complete', status: '执行中' });
    const resume = await action('resume');
    outcome.resume = resume.status;
    const result = { ...outcome, phase: 'complete', status: resume.sent ? '打招呼和附件简历已发送' : '已打招呼，附件待处理', tabId: tab.id };
    await save(result);
    // The detail-page chat popup has no attachment control. Once the greeting
    // is confirmed, dismiss that popup while keeping the job tab for review.
    if (outcome.greetingSent && resume.sent !== true) {
      try {
        const closed = await action('close');
        result.communicationClosed = closed.closed === true;
        result.closeStatus = closed.status;
      } catch (error) {
        result.communicationClosed = false;
        result.closeStatus = `沟通窗未能自动关闭：${error.message}`;
      }
      await save(result);
    }
    // Close only after both sends are confirmed. Pending or ambiguous attachment
    // outcomes need the chat tab for manual inspection and completion.
    if (outcome.greetingSent && resume.sent === true) {
      stop();
      chrome.tabs.onCreated?.removeListener(track);
      for (const id of createdTabs) {
        try { await chrome.tabs.remove(id); createdTabs.delete(id); } catch { /* Already closed, or browser refused. */ }
      }
      result.tabClosed = createdTabs.size === 0;
      await save(result);
    }
    return result;
  } catch (error) {
    const result = { ...outcome, phase: 'interrupted', status: signal.aborted ? '已停止；请核对已发送内容' : '执行中断；请核对会话', error: error.message, tabId: tab?.id };
    await save(result);
    return result;
  } finally {
    signal.removeEventListener('abort', stop);
    chrome.tabs.onCreated?.removeListener(track);
    stop();
  }
}
