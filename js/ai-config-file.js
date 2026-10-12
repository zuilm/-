import { validateConfig } from './ai-model.js';

const FILE_FORMAT = 'ai-job-matcher-config';
const FILE_VERSION = 1;

export function createConfigFile(config) {
  return JSON.stringify({
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    config: validateConfig(config)
  }, null, 2) + '\n';
}

export function parseConfigFile(text) {
  let file;
  try { file = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('配置文件不是有效的 JSON。'); }
  if (file?.format !== FILE_FORMAT || file.version !== FILE_VERSION || !file.config || typeof file.config !== 'object') {
    throw new Error('配置文件格式或版本不受支持。');
  }
  return validateConfig(file.config);
}
