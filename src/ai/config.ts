import type { AiConfig } from '../types';
import { DEFAULT_AI_CONFIG } from '../types';
import { repo } from '../db/repo';
import { getApiKey, setApiKey } from './keyStore';

const K_BASE_URL = 'ai_base_url';
const K_MODEL = 'ai_model';

export async function loadAiConfig(): Promise<AiConfig> {
  const baseUrl = (await repo.getSetting(K_BASE_URL)) || DEFAULT_AI_CONFIG.baseUrl;
  const model = (await repo.getSetting(K_MODEL)) || DEFAULT_AI_CONFIG.model;
  const apiKey = await getApiKey();
  return { baseUrl, model, apiKey };
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  await repo.setSetting(K_BASE_URL, config.baseUrl.trim() || DEFAULT_AI_CONFIG.baseUrl);
  await repo.setSetting(K_MODEL, config.model.trim() || DEFAULT_AI_CONFIG.model);
  await setApiKey(config.apiKey.trim());
}
