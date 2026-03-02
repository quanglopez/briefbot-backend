import OpenAI from 'openai';
import { env } from './env.js';

// OpenRouter dùng OpenAI-compatible API
export const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': env.APP_URL || 'https://briefbot.app',
    'X-Title': 'BriefBot',
  },
});

// Model aliases cho dễ quản lý
export const AI_MODELS = {
  // Dùng cho video analysis (multimodal — xem video/ảnh)
  VIDEO_ANALYSIS: 'google/gemini-2.0-flash-001',

  // Dùng cho comment analysis (text analysis nặng)
  COMMENT_ANALYSIS: 'anthropic/claude-sonnet-4',

  // Dùng cho brief generation (creative writing)
  BRIEF_GENERATION: 'anthropic/claude-sonnet-4',

  // Dùng cho tasks nhẹ (formatting, simple extraction)
  LIGHT_TASK: 'google/gemini-2.0-flash-001',
} as const;

