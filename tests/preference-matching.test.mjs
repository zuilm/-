import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseModelResult, preferenceItems, recommendation } from '../js/ai-model.js';

const config = {
  resume: '五年软件测试经验，负责移动端和接口自动化测试，熟悉测试计划和缺陷跟踪。',
  preferences: '只考虑远程；优先技术团队',
};
const job = {
  scope: 'detail', title: '软件测试工程师', company: '示例公司',
  text: '岗位要求：五年软件测试经验。工作地点：上海，需每周到办公室五天。技术团队协作。',
};
const response = checks => JSON.stringify({
  scores: { skills: 38, experience: 27, constraints: 19, preferences: 9 },
  confidence: 'high', summary: '技能较匹配', matches: [], gaps: [], hard_conflicts: [], unknowns: [],
  preference_checks: checks,
});

test('分析请求逐条携带保存的求职偏好', () => {
  const data = JSON.parse(buildMessages(config, job)[1].content);
  assert.equal(data.preferences, config.preferences);
  assert.deepEqual(data.preference_items, ['只考虑远程', '优先技术团队']);
});

test('逗号分隔偏好时保留薪资中的千位分隔符', () => {
  assert.deepEqual(preferenceItems('只考虑远程，优先月薪 20,000 元以上'), ['只考虑远程', '优先月薪 20,000 元以上']);
});

test('高分岗位违反必选偏好时仍判为明确冲突', () => {
  const result = parseModelResult(response([
    { preference: '只考虑远程', kind: 'must', status: 'conflict', job_evidence: '需每周到办公室五天' },
    { preference: '优先技术团队', kind: 'prefer', status: 'match', job_evidence: '技术团队协作' },
  ]), config, job);
  assert.equal(result.score, 93);
  assert.equal(result.hard_conflicts.length, 1);
  assert.equal(recommendation(result, job.scope, 70), '存在明确冲突');
});

test('模型把“只考虑”误归为加分项时仍按必选条件处理', () => {
  const result = parseModelResult(response([
    { preference: '只考虑远程', kind: 'prefer', status: 'conflict', job_evidence: '需每周到办公室五天' },
    { preference: '优先技术团队', kind: 'prefer', status: 'match', job_evidence: '技术团队协作' },
  ]), config, job);
  assert.equal(result.preference_checks[0].kind, 'must');
  assert.equal(result.hard_conflicts.length, 1);
});

test('未写明必选偏好或偏好核对缺失时不标为适配', () => {
  const unknown = parseModelResult(response([
    { preference: '只考虑远程', kind: 'must', status: 'unknown', job_evidence: '' },
    { preference: '优先技术团队', kind: 'prefer', status: 'match', job_evidence: '技术团队协作' },
  ]), config, job);
  assert.equal(unknown.preferenceReviewComplete, false);
  assert.equal(recommendation(unknown, job.scope, 70), '求职偏好待确认');

  const incomplete = parseModelResult(response([]), config, job);
  assert.equal(incomplete.preferenceReviewComplete, false);
  assert.equal(incomplete.confidence, 'low');
});

test('没有岗位原文证据的偏好判断降为待确认', () => {
  const result = parseModelResult(response([
    { preference: '只考虑远程', kind: 'must', status: 'conflict', job_evidence: '必须长期驻场北京' },
    { preference: '优先技术团队', kind: 'prefer', status: 'match', job_evidence: '技术团队协作' },
  ]), config, job);
  assert.equal(result.preference_checks[0].status, 'unknown');
  assert.equal(result.hard_conflicts.length, 0);
  assert.equal(result.preferenceReviewComplete, false);
});
