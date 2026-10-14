(function () {
  'use strict';
  let dialog, shadow, running = false, stopped = false, contextInvalidated = false;
  let results = [], failures = [], threshold = 70;
  let selectedJobs = new Set(), greetingCount = 0;
  const CONTEXT_INVALIDATED_MESSAGE = '扩展已更新或重新加载，当前网页仍在运行旧脚本。点击“刷新页面并重新连接”，再打开 AI 筛岗位。若投递在此时中断，请先核对 BOSS 会话，避免重复发送。';
  const $ = id => shadow.getElementById(id);
  const visible = node => !!node && node.getClientRects().length > 0;
  const text = node => (node?.innerText || node?.textContent || '').trim();
  const firstText = (node, selectors) => {
    for (const selector of selectors) {
      const candidate = node.querySelector(selector);
      if (candidate && text(candidate)) return text(candidate);
    }
    return '';
  };
  async function send(message) {
    if (contextInvalidated) throw new Error(CONTEXT_INVALIDATED_MESSAGE);
    try {
      if (!globalThis.chrome?.runtime?.id) throw new Error('Extension context invalidated');
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.success) throw new Error(response?.message || '扩展后台未响应，请重新加载扩展并刷新网页。');
      return response;
    } catch (error) {
      if (!/extension context invalidated/i.test(String(error?.message || error))) throw error;
      contextInvalidated = true;
      stopped = true;
      setStatus(CONTEXT_INVALIDATED_MESSAGE, true);
      throw new Error(CONTEXT_INVALIDATED_MESSAGE);
    }
  }
  function setStatus(message, error = false) {
    $('status').textContent = contextInvalidated ? CONTEXT_INVALIDATED_MESSAGE : message;
    $('status').classList.toggle('error', error || contextInvalidated);
    $('refresh-page').hidden = !contextInvalidated;
  }
  function safeJobURL(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === 'https://www.zhipin.com' && url.pathname.startsWith('/job_detail/') ? url.href : '';
    } catch { return ''; }
  }
  function jobKey(job) {
    const url = safeJobURL(job.url);
    return url ? new URL(url).pathname : '';
  }
  const isPriority = row => row.result.score >= threshold && !row.result.hard_conflicts.length;
  function selectablePriorityRows() {
    return results.filter(row => isPriority(row) && row.result.preferenceReviewComplete !== false && row.job.scope === 'detail' && jobKey(row.job) && !row.application);
  }
  function selectedRows() {
    return results.filter(row => selectedJobs.has(jobKey(row.job)) && !row.application &&
      (!$('only-priority').checked || isPriority(row)));
  }
  function updateSelection() {
    const chosen = selectedRows();
    const eligible = selectablePriorityRows();
    const allEligibleSelected = eligible.length > 0 && selectedJobs.size === eligible.length && eligible.every(row => selectedJobs.has(jobKey(row.job)));
    const hiddenSelected = $('only-priority').checked
      ? results.filter(row => selectedJobs.has(jobKey(row.job)) && !row.application && !isPriority(row)).length
      : 0;
    $('selected-count').textContent = `已勾选 ${chosen.length} 个岗位${hiddenSelected ? `；另有 ${hiddenSelected} 个不符合当前筛选，不会投递` : ''}`;
    $('selected-preview').textContent = chosen.length
      ? chosen.slice(0, 3).map(row => row.job.title).join('、') + (chosen.length > 3 ? ` 等 ${chosen.length} 个岗位` : '')
      : '请先完成 JD 筛选，再在右侧结果中勾选岗位。';
    $('apply-selected').disabled = running || contextInvalidated || chosen.length === 0;
    $('apply-selected').textContent = chosen.length ? `一键投递已勾选的 ${chosen.length} 个岗位` : '一键投递已勾选岗位';
    $('select-all-priority').disabled = running || contextInvalidated || !$('only-priority').checked || eligible.length === 0;
    $('select-all-priority').textContent = allEligibleSelected ? `取消全选（${eligible.length}）` : `全选适配岗位（${eligible.length}）`;
    $('select-all-hint').textContent = $('only-priority').checked
      ? '全选只包含达到门槛、无明确冲突、偏好已核对且尚未投递的完整 JD 岗位。'
      : '先勾选上方的「仅看达到门槛且无明确冲突」。';
  }
  function togglePrioritySelection() {
    if (running || contextInvalidated || !$('only-priority').checked) return;
    const eligible = selectablePriorityRows();
    if (!eligible.length) return;
    const keys = eligible.map(row => jobKey(row.job));
    const exactSelection = selectedJobs.size === keys.length && keys.every(key => selectedJobs.has(key));
    selectedJobs = exactSelection ? new Set() : new Set(keys);
    render();
    setStatus(exactSelection ? '已取消勾选适配岗位。' : `已全选 ${keys.length} 个适配岗位；可点击左侧「一键投递已勾选岗位」。`);
  }
  function appendLoadedJobs(limit, jobs, seen) {
    for (const card of document.querySelectorAll('li.job-card-box')) {
      const title = firstText(card, ['.job-name', '.job-title']);
      const company = firstText(card, ['.company-name', '.company-info h3', '.company-info a']);
      const content = text(card).slice(0, 16000);
      const url = safeJobURL(card.querySelector('a[href*="/job_detail/"]')?.getAttribute('href'));
      const key = url ? new URL(url).pathname : title + '\n' + company + '\n' + content;
      if (!title || content.length < 20 || seen.has(key)) continue;
      seen.add(key);
      jobs.push({ scope: 'summary', title: title.slice(0,300), company: company.slice(0,300), text: content, url });
      if (jobs.length >= limit) break;
    }
  }
  function scrollJobList() {
    const cards = [...document.querySelectorAll('li.job-card-box')];
    const last = cards.at(-1);
    if (!last) return false;
    // BOSS loads more cards when the list (or its scrollable parent) reaches the end.
    for (let parent = last.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (/(auto|scroll)/.test(overflow) && parent.scrollHeight > parent.clientHeight + 10) {
        parent.scrollTop = parent.scrollHeight;
        last.scrollIntoView({ block: 'end', inline: 'nearest' });
        return true;
      }
    }
    last.scrollIntoView({ block: 'end', inline: 'nearest' });
    window.scrollTo(0, document.documentElement.scrollHeight);
    return true;
  }
  async function collectJobs(limit) {
    const jobs = [], seen = new Set();
    appendLoadedJobs(limit, jobs, seen);
    const deadline = Date.now() + 20000;
    let noProgress = 0;
    while (!stopped && jobs.length < limit && noProgress < 2 && Date.now() < deadline) {
      if (!scrollJobList()) break;
      const before = jobs.length;
      setStatus(`已发现 ${before}/${limit} 个岗位，正在加载下一批…`);
      const waitUntil = Math.min(deadline, Date.now() + 2500);
      while (!stopped && Date.now() < waitUntil && jobs.length === before) {
        await new Promise(resolve => setTimeout(resolve, 250));
        appendLoadedJobs(limit, jobs, seen);
      }
      noProgress = jobs.length === before ? noProgress + 1 : 0;
    }
    return jobs;
  }
  function readDetail() {
    const selectors = ['.job-sec-text', '.job-detail-body', '.job-detail .text', '.job-detail-box .job-section .text'];
    let description;
    for (const selector of selectors) {
      description = [...document.querySelectorAll(selector)].find(node => visible(node) && text(node).length >= 40);
      if (description) break;
    }
    if (!description) { setStatus('未找到可见的岗位详情。请先打开一个职位，或在下方粘贴完整 JD。', true); return; }
    const root = description.closest('.job-detail-box, .job-detail, .job-detail-container, .job-detail-wrap') || description.parentElement;
    const title = firstText(root, ['.job-name', '.job-title', 'h1']);
    const company = firstText(root, ['.company-name', '.company-info h3']);
    // Always replace every field; never combine a newly loaded JD with a stale title.
    $('job-title').value = title;
    $('job-company').value = company;
    const meta = [...root.querySelectorAll('.job-salary, .salary, .job-tags, .job-info, .job-address')].filter(visible).map(text).join('\n');
    $('job-text').value = (meta + '\n' + text(description)).trim().slice(0,16000);
    setStatus(title ? '已读取当前可见详情。核对职位名称和正文后，点击「分析这份 JD」。' : '已读取岗位正文，请补充职位名称并核对内容后分析。');
  }
  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content != null) node.textContent = content;
    if (className) node.className = className;
    return node;
  }
  function evidenceBlock(label, items, parent) {
    if (!items.length) return;
    parent.append(element('h4', label));
    for (const item of items) {
      const block = element('div', null, 'evidence');
      block.append(element('strong', item.requirement), element('p', '简历 / 偏好：' + item.resume_evidence), element('p', '岗位原文：' + item.job_evidence));
      parent.append(block);
    }
  }
  function render() {
    const list = $('results');
    list.replaceChildren();
    const filtered = results.filter(row => !$('only-priority').checked || isPriority(row));
    filtered.sort((a,b) => Number(!!a.result.hard_conflicts.length) - Number(!!b.result.hard_conflicts.length) || b.result.score - a.result.score);
    $('count').textContent = `${filtered.length} / ${results.length} 个已分析岗位 · ${failures.length} 个失败或跳过`;
    if (!filtered.length) list.append(element('div', results.length ? '当前没有达到门槛且无明确冲突的岗位。取消勾选可查看全部。' : '分析结果会按匹配分数排序，展示原文证据与待确认事项。', 'empty'));
    for (const row of filtered) {
      const card = element('article', null, 'result');
      const head = element('div', null, 'result-head');
      const title = element('div');
      const key = jobKey(row.job);
      if (key && row.job.scope === 'detail') {
        const label = element('label', null, 'pick');
        const checkbox = element('input');
        checkbox.type = 'checkbox'; checkbox.className = 'job-select';
        checkbox.dataset.jobKey = key;
        checkbox.checked = selectedJobs.has(key) && !row.application;
        checkbox.disabled = running || !!row.application;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedJobs.add(key);
          else selectedJobs.delete(key);
          updateSelection();
        });
        label.append(checkbox, element('span', row.application ? '已处理' : '选择此岗位投递'));
        title.append(label);
      }
      title.append(element('h3', row.job.title), element('p', row.job.company || '公司未提供', 'company'));
      const score = element('div', String(row.result.score), 'score');
      score.append(element('small', '/ 100'));
      head.append(title, score);
      const tags = element('div', null, 'tags');
      tags.append(element('span', row.job.scope === 'summary' ? '列表初筛' : '完整 JD 分析'), element('span', row.recommendation));
      if (row.cached) tags.append(element('span', '已复用结果'));
      card.append(head, tags, element('p', row.result.summary, 'summary'));
      if (row.application) {
        const application = row.application;
        card.append(element('p', `自动沟通：${application.status}${application.duplicate ? '（跳过重复操作）' : ''}`, 'summary'));
        if (application.messages?.[0]) card.append(element('p', '打招呼语：' + application.messages[0], 'summary'));
        if (application.greeting) card.append(element('p', '消息：' + application.greeting + ' · 附件：' + application.resume, 'dimensions'));
        if (application.closeStatus && application.closeStatus !== '当前没有简易沟通窗') card.append(element('p', '沟通窗：' + application.closeStatus, 'dimensions'));
        if (application.error) card.append(element('p', application.error, 'summary'));
      }
      const details = element('details');
      details.append(element('summary', '查看匹配证据与差距'));
      const scores = row.result.scores;
      details.append(element('p', `技能 ${scores.skills}/40 · 经历 ${scores.experience}/30 · 条件 ${scores.constraints}/20 · 偏好 ${scores.preferences}/10`, 'dimensions'));
      evidenceBlock('匹配点', row.result.matches, details);
      evidenceBlock('能力差距', row.result.gaps, details);
      evidenceBlock('明确冲突', row.result.hard_conflicts, details);
      if (row.result.preference_checks?.length) {
        details.append(element('h4', '求职偏好逐条核对'));
        const ul = element('ul');
        for (const check of row.result.preference_checks) {
          const kind = check.kind === 'must' ? '必须' : '加分';
          const status = { match:'符合', conflict:'冲突', unknown:'待确认' }[check.status];
          ul.append(element('li', `${kind} · ${status}：${check.preference}${check.job_evidence ? '（岗位原文：' + check.job_evidence + '）' : ''}`));
        }
        details.append(ul);
      }
      if (row.result.unknowns.length) {
        details.append(element('h4', '待确认'));
        const ul = element('ul');
        row.result.unknowns.forEach(item => ul.append(element('li', item)));
        details.append(ul);
      }
      details.append(element('p', `分析模型：${row.model} · 把握程度：${{low:'低',medium:'中',high:'高'}[row.result.confidence]}`, 'dimensions'));
      card.append(details);
      const url = safeJobURL(row.job.url);
      if (url) {
        const link = element('a', '打开岗位详情 ↗', 'job-link');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        card.append(link);
      }
      list.append(card);
    }
    for (const failure of $('only-priority').checked ? [] : failures) {
      const card = element('article', null, 'result');
      card.append(element('h3', failure.job.title), element('p', failure.job.company, 'company'), element('p', failure.message, 'summary'));
      const url = safeJobURL(failure.job.url);
      if (url) {
        const link = element('a', '手动打开详情核对 ↗', 'job-link');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
      }
      list.append(card);
    }
    $('export').disabled = !results.length && !failures.length;
    updateSelection();
  }
  function busy(value) {
    running = value;
    for (const id of ['scan', 'apply-selected', 'resume-name', 'analyze-detail', 'read-detail', 'settings', 'job-title', 'job-company', 'job-text', 'only-priority']) $(id).disabled = value || contextInvalidated;
    shadow.querySelectorAll('.job-select').forEach(input => { input.disabled = value || !!results.find(row => jobKey(row.job) === input.dataset.jobKey)?.application; });
    $('stop').disabled = !value || contextInvalidated;
    updateSelection();
  }
  async function run(mode) {
    if (running) return;
    stopped = false; busy(true);
    $('run-mode').textContent = '步骤 1：正在读取与分析 JD；此阶段不会投递。';
    try {
      const config = await send({ type: 'ai/status' });
      if (stopped) return;
      if (!config.configured) throw new Error('请先打开「简历与模型设置」，保存简历、接口地址和 API Key。');
      threshold = config.threshold;
      const batch = mode === 'list';
      const jobs = batch ? await collectJobs(config.batchLimit) : [{ scope: 'detail', title: $('job-title').value.trim(), company: $('job-company').value.trim(), text: $('job-text').value.trim(), url: safeJobURL(location.href) }];
      if (stopped) return;
      if (!jobs.length) throw new Error('当前没有读到职位卡片。请打开职位列表并加载岗位后重试。');
      if (mode === 'detail' && (!jobs[0].title || jobs[0].text.length < 40)) throw new Error('请填写职位名称和至少 40 字符的岗位描述。');
      results = []; failures = []; selectedJobs = new Set(); render();
      $('greeting-progress').textContent = '本次确认打招呼：0';
      for (const [index, candidate] of jobs.entries()) {
        if (stopped) break;
        try {
          let job = candidate;
          if (batch) {
            if (!candidate.url) throw new Error('职位卡片缺少详情链接，未进行评分。');
            setStatus(`正在读取完整 JD ${index+1}/${jobs.length}：${candidate.title}`);
            job = (await send({ type: 'ai/readJobDetail', url: candidate.url })).job;
            if (stopped) break;
            const normalizeTitle = value => value.replace(/\s+/g, '').toLowerCase();
            if (normalizeTitle(job.title) !== normalizeTitle(candidate.title)) throw new Error('详情页职位名称与卡片不一致，未进行评分，请手动核对。');
            // Keep the company from the matched card if the detail page omits it.
            job.company ||= candidate.company;
          }
          setStatus(`正在分析完整 JD ${index+1}/${jobs.length}：${job.title}`);
          const response = await send({ type: 'ai/analyze', job });
          if (stopped) break;
          const row = { job, ...response, analyzedAt: new Date().toISOString() };
          results.push(row);
          render();
        } catch (error) {
          if (stopped) break;
          failures.push({ job: candidate, message: error.message, failedAt: new Date().toISOString() });
        }
        render();
      }
      $('run-mode').textContent = stopped ? '已停止筛选；已完成的结果仍可查看。' : '步骤 2：查看匹配结果，勾选心仪岗位后再投递。';
      setStatus(stopped ? `已停止，保留 ${results.length} 个已完成结果。` : `JD 筛选完成：发现 ${jobs.length}/${batch ? config.batchLimit : 1} 个岗位，${results.length} 个已分析，${failures.length} 个读取或分析失败。${batch && jobs.length < config.batchLimit ? '当前列表未加载到更多岗位。' : ''}可逐个勾选，或先筛选再全选适配岗位。`);
    } catch (error) {
      setStatus(stopped ? `已停止，保留 ${results.length} 个已完成结果。` : `${error.message} 已完成 ${results.length} 个结果仍可查看。`, !stopped);
    } finally { busy(false); }
  }
  async function applySelected() {
    if (running) return;
    const chosen = selectedRows();
    if (!chosen.length) { setStatus('请先完成 JD 筛选并勾选至少一个岗位。', true); return; }
    stopped = false; greetingCount = 0; busy(true);
    $('run-mode').textContent = `正在投递已勾选的 ${chosen.length} 个岗位。`;
    $('greeting-progress').textContent = `本次确认打招呼：0 / ${chosen.length}`;
    const resumeName = $('resume-name').value.trim();
    try {
      for (const [index, row] of chosen.entries()) {
        if (stopped) break;
        setStatus(`正在投递 ${index + 1}/${chosen.length}：${row.job.title}`);
        try {
          row.application = (await send({ type:'ai/applyMatched', url:row.job.url, resumeName })).application;
          if (row.application.greetingSent === true && !row.application.duplicate) greetingCount++;
        } catch (error) {
          row.application = contextInvalidated
            ? { status:'执行状态未确认', error:'扩展连接中断，请先核对 BOSS 会话，避免重复发送。' }
            : { status:'投递失败，请核对会话', error:error.message };
        }
        selectedJobs.delete(jobKey(row.job));
        $('greeting-progress').textContent = `本次确认打招呼：${greetingCount} / ${chosen.length}`;
        render();
        if (stopped) break;
        if (index + 1 < chosen.length) {
          const pause = 1000 + Math.floor(Math.random() * 1001);
          setStatus(`投递间隔 ${(pause / 1000).toFixed(1)} 秒，随后处理下一个已选岗位…`);
          const deadline = Date.now() + pause;
          while (!stopped && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
      }
      $('run-mode').textContent = stopped ? '投递已停止；未处理的勾选岗位仍保留。' : '本次勾选岗位已处理，发送状态见各岗位结果。';
      setStatus(stopped ? `已停止。本次确认打招呼 ${greetingCount}/${chosen.length}；请核对已打开的会话。` : `已处理 ${chosen.length} 个勾选岗位，本次确认打招呼 ${greetingCount} 个；附件状态见各岗位结果。`);
    } finally { busy(false); render(); }
  }
  function stop() {
    if (!running) return;
    stopped = true;
    setStatus('正在停止当前操作…');
    send({ type: 'ai/cancel' }).catch(() => {});
  }
  function exportResults() {
    const payload = { exportedAt: new Date().toISOString(), threshold, selectedJobPaths: [...selectedJobs], greetingCount, results, failures };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)], { type: 'application/json' }));
    const link = element('a');
    link.href = url; link.download = 'AI岗位匹配-' + new Date().toISOString().slice(0,10) + '.json';
    shadow.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('已导出分析结果。文件包含岗位内容及简历证据摘录。');
  }
  function createDialog() {
    const host = document.createElement('div');
    host.id = 'haitou-ai-matcher';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}*{box-sizing:border-box}dialog{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#20382f;border:1px solid #d9e5df;border-radius:18px;background:#f5f8f6;padding:0;width:min(1100px,94vw);height:min(820px,90vh);max-width:none;max-height:none;box-shadow:0 30px 90px #0003}dialog::backdrop{background:#14281f77}header{display:flex;justify-content:space-between;align-items:center;padding:20px 26px;background:white;border-bottom:1px solid #dfe9e3}h2{margin:0;font-size:21px}header p{margin:4px 0 0;color:#6a7d73;font-size:12px}.layout{display:grid;grid-template-columns:300px 1fr;height:calc(100% - 98px)}aside{padding:22px;border-right:1px solid #dfe9e3;overflow:auto;background:#fcfdfc}.main{padding:22px 24px;overflow:auto}button{font:inherit;font-size:13px;padding:10px 14px;border:1px solid #cbdcd2;border-radius:8px;color:#285b46;background:white;cursor:pointer}button.primary{color:white;background:#176b4b;border-color:#176b4b}button:disabled{opacity:.5;cursor:default}button:hover:not(:disabled){filter:brightness(.95)}.wide{width:100%;margin-bottom:9px}#close{border:0;font-size:20px;padding:0 8px}.section-label{font-size:12px;letter-spacing:1px;color:#6a7d73;font-weight:600;margin:20px 0 10px}.note{font-size:12px;color:#6a7d73;margin:8px 0 14px}label{display:block;font-size:12px;margin:12px 0 6px}input,textarea{font:inherit;font-size:13px;line-height:1.6;width:100%;border:1px solid #ccdad2;background:white;border-radius:6px;padding:8px;color:#20382f}textarea{resize:vertical;min-height:130px}input:focus,textarea:focus,button:focus-visible{outline:2px solid #57a77c;outline-offset:2px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.row label{margin:0;display:flex;align-items:center;gap:6px}.row input{width:auto}#status{padding:12px 14px;border-radius:8px;background:#e6f1eb;margin:16px 0;color:#375e48;font-size:12px}#status.error{background:#fff0e9;color:#a24c2c}#count{font-size:12px;color:#6a7d73}.result{border:1px solid #dce7df;background:white;border-radius:12px;padding:20px;margin-bottom:12px}.result-head{display:flex;justify-content:space-between;gap:16px}h3{margin:0;font-size:17px;overflow-wrap:anywhere}.company{margin:3px 0;color:#718278;font-size:12px}.score{font-size:30px;line-height:1.2;font-weight:650;white-space:nowrap;color:#1b754e}.score small{display:block;text-align:right;font-size:11px;color:#849389;font-weight:400}.tags{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.tags span{font-size:11px;padding:3px 8px;border-radius:4px;background:#eef5ef;color:#3f6852}.summary{font-size:13px;margin:12px 0;white-space:pre-wrap;overflow-wrap:anywhere}details{border-top:1px solid #eaf0ec;padding-top:12px}summary{cursor:pointer;font-size:12px;color:#27714e}h4{font-size:12px;margin:15px 0 7px}.evidence{padding:9px 12px;background:#f7f9f7;border-left:2px solid #b8d9c5;margin:8px 0;font-size:12px;overflow-wrap:anywhere}.evidence p{margin:3px 0;color:#6a7c70}.dimensions{font-size:11px;color:#6d8073}ul{padding-left:18px;font-size:12px;color:#586f60}li{margin:5px 0}.job-link{display:inline-block;margin-top:14px;color:#25734e;font-size:12px;text-decoration:none}.empty{color:#7a8c7e;font-size:13px;padding:52px 24px;text-align:center;border:1px dashed #cdded1;border-radius:12px;margin-top:16px}#analyze-detail{margin-top:12px}@media(max-width:740px){.layout{grid-template-columns:1fr;overflow:auto;height:calc(100% - 98px)}aside,.main{overflow:visible}aside{border-right:0;border-bottom:1px solid #dfe9e3}header{padding:16px}h2{font-size:18px}}
        .layout{grid-template-columns:minmax(290px,320px) minmax(0,1fr)}
        aside{padding:18px;min-width:0}.main{min-width:0}
        .workflow-step{background:#fff;border:1px solid #dce7df;border-radius:12px;padding:16px;margin:14px 0}
        .step-heading{display:flex;align-items:flex-start;gap:10px;margin-bottom:14px}
        .step-heading h3{font-size:15px;line-height:1.4;margin:0}
        .step-heading p{font-size:12px;color:#6a7d73;line-height:1.55;margin:4px 0 0}
        .step-number{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border-radius:8px;background:#e6f1eb;color:#176b4b;font-weight:700;font-size:12px}
        .workflow-step .wide{margin:12px 0 0}.workflow-step .note{line-height:1.55;margin:9px 0 0;overflow-wrap:anywhere}
        .workflow-step label{margin:14px 0 6px}.selection-count{font-weight:650;color:#176b4b;margin:8px 0 0}
        .stop-button{margin:2px 0 14px}.manual-panel{background:#fff;border:1px solid #dce7df;border-radius:12px;padding:14px 16px}
        .manual-panel>summary{font-size:13px;font-weight:600;color:#285b46}.manual-panel textarea{min-height:110px}
        .pick{display:inline-flex;align-items:center;gap:7px;margin:0 0 8px;color:#176b4b;font-size:12px;font-weight:650;cursor:pointer}
        .pick input{width:17px;height:17px;margin:0;flex:none;accent-color:#176b4b}.result-head>div:first-child{min-width:0}
        .selection-tools{justify-content:flex-start;flex-wrap:wrap;gap:8px;margin:10px 0 4px}.selection-tools .note{margin:0}
        [hidden]{display:none!important}
        @media(max-width:740px){.layout{grid-template-columns:1fr}.main{padding:18px}.workflow-step{margin:12px 0}}
      </style>
      <dialog aria-labelledby="title">
        <header><div><h2 id="title">AI 筛岗位</h2><p>用你的经历，找到值得认真了解的机会。</p></div><button id="close" aria-label="关闭">×</button></header>
        <div class="layout"><aside>
          <button id="settings" class="wide">简历与模型设置 ↗</button>
          <section class="workflow-step" aria-labelledby="scan-title">
            <div class="step-heading"><span class="step-number">01</span><div><h3 id="scan-title">AI JD 筛选</h3><p>从当前职位列表继续加载岗位，逐个读取完整 JD。</p></div></div>
            <button id="scan" class="wide primary">开始筛选当前岗位</button>
            <p class="note">会滚动加载更多卡片，最多达到设置中的批次上限。只分析，不发送消息或简历。</p>
          </section>
          <section class="workflow-step" aria-labelledby="apply-title">
            <div class="step-heading"><span class="step-number">02</span><div><h3 id="apply-title">投递已选岗位</h3><p>在右侧逐个勾选，或筛选后全选适配岗位。</p></div></div>
            <p id="selected-count" class="selection-count">已勾选 0 个岗位</p>
            <p id="selected-preview" class="note">请先完成 JD 筛选，再在右侧结果中勾选岗位。</p>
            <label for="resume-name">BOSS 附件简历名称（可选）</label><input id="resume-name" maxlength="300" placeholder="多份附件时填写准确名称">
            <button id="apply-selected" class="wide primary" disabled>一键投递已勾选岗位</button>
            <p id="greeting-progress" class="note" role="status">本次确认打招呼：0</p>
            <p class="note">点击投递后会逐个发送岗位专属文案，并尝试发送已上传到 BOSS 的附件。筛选结果 6 小时内有效；分数仅供参考，已沟通过的岗位会跳过。</p>
          </section>
          <button id="stop" class="wide stop-button" disabled>停止当前操作</button>
          <details class="manual-panel"><summary>单份 JD 分析（可选）</summary>
            <p class="note">单份分析会替换当前筛选结果。可读取当前可见详情，或粘贴完整 JD。</p>
            <button id="read-detail" class="wide">读取当前可见详情</button>
            <label for="job-title">职位名称</label><input id="job-title" maxlength="300" placeholder="例如：前端开发工程师">
            <label for="job-company">公司（可选）</label><input id="job-company" maxlength="300">
            <label for="job-text">核对或粘贴完整岗位描述</label><textarea id="job-text" maxlength="16000" rows="7" placeholder="职责、技能、年限、学历、薪资、地点等。若自动读取不完整，可在这里补充。"></textarea>
            <button id="analyze-detail" class="wide primary">分析这份 JD</button>
          </details>
        </aside><section class="main">
          <p id="run-mode" class="note" role="status">先筛选完整 JD，再勾选岗位进行投递。</p>
          <div class="row"><label><input type="checkbox" id="only-priority">仅看达到门槛且无明确冲突</label><button id="export" disabled>导出结果</button></div>
          <div class="row selection-tools"><button id="select-all-priority" disabled>全选适配岗位（0）</button><span id="select-all-hint" class="note">先勾选上方的筛选条件。</span></div>
          <div id="status" role="status" aria-live="polite">请先配置简历和模型，然后点击「开始筛选当前岗位」。</div>
          <button id="refresh-page" class="wide primary" hidden>刷新页面并重新连接</button>
          <div id="count">0 个岗位</div><div id="results"></div>
        </section></div>
      </dialog>`;
    document.body.append(host);
    dialog = shadow.querySelector('dialog');
    $('close').onclick = () => { stop(); dialog.close(); };
    dialog.addEventListener('cancel', stop);
    $('settings').onclick = () => send({ type:'ai/openSettings' }).catch(error => setStatus(error.message,true));
    $('scan').onclick = () => run('list');
    $('apply-selected').onclick = applySelected;
    $('analyze-detail').onclick = () => run('detail');
    $('read-detail').onclick = readDetail;
    $('stop').onclick = stop;
    $('only-priority').onchange = render;
    $('select-all-priority').onclick = togglePrioritySelection;
    $('export').onclick = exportResults;
    $('refresh-page').onclick = () => location.reload();
    render();
  }
  function open() {
    if (!dialog) createDialog();
    if (!dialog.open) dialog.showModal();
  }
  window.AIJobMatcher = { open };
})();
