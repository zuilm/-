(function () {
  'use strict';
  let stopped = false, acting = false;
  const visible = node => node && node.getClientRects().length > 0;
  const text = node => (node?.innerText || node?.textContent || '').trim();
  const normalized = value => String(value || '').replace(/\s+/g, '').toLowerCase();
  const find = (selectors, root = document) => [...root.querySelectorAll(selectors)].find(visible);
  const check = () => { if (stopped) throw new Error('发送已停止。'); };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  // The first contact opens a small dialog on the detail page, not #chat-input.
  // Bind its input, header and messages to the same subtree; never search page
  // text for a company (a recommended job or a message could contain it).
  function detailChat(job) {
    if (location.pathname !== new URL(job.url).pathname ||
        normalized(text(find('.job-banner .name h1, .job-banner h1, .job-detail h1'))) !== normalized(job.title)) return null;
    const inputs = [...document.querySelectorAll('textarea[placeholder="请简短描述您的问题"]')].filter(visible);
    if (inputs.length !== 1 || !job.company) return null;
    const input = inputs[0];
    for (let root = input.parentElement; root && root !== document.body; root = root.parentElement) {
      const headers = [...root.querySelectorAll('h3')].filter(visible);
      if (!headers.length) continue;
      const header = headers.find(node => [...node.querySelectorAll('*')].some(field =>
        !field.children.length && normalized(text(field).split(/[·•]/)[0]) === normalized(job.company)));
      if (!header) return null;
      // Cross-check the recruiter in the popup with the recruiter on this JD.
      const names = [...header.querySelectorAll('*')].filter(node => !node.children.length).map(text).filter(value => value && !/[·•]/.test(value));
      const recruiterMatches = names.some(name => [...document.querySelectorAll('.boss-info h2, .job-boss-info h2, h2')].filter(visible).some(node => {
        const value = normalized(text(node));
        const suffix = value.slice(normalized(name).length);
        return value.startsWith(normalized(name)) && /^(刚刚活跃|今日活跃|本周活跃|本月活跃|\d+分钟前活跃|\d+小时前活跃|\d+天前活跃|在线|)$/u.test(suffix);
      }));
      if (!recruiterMatches) return null;
      const send = [...root.querySelectorAll('button, a, [role="button"], span, div')].filter(visible).find(node => text(node) === '发送' && !node.children.length);
      if (!send) return null;
      return {root,header,input,send};
    }
    return null;
  }
  function ownMessage(content, chat) {
    if (!chat) return [...document.querySelectorAll('.item-my, .item-self')].filter(visible).some(node => text(node).includes(content));
    return [...chat.root.querySelectorAll('.item-my, .item-self')].filter(visible).some(node => text(node).includes(content)) ||
      [...chat.root.querySelectorAll('*')].filter(node => visible(node) && !node.children.length && /^(已发送|送达|已读)$/.test(text(node))).some(status => {
        for (let row = status.parentElement; row && row !== chat.root; row = row.parentElement) {
          if (row.querySelector('textarea')) return false;
          // A container holding the default greeting and an incoming reply must
          // never be mistaken for one outgoing AI message.
          const body = normalized(text(row)).replace(/^(已发送|送达|已读)/, '').replace(/(已发送|送达|已读)$/, '');
          if (body === normalized(content)) return true;
        }
        return false;
      });
  }
  function matches(job, phase) {
    if (phase === 'open') {
      if (location.pathname !== new URL(job.url).pathname) return false;
      const title = text(find('.job-banner .name h1, .job-banner h1, .job-detail h1'));
      return normalized(title) === normalized(job.title);
    }
    if (detailChat(job)) return true;
    const root = find('.position-content, .chat-job-info, .chat-position, .job-detail-box');
    if (!root) return false;
    const title = text(find('.position-name, .job-name, .job-title', root));
    if (normalized(title) !== normalized(job.title)) return false;
    // Require an exact visible company field, never infer identity from chat messages.
    const companies = [...document.querySelectorAll('.position-content .company-name, .chat-position .company-name, .chat-job-info .company-name, .chat-header .company-name, .chat-info .company-name, .chat-user-info .company-name, .chat-position .company, .position-content .company, .chat-info .company, li.active .name-box span:nth-child(2), li.selected .name-box span:nth-child(2)')].filter(visible).map(text);
    return !!job.company && companies.some(company => normalized(company) === normalized(job.company));
  }
  function probe(job, phase) {
    if (!matches(job, phase)) return { ready: false };
    if (phase === 'open') return { ready: !!find('a.op-btn-chat, .op-btn-chat, .btn-startchat, a.btn-chat') };
    return { ready: !!detailChat(job) || !!find('#chat-input') };
  }
  async function waitFor(get, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { check(); const value = get(); if (value) return value; await delay(200); }
    return null;
  }
  async function closeDetailChat(job) {
    const chat = detailChat(job);
    if (!chat) return {success:true,closed:false,status:'当前没有简易沟通窗'};
    const heading = chat.header.parentElement;
    const bounds = heading.getBoundingClientRect();
    const controls = [...heading.querySelectorAll('a, button, [role="button"]')].filter(visible);
    const named = controls.filter(node => /关闭|close/i.test([
      node.getAttribute('aria-label'), node.getAttribute('title'), node.className
    ].filter(Boolean).join(' ')));
    const icon = controls.filter(node => {
      const rect = node.getBoundingClientRect();
      return /^(?:|×|✕|✖)$/.test(text(node)) && rect.width > 0 && rect.width <= 64 && rect.height <= 64 &&
        rect.right >= bounds.right - 72 && rect.top <= bounds.top + 48;
    });
    const candidates = named.length === 1 ? named : icon;
    if (candidates.length !== 1) return {success:true,closed:false,status:'未能唯一定位沟通窗关闭按钮'};
    check();
    candidates[0].click();
    const closed = await waitFor(() => !detailChat(job), 2500);
    return {success:true,closed:!!closed,status:closed ? '已关闭简易沟通窗' : '点击关闭后沟通窗仍可见'};
  }
  async function action(message) {
    const {job, phase} = message;
    check();
    if (!matches(job, phase)) throw new Error('当前岗位或公司与 AI 筛选结果不一致，已停止发送。');
    if (phase === 'close') return closeDetailChat(job);
    if (phase === 'open') {
      if (detailChat(job)) return {success:true};
      const button = find('a.op-btn-chat, .op-btn-chat, .btn-startchat, a.btn-chat');
      if (!button || !/立即沟通|继续沟通|开始沟通|沟通/.test(text(button))) throw new Error('未找到可用的沟通按钮。');
      check(); if (button.tagName === 'A') button.target = '_self'; button.click();
      const modal = await waitFor(() => [...document.querySelectorAll('.greet-dialog a, .greet-dialog button, .dialog-container a, .dialog-container button, .boss-dialog a, .boss-dialog button, .default-btn')].find(node => visible(node) && /^(去聊天|进入聊天|立即聊天)$/.test(text(node))), 2500);
      if (modal) { check(); if (modal.tagName === 'A') modal.target = '_self'; modal.click(); }
      const chatLink = find('a[href*="/web/geek/chat"]');
      if (chatLink && !find('#chat-input') && !detailChat(job)) {
        const target = new URL(chatLink.href, location.href);
        if (target.origin === location.origin && target.pathname.startsWith('/web/geek/chat') && target.search) { check(); location.assign(target.href); }
      }
      return {success:true};
    }
    if (phase === 'greeting') {
      if (!Array.isArray(message.messages) || message.messages.length < 1 || message.messages.length > 3 || message.messages.some(value => typeof value !== 'string' || value.length < 10 || value.length > 100)) throw new Error('打招呼语格式无效。');
      // Send one job-specific introduction, rather than all alternate AI drafts.
      const content = message.messages[0];
      const chat = detailChat(job);
      const input = chat?.input || find('#chat-input');
      const sendButton = chat?.send || find('.btn-send');
      if (!input || !sendButton) throw new Error('聊天输入框或发送按钮不可用。');
      const existing = ownMessage(content, chat);
      if (existing) return {success:true,sent:false,status:'已有相同文案，未重复发送'};
      check(); input.focus();
      if ('value' in input) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        if (setter) setter.call(input, content); else input.value = content;
      } else {
        input.textContent = ''; document.execCommand('insertText', false, content);
        if (text(input) !== content) input.textContent = content;
      }
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      await delay(150); check();
      if (!matches(job, phase)) throw new Error('发送前会话发生变化，已停止。');
      if (chat && detailChat(job)?.input !== input) throw new Error('发送前聊天弹窗发生变化，已停止。');
      if (sendButton.disabled || sendButton.classList.contains('disabled')) throw new Error('聊天发送按钮不可用。');
      sendButton.click();
      const observed = await waitFor(() => matches(job, phase) && ownMessage(content, chat), 5000);
      if (!observed) throw new Error('已点击发送，但未确认消息出现在会话中；不会自动重发。');
      return {success:true,sent:true,status:'已确认打招呼语出现在会话中'};
    }
    if (phase === 'resume') {
      if (detailChat(job)) return {success:true,sent:false,status:'AI 岗位专属文案已发送；当前简易聊天窗口无附件入口，请在完整聊天页、对方回复后发送简历'};
      const previousCards = new Set([...document.querySelectorAll('.item-my, .item-self')].filter(node => node.querySelector('.message-resume, .resume-card, .resume-name, [class*="resume"]')));
      const button = await waitFor(() => [...document.querySelectorAll('.toolbar-btn')].find(node => visible(node) && text(node) === '发简历' && !node.classList.contains('unable') && !node.disabled), 8000);
      if (!button) return {success:true,sent:false,status:'BOSS 暂不允许发附件简历或入口不可用，请在对方回复后发送'};
      check(); if (!matches(job, phase)) throw new Error('发送附件前会话发生变化。');
      button.click();
      const panel = await waitFor(() => find('.panel-resume.sentence-popover, ul.resume-list'));
      if (!panel) return {success:true,sent:false,status:'未找到附件简历选择面板，请手动核对'};
      if (panel.matches('ul.resume-list')) {
        const items = [...panel.querySelectorAll('li.list-item')].filter(visible);
        const selected = message.resumeName ? items.find(item => text(item.querySelector('.resume-name')) === message.resumeName) : items.length === 1 ? items[0] : null;
        if (!selected) return {success:true,sent:false,status:'多份简历需要指定准确名称，或指定的简历不存在；未选择附件'};
        check(); selected.click();
      } else if (message.resumeName && text(panel.querySelector('.resume-name')) !== message.resumeName) {
        return {success:true,sent:false,status:'附件名称未匹配，未发送，请手动核对'};
      }
      const confirm = await waitFor(() => find('.panel-resume .btn-sure-v2, button.btn-v2.btn-sure-v2.btn-confirm'));
      if (!confirm || confirm.disabled) return {success:true,sent:false,status:'附件发送确认按钮不可用'};
      check(); if (!matches(job, phase)) throw new Error('确认发送前会话发生变化。');
      confirm.click();
      const observed = await waitFor(() => [...document.querySelectorAll('.item-my, .item-self')].some(node => !previousCards.has(node) && visible(node) && node.querySelector('.message-resume, .resume-card, .resume-name, [class*="resume"]')), 5000);
      return {success:true,sent:!!observed,status:observed ? '已确认附件卡片出现在会话中' : '已点击附件发送，未确认卡片；请核对会话，不会自动重发'};
    }
    throw new Error('未知的发送阶段。');
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (message.type === 'ai/stopApplication') { stopped = true; reply({success:true}); return; }
    if (message.type === 'ai/applicationProbe') { reply(probe(message.job, message.phase)); return; }
    if (message.type !== 'ai/applicationAction') return;
    if (acting) { reply({success:false,error:'已有发送操作进行中。'}); return; }
    acting = true;
    action(message).then(reply).catch(error => reply({success:false,error:error.message})).finally(() => {acting = false;});
    return true;
  });
})();
