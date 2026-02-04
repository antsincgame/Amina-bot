// OpenRouter API integration for fetching available models

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
}

export interface OpenRouterModelsResponse {
  count: number;
  models: OpenRouterModel[];
}

/**
 * Fetch all available models from OpenRouter API
 * @param apiKey Optional API key (if not provided, uses public endpoint)
 * @param limit Maximum number of models to fetch (default: 200)
 */
export async function fetchOpenRouterModels(
  apiKey?: string,
  limit: number = 200
): Promise<OpenRouterModelsResponse> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(
    `https://openrouter.ai/api/v1/models?limit=${limit}`,
    {
      method: 'GET',
      headers,
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`);
  }

  const data = await response.json();
  
  return {
    count: data.data?.length ?? 0,
    models: data.data ?? [],
  };
}

/**
 * Filter models by pricing (free or paid)
 */
export function filterFreeModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return models.filter(
    (m) => m.pricing.prompt === '0' && m.pricing.completion === '0'
  );
}

export function filterPremiumModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return models.filter(
    (m) => m.pricing.prompt !== '0' || m.pricing.completion !== '0'
  );
}

/**
 * Transform OpenRouterModel to simple format for UI
 */
export function transformToSimpleModel(model: OpenRouterModel): {
  id: string;
  name: string;
} {
  return {
    id: model.id,
    name: model.name,
  };
}
