/**
 * AI prompt templates for BriefBot. All prompts are in Vietnamese for Vietnamese output.
 */

export interface BrandBible {
  tone_of_voice: string;
  target_audience: string;
  brand_values: string;
  key_messages: string;
  do_list: string;
  dont_list: string;
}

export interface VideoAnalysis {
  summary?: string;
  hook_analysis?: string;
  content_structure?: string;
  cta_type?: string;
  emotion_tone?: string;
  video_format?: string;
  key_messages?: string[];
  strengths?: string[];
  weaknesses?: string[];
  ai_score?: number;
  hook_type?: string;
  target_audience_guess?: string;
  [key: string]: unknown;
}

export interface CommentInsight {
  top_questions?: Array<{ question: string; count?: number; sentiment?: string }>;
  pain_points?: Array<{ pain_point: string; count?: number; severity?: string }>;
  positive_signals?: Array<{ signal: string; count?: number; type?: string }>;
  objections?: Array<{ objection: string; count?: number; type?: string }>;
  sentiment_summary?: string;
  purchase_intent_score?: number;
  viral_potential?: string;
  key_takeaway?: string;
  [key: string]: unknown;
}

export interface BriefGenerationParams {
  clientName: string;
  brandBible: BrandBible;
  briefTemplate?: string;
  videoAnalyses: VideoAnalysis[];
  commentInsights: CommentInsight[];
  projectKeywords: string[];
  platform: string;
}

export interface Brief {
  title?: string;
  objective?: string;
  target_audience?: string;
  key_insight?: string;
  hook_suggestions?: Array<{ hook_text: string; hook_type: string; rationale: string; reference_video_index?: number }>;
  content_directions?: Array<{ direction: string; rationale: string; format_suggestion: string; estimated_performance?: string }>;
  script_outline?: string;
  tone_guidance?: string;
  do_list?: string[];
  dont_list?: string[];
  [key: string]: unknown;
}

function formatVideoAnalyses(analyses: VideoAnalysis[]): string {
  return analyses
    .map(
      (v, i) =>
        `[Video ${i + 1}] Score: ${v.ai_score ?? 'N/A'}/100 | Hook: ${v.hook_type ?? 'N/A'} | Format: ${v.video_format ?? 'N/A'}\n` +
        `- Hook analysis: ${v.hook_analysis ?? 'N/A'}\n` +
        `- Content structure: ${v.content_structure ?? 'N/A'}\n` +
        `- CTA: ${v.cta_type ?? 'N/A'} | Tone: ${v.emotion_tone ?? 'N/A'}\n` +
        `- Key messages: ${(v.key_messages ?? []).join('; ')}\n` +
        `- Strengths: ${(v.strengths ?? []).join('; ')}\n` +
        `- Weaknesses: ${(v.weaknesses ?? []).join('; ')}\n` +
        `- Target audience guess: ${v.target_audience_guess ?? 'N/A'}`
    )
    .join('\n\n');
}

function formatCommentInsights(insights: CommentInsight[]): string {
  return insights
    .map((c) => {
      const q = (c.top_questions ?? []).map((x) => `  - ${x.question} (count: ${x.count ?? 0})`).join('\n');
      const p = (c.pain_points ?? []).map((x) => `  - ${x.pain_point} (${x.severity ?? 'N/A'})`).join('\n');
      const o = (c.objections ?? []).map((x) => `  - ${x.objection} (${x.type ?? 'N/A'})`).join('\n');
      return (
        `Sentiment: ${c.sentiment_summary ?? 'N/A'} | Purchase intent: ${c.purchase_intent_score ?? 'N/A'}/100 | Viral: ${c.viral_potential ?? 'N/A'}\n` +
        `Top questions:\n${q || '  (none)'}\n` +
        `Pain points:\n${p || '  (none)'}\n` +
        `Objections:\n${o || '  (none)'}\n` +
        `Key takeaway: ${c.key_takeaway ?? 'N/A'}`
      );
    })
    .join('\n\n---\n\n');
}

function formatBriefSummary(brief: Brief): string {
  const parts: string[] = [];
  if (brief.title) parts.push(`Tiêu đề: ${brief.title}`);
  if (brief.objective) parts.push(`Mục tiêu: ${brief.objective}`);
  if (brief.target_audience) parts.push(`Target: ${brief.target_audience}`);
  if (brief.key_insight) parts.push(`Key insight: ${brief.key_insight}`);
  if (brief.script_outline) parts.push(`Script outline: ${brief.script_outline}`);
  if (brief.tone_guidance) parts.push(`Tone: ${brief.tone_guidance}`);
  const hooks = brief.hook_suggestions?.map((h) => `- ${h.hook_text} (${h.hook_type}): ${h.rationale}`).join('\n');
  if (hooks) parts.push(`Hook gợi ý:\n${hooks}`);
  const dirs = brief.content_directions?.map((d) => `- ${d.direction} | Format: ${d.format_suggestion}`).join('\n');
  if (dirs) parts.push(`Hướng nội dung:\n${dirs}`);
  if (brief.do_list?.length) parts.push(`Nên làm: ${brief.do_list.join('; ')}`);
  if (brief.dont_list?.length) parts.push(`Không nên: ${brief.dont_list.join('; ')}`);
  return parts.join('\n');
}

