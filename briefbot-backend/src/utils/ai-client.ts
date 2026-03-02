import { openrouter } from '../config/ai.js';

export interface CallAIParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  images?: string[]; // URLs
  jsonMode?: boolean;
}

export async function callAI<T = unknown>(params: CallAIParams): Promise<T | string> {
  const messages = [
    { role: 'system' as const, content: params.systemPrompt },
    {
      role: 'user' as const,
      content: params.images?.length
        ? [
            ...params.images.map((url) => ({
              type: 'image_url' as const,
              image_url: { url },
            })),
            { type: 'text' as const, text: params.userPrompt },
          ]
        : params.userPrompt,
    },
  ];

  try {
    const response = await openrouter.chat.completions.create({
      model: params.model,
      messages,
      temperature: params.temperature ?? 0.5,
      max_tokens: params.maxTokens ?? 2000,
      ...(params.jsonMode && { response_format: { type: 'json_object' as const } }),
    });

    const rawContent = (response as any).choices?.[0]?.message?.content;
    if (!rawContent) throw new Error('Empty AI response');

    let text: string;
    if (typeof rawContent === 'string') {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      const textPart = rawContent.find((p: any) => p.type === 'text');
      text = textPart?.text ?? JSON.stringify(rawContent);
    } else {
      text = JSON.stringify(rawContent);
    }

    if (params.jsonMode) {
      const cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
      return JSON.parse(cleaned) as T;
    }

    return text;
  } catch (error: any) {
    if (error?.status === 429) {
      const retryAfter = Number.parseInt(error.headers?.['retry-after'] ?? '5', 10);
      await new Promise((r) => setTimeout(r, Number.isNaN(retryAfter) ? 5000 : retryAfter * 1000));
      return callAI<T>(params);
    }
    if (error?.status === 402) {
      throw new Error('OpenRouter credit hết. Vui lòng nạp thêm tại https://openrouter.ai/credits');
    }
    throw error;
  }
}

