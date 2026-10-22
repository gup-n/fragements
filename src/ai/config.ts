import type { AiConfig, ReasoningEffort } from '../types';
import { DEFAULT_AI_CONFIG, RETIRED_MODELS } from '../types';
import { repo } from '../db/repo';
import { getApiKey, setApiKey } from './keyStore';

const K_BASE_URL = 'ai_base_url';
const K_MODEL = 'ai_model';
const K_THINKING = 'ai_thinking';
const K_EFFORT = 'ai_effort';

function normalizeEffort(raw: string | null): ReasoningEffort {
  return raw === 'low' || raw === 'max' ? raw : DEFAULT_AI_CONFIG.effort;
}

export async function loadAiConfig(): Promise<AiConfig> {
  const baseUrl = (await repo.getSetting(K_BASE_URL)) || DEFAULT_AI_CONFIG.baseUrl;
  const stored = (await repo.getSetting(K_MODEL)) || DEFAULT_AI_CONFIG.model;
  // 老版本存的是已停用的模型名，读的时候直接映射成新名字。
  // 不在读取路径里写库 —— 读取要尽力保持无副作用，用户下次在设置页保存时自然落盘。
  const model = RETIRED_MODELS[stored.trim()] ?? stored;

  const thinkingRaw = await repo.getSetting(K_THINKING);
  const thinking = thinkingRaw === null ? DEFAULT_AI_CONFIG.thinking : thinkingRaw === '1';

  const apiKey = await getApiKey();
  return { baseUrl, model, apiKey, thinking, effort: normalizeEffort(await repo.getSetting(K_EFFORT)) };
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  await repo.setSetting(K_BASE_URL, config.baseUrl.trim() || DEFAULT_AI_CONFIG.baseUrl);
  await repo.setSetting(K_MODEL, config.model.trim() || DEFAULT_AI_CONFIG.model);
  await repo.setSetting(K_THINKING, config.thinking ? '1' : '0');
  await repo.setSetting(K_EFFORT, normalizeEffort(config.effort));
  await setApiKey(config.apiKey.trim());
}
