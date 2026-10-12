(function () {
  'use strict';
  const text = node => (node?.innerText || node?.textContent || '').trim();
  const visible = node => node && node.getClientRects().length > 0;
  function read() {
    const first = selectors => {
      for (const selector of selectors) {
        const node = [...document.querySelectorAll(selector)].find(visible);
        if (text(node)) return text(node);
      }
      return '';
    };
    const description = first(['.job-sec-text', '.job-detail .text', '.job-detail-box .job-section .text']);
    const title = first(['.job-banner .name h1', '.job-banner h1', '.job-detail h1', '.job-detail-box .job-name']);
    if (!title || description.length < 40) return null;
    const meta = ['.job-banner .salary', '.job-banner .text', '.job-address'].map(selector => first([selector])).filter(Boolean);
    return {
      scope: 'detail', title: title.slice(0, 300),
      company: first(['.sider-company .company-info a', '.sider-company .company-info', '.company-name']).slice(0, 300),
      text: [...meta, description].join('\n').slice(0, 16000), url: location.href
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message.type !== 'ai/readDetailSnapshot') return;
    reply({ job: read(), url: location.href });
  });
})();