function formatBrandBibleRelevant(brandBible: BrandBible): string {
  return [
    `Tone of Voice: ${brandBible.tone_of_voice}`,
    `Target Audience: ${brandBible.target_audience}`,
    `Brand Values: ${brandBible.brand_values}`,
    `Key Messages: ${brandBible.key_messages}`,
    `Nên làm: ${brandBible.do_list}`,
    `Không nên: ${brandBible.dont_list}`,
  ].join('\n');
}

/**
 * Prompt gửi cho Gemini khi phân tích video.
 */
export function VIDEO_ANALYSIS_PROMPT(videoDescription: string, platform: string): string {
  return `Bạn là chuyên gia phân tích video marketing trên ${platform}. Hãy phân tích video này và trả lời bằng JSON.

Thông tin video:
${videoDescription}

Hãy phân tích và trả về JSON với format:
{
  "hook_analysis": "Phân tích chi tiết 3 giây đầu tiên của video - cách thu hút attention",
  "content_structure": "Mô tả cấu trúc nội dung từ đầu đến cuối",
  "cta_type": "direct_sale | soft_sell | engagement | brand_awareness | education | null",
  "emotion_tone": "Tone cảm xúc chính: vui vẻ, nghiêm túc, FOMO, tin cậy, hài hước...",
  "video_format": "ugc | review | skit | tutorial | unboxing | lifestyle | comparison | before_after | storytelling | other",
  "key_messages": ["Message chính 1", "Message 2", "Message 3"],
  "strengths": ["Điểm mạnh 1", "Điểm mạnh 2"],
  "weaknesses": ["Điểm yếu 1", "Điểm yếu 2"],
  "ai_score": 75,
  "hook_type": "question | shock | curiosity | pain_point | result_first | trending_sound | other",
  "target_audience_guess": "Đoán đối tượng mục tiêu của video"
}

Lưu ý:
- Phân tích dựa trên góc nhìn marketing performance, không phải chất lượng sản xuất
- Hook analysis phải cụ thể: nói RÕ kỹ thuật gì được dùng
- Strengths/weaknesses phải actionable, có thể áp dụng cho brief
- AI score dựa trên: hook strength (30%), content structure (25%), CTA effectiveness (20%), engagement potential (25%)
- ai_score là số nguyên từ 1-100, đánh giá tổng thể chất lượng content marketing`;
}

/**
 * Prompt gửi cho Claude khi phân tích comments.
 */
export function COMMENT_ANALYSIS_PROMPT(comments: string[], videoCaption: string): string {
  const formattedComments = comments.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `Bạn là chuyên gia phân tích consumer insights từ social media comments. Phân tích các comments sau từ một video marketing.

Caption video: ${videoCaption}

Comments:
${formattedComments}

Hãy phân tích và trả về JSON:
{
  "top_questions": [
    {"question": "Câu hỏi phổ biến", "count": 5, "sentiment": "curious"}
  ],
  "pain_points": [
    {"pain_point": "Vấn đề khách hàng gặp phải", "count": 3, "severity": "high"}
  ],
  "positive_signals": [
    {"signal": "Tín hiệu tích cực", "count": 8, "type": "purchase_intent | satisfaction | recommendation"}
  ],
  "objections": [
    {"objection": "Lý do ngần ngại mua", "count": 4, "type": "price | trust | quality | convenience"}
  ],
  "sentiment_summary": "Tóm tắt 2-3 câu về tâm lý chung của người xem",
  "purchase_intent_score": 65,
  "viral_potential": "low | medium | high",
  "key_takeaway": "1 insight quan trọng nhất cho marketer"
}

Lưu ý:
- Group các comments tương tự lại, đếm frequency
- Phân biệt giữa bot comments và real comments
- Comments tiếng Việt có thể có typo, viết tắt (ko = không, dc = được, nc = nói chung) — hãy hiểu ngữ cảnh
- Focus vào insights có thể dùng được cho creative brief
- purchase_intent_score là số nguyên 1-100`;
}

/**
 * Prompt tạo creative brief từ research data.
 */
