export interface VideoMetadata {
  id: string;
  url: string;
  platform: 'tiktok' | 'facebook' | 'shopee';
  title?: string;
  description?: string;
  durationSeconds?: number;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  createdAt?: string;
  authorId?: string;
  authorName?: string;
}

export interface VideoDownloadResult {
  localPath: string;
  url: string;
  metadata: VideoMetadata;
}
