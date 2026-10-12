import { handleAIMessage } from './js/ai-background.js';

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (typeof request?.type !== 'string' || !request.type.startsWith('ai/')) return false;
  handleAIMessage(request, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ success: false, message: 'AI 服务发生异常，请重试。' }));
  return true;
});
