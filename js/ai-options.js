import { CONFIG_KEY, DEFAULT_ENDPOINT, validateConfig, preferenceItems } from './ai-model.js';
import { createConfigFile, parseConfigFile } from './ai-config-file.js';
const $ = id => document.getElementById(id);
const fields = { endpoint:'endpoint', model:'model', apiKey:'api-key', resume:'resume', preferences:'preferences', threshold:'threshold', batchLimit:'batch-limit' };
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function fillForm(config) { for (const [key,id] of Object.entries(fields)) $(id).value = config[key] ?? ''; }
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.success) throw new Error(response?.message || '扩展后台未响应，请重新加载扩展。');
  return response;
}
try {
  const saved = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  if (saved) fillForm(saved);
  else $('endpoint').value = DEFAULT_ENDPOINT;
} catch { status('设置读取失败，请重新加载扩展。', true); }

$('config-form').addEventListener('submit', async event => {
  event.preventDefault();
  let config;
  try { config = validateConfig(Object.fromEntries(Object.entries(fields).map(([key,id]) => [key, $(id).value]))); }
  catch (error) { status(error.message, true); return; }
  $('save').disabled = true;
  try {
    // Request only the selected provider's origin, during this explicit user gesture.
    const granted = await chrome.permissions.request({ origins: [new URL(config.endpoint).origin + '/*'] });
    if (!granted) throw new Error('未获得该模型服务的访问权限，设置尚未保存。');
    await send({ type: 'ai/saveConfig', config });
    status(`已保存，求职偏好 ${preferenceItems(config.preferences).length} 条。回到 BOSS 职位页重新分析岗位，使新偏好生效。`);
  } catch (error) { status(error.message, true); }
  finally { $('save').disabled = false; }
});

$('resume-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 150000) throw new Error('请选择小于 150 KB 的 TXT 或 Markdown 文件。');
    const text = await file.text();
    if (text.length > 20000) throw new Error('简历超过 20000 字符，请先精简。');
    $('resume').value = text;
    status('简历已导入，请检查内容后保存设置。');
  } catch (error) { status(error.message, true); }
  event.target.value = '';
});

$('import-config').addEventListener('click', () => $('config-file').click());

$('config-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (!/\.json$/i.test(file.name) || file.size > 100000) throw new Error('请选择小于 100 KB 的 JSON 配置文件。');
    const config = parseConfigFile(await file.text());
    fillForm(config);
    status('已从本机 JSON 导入配置。请核对表单，再点击「保存设置」使其生效。');
  } catch (error) { status(error.message, true); }
  finally { event.target.value = ''; }
});

$('export-config').addEventListener('click', async () => {
  try {
    const saved = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
    if (!saved) throw new Error('请先保存设置，再导出配置。');
    const contents = createConfigFile(saved);
    if (!confirm('导出的 JSON 文件会明文包含简历、求职偏好和 API Key。请妥善保管。继续导出吗？')) return;
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'AI岗位匹配-配置-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('已导出本机 JSON 配置文件，文件包含明文 API Key。');
  } catch (error) { status(error.message, true); }
});

$('clear').addEventListener('click', async () => {
  if (!confirm('清除本机保存的简历、偏好、API Key、筛选记录和自动沟通记录？清除后无法再用历史记录防止重复沟通。')) return;
  try {
    await send({ type: 'ai/clearConfig' });
    $('config-form').reset();
    status('全部 AI 数据已从扩展本机存储清除。已导出的 JSON 文件需自行删除。');
  } catch (error) { status(error.message, true); }
});
