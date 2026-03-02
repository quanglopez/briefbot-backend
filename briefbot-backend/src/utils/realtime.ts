import { getSupabase } from '../config/supabase.js';

const CHANNEL_PREFIX = 'project:';

export type RealtimeEventType = 'scrape:progress' | 'analyze:complete' | 'brief:generated';

interface RealtimePayload {
  type: RealtimeEventType;
  projectId: string;
  data: unknown;
}

async function broadcast(projectId: string, type: RealtimeEventType, data: unknown): Promise<void> {
  const supabase = getSupabase();
  const channelName = `${CHANNEL_PREFIX}${projectId}`;
  const channel = supabase.channel(channelName);

  await channel.subscribe();

  await channel.send({
    type: 'broadcast',
    event: type,
    payload: {
      type,
      projectId,
      data,
    } as RealtimePayload,
  });

  await channel.unsubscribe();
}

export async function emitScrapeProgress(projectId: string, data: unknown): Promise<void> {
  await broadcast(projectId, 'scrape:progress', data);
}

export async function emitAnalysisComplete(projectId: string, data: unknown): Promise<void> {
  await broadcast(projectId, 'analyze:complete', data);
}

export async function emitBriefGenerated(projectId: string, data: unknown): Promise<void> {
  await broadcast(projectId, 'brief:generated', data);
}

