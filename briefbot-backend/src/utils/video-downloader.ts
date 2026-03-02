import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import type { VideoMetadata } from '../types/video.types.js';

const TEMP_DIR = join(process.cwd(), 'tmp', 'videos');

export async function ensureTempDir(): Promise<string> {
  await mkdir(TEMP_DIR, { recursive: true });
  return TEMP_DIR;
}

export async function saveVideoBuffer(
  buffer: Buffer,
  metadata: VideoMetadata
): Promise<{ localPath: string }> {
  const dir = await ensureTempDir();
  const ext = 'mp4';
  const filename = `${metadata.id ?? randomUUID()}.${ext}`;
  const localPath = join(dir, filename);
  await writeFile(localPath, buffer);
  return { localPath };
}
