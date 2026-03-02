import { z } from 'zod';

const envSchema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_KEY: z.string().min(1, 'SUPABASE_SERVICE_KEY is required'),
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required'),
  APP_URL: z.string().url('APP_URL must be a valid URL').default('http://localhost:3001'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL').default('redis://localhost:6379'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PROXY_LIST: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((p) => p.trim()).filter(Boolean) : [])),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** Optional: for Facebook Strategy A (Graph API). */
  FB_ACCESS_TOKEN: z.string().optional(),
  /** Optional: JSON string of cookies for Facebook Strategy B (cookie login). */
  FB_COOKIES: z.string().optional(),
  /** Optional: for JWT auth in API (Bearer token verification). */
  SUPABASE_ANON_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
