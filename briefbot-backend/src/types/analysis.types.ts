/** Legacy shape for backward compatibility. */
export interface VideoAnalysisLegacy {
  summary: string;
  keyFrames: string[];
  transcript?: string;
  visualElements: string[];
  durationSeconds: number;
}

/** Result from Gemini video analyzer (prompt.templates VIDEO_ANALYSIS_PROMPT). */
export interface VideoAnalysisResult {
  hookAnalysis: string;
  contentStructure: string;
  ctaType: string | null;
  emotionTone: string;
  videoFormat: string;
  keyMessages: string[];
  strengths: string[];
  weaknesses: string[];
  aiScore: number;
  hookType: string;
  targetAudienceGuess: string;
}

export interface CommentAnalysisResult {
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  themes: string[];
  painPoints: string[];
  desires: string[];
  sampleComments: string[];
}

/** Result from CommentAnalyzer (Claude COMMENT_ANALYSIS_PROMPT). */
export interface CommentInsightResult {
  totalCommentsScraped: number;
  topQuestions: Array<{ question: string; count: number; sentiment: string }>;
  painPoints: Array<{ painPoint: string; count: number; severity: string }>;
  positiveSignals: Array<{ signal: string; count: number; type: string }>;
  objections: Array<{ objection: string; count: number; type: string }>;
  sentimentSummary: string;
  purchaseIntentScore: number;
  viralPotential: string;
  keyTakeaway: string;
}

export interface HookAnalysisResult {
  hookType: string;
  hookTimestampSeconds?: number;
  hookText?: string;
  confidence: number;
  reasoning?: string;
}

export interface CombinedAnalysis {
  video: VideoAnalysisResult;
  comments: CommentAnalysisResult;
  hook: HookAnalysisResult;
}
