(function () {
  'use strict';

  const host = document.createElement('div');
  host.id = 'ai-job-matcher-launcher';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; left: 24px; bottom: 24px; z-index: 2147483646; }
      button { font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        color: #fff; background: #176b4b; border: 0; border-radius: 12px; padding: 13px 18px;
        box-shadow: 0 8px 24px #14281f40; cursor: pointer; }
      button:hover { background: #105b3e; }
      button:focus-visible { outline: 3px solid #78c9a3; outline-offset: 3px; }
    </style>
    <button type="button" aria-label="打开 AI 岗位匹配">AI 筛岗位 · 根据我的简历</button>`;
  shadow.querySelector('button').addEventListener('click', () => window.AIJobMatcher.open());

  function sync() {
    const isJobsPage = location.pathname.startsWith('/web/geek/jobs');
    if (isJobsPage && !host.isConnected && document.body) document.body.append(host);
    host.style.display = isJobsPage ? '' : 'none';
  }

  sync();
  // BOSS uses in-page navigation, so the same tab can enter or leave the job list.
  setInterval(sync, 1000);
})();