export function BRIEF_GENERATION_PROMPT(params: BriefGenerationParams): string {
  const {
    clientName,
    brandBible,
    briefTemplate,
    videoAnalyses,
    commentInsights,
    projectKeywords,
    platform,
  } = params;

  const videoBlock = formatVideoAnalyses(videoAnalyses);
  const commentBlock = formatCommentInsights(commentInsights);
  const templateSection = briefTemplate
    ? `## TEMPLATE BRIEF CỦA CLIENT\nHãy theo đúng format template sau:\n${briefTemplate}`
    : `## FORMAT BRIEF\nHãy tạo brief theo format chuẩn sau: title, objective, target_audience, key_insight, hook_suggestions, content_directions, script_outline, tone_guidance, do_list, dont_list, reference_video_indices.`;

  return `Bạn là Creative Director tại một agency quảng cáo hàng đầu Việt Nam. Hãy tạo creative brief dựa trên data research sau.

## THÔNG TIN CLIENT
Tên: ${clientName}
Tone of Voice: ${brandBible.tone_of_voice}
Target Audience: ${brandBible.target_audience}
Brand Values: ${brandBible.brand_values}
Key Messages: ${brandBible.key_messages}
Điều NÊN làm: ${brandBible.do_list}
Điều KHÔNG NÊN: ${brandBible.dont_list}

## KẾT QUẢ NGHIÊN CỨU
Platform: ${platform}
Keywords nghiên cứu: ${projectKeywords.join(', ')}

### Top Videos phân tích:
${videoBlock}

### Consumer Insights từ Comments:
${commentBlock}

${templateSection}

Trả về JSON:
{
  "title": "Tên brief ngắn gọn, hấp dẫn",
  "objective": "Mục tiêu rõ ràng, đo lường được",
  "target_audience": "Mô tả chi tiết target dựa trên brand bible + insights từ comments",
  "key_insight": "1 consumer insight mạnh nhất rút ra từ data — phải cụ thể và actionable",
  "hook_suggestions": [
    {
      "hook_text": "Câu hook gợi ý dưới 10 từ",
      "hook_type": "question | shock | curiosity | pain_point | result_first",
      "rationale": "Tại sao hook này sẽ hiệu quả, dựa trên data nào",
      "reference_video_index": 0
    }
  ],
  "content_directions": [
    {
      "direction": "Hướng nội dung cụ thể",
      "rationale": "Lý do dựa trên data",
      "format_suggestion": "ugc | review | skit | tutorial | comparison | storytelling",
      "estimated_performance": "Dự đoán performance dựa trên benchmark từ videos đã phân tích"
    }
  ],
  "script_outline": "Outline script chi tiết: Hook (3s) → Problem (5s) → Solution (10s) → Proof (10s) → CTA (5s)",
  "tone_guidance": "Hướng dẫn tone cụ thể cho content này, nhất quán với brand bible",
  "do_list": ["Nên làm 1 dựa trên top videos", "Nên làm 2", "..."],
  "dont_list": ["Không nên 1 dựa trên weaknesses phát hiện", "Không nên 2", "..."],
  "reference_video_indices": [0, 2, 4]
}

Yêu cầu:
- Brief phải DỰA TRÊN DATA, không generic
- Mỗi recommendation phải có rationale từ videos/comments đã phân tích
- Hook suggestions phải inspired by top-performing hooks trong research
- Content directions phải realistic và phù hợp với brand
- Script outline phải cụ thể đến từng giây
- Viết hoàn toàn bằng tiếng Việt, giọng chuyên nghiệp agency`;
}

/**
 * Prompt tạo script outline chi tiết từ brief đã có.
 */
export function SCRIPT_OUTLINE_PROMPT(brief: Brief, brandBible: BrandBible, platform: string): string {
  const briefSummary = formatBriefSummary(brief);
  const brandBlock = formatBrandBibleRelevant(brandBible);

  return `Dựa trên creative brief sau, hãy viết script outline chi tiết cho video ${platform}.

Brief:
${briefSummary}

Brand Bible:
${brandBlock}

Trả về JSON:
{
  "total_duration_seconds": 30,
  "scenes": [
    {
      "scene_number": 1,
      "duration_seconds": 3,
      "type": "hook",
      "visual_description": "Mô tả hình ảnh/hành động",
      "audio_text": "Lời nói/voiceover exact text",
      "text_overlay": "Text hiện trên màn hình",
      "music_mood": "upbeat | emotional | dramatic | chill",
      "notes": "Ghi chú cho creator/editor"
    }
  ],
  "overall_notes": "Ghi chú tổng thể về style, pacing, mood",
  "hashtag_suggestions": ["#hashtag1", "#hashtag2"],
  "posting_time_suggestion": "Gợi ý thời gian đăng dựa trên platform"
}

Yêu cầu:
- Scenes phải cover đủ: hook → body → proof/CTA
- audio_text phải là lời cụ thể bằng tiếng Việt, sẵn sàng cho creator đọc
- Viết hoàn toàn bằng tiếng Việt`;
}
