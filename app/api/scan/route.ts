import { NextResponse } from "next/server";

// Constants
const RATE_LIMIT = 15;
const WINDOW_MS = 60000;
const MAX_TEXT_LENGTH = 12000;
const FETCH_TIMEOUT = 10000;
const GEMINI_TIMEOUT_TEXT = 30000;
const GEMINI_TIMEOUT_IMAGE = 45000; // Longer timeout for images
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// Types
interface RateLimitEntry {
  count: number;
  timestamp: number;
}

interface AnalysisReport {
  risk_score: number;
  risk_level: "low" | "medium" | "high";
  red_flags: string[];
  verification_steps: string[];
  neutral_rewrite: string;
  one_line_summary: string;
  truncated?: boolean; // NEW: Flag for truncated content
  used_fallback?: boolean; // NEW: Flag for fallback scoring
}

// Rate limiting storage
const rateLimit = new Map<string, RateLimitEntry>();

// Helper functions
function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  return forwarded?.split(",")[0] || realIp || "unknown";
}

function cleanupRateLimit(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimit.entries()) {
    if (now - entry.timestamp >= WINDOW_MS) {
      rateLimit.delete(ip);
    }
  }
}

function isPrivateIP(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  text = text
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n$1\n\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n");

  text = text.replace(/<[^>]+>/g, " ");

  text = text
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();

  return text;
}

async function fetchWithTimeout(
  url: string,
  timeout: number
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TruthLensBot/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    clearTimeout(timeoutId);
    return response;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * IMPROVED: Safer JSON extraction using incremental parsing
 * instead of manual string manipulation
 */
function extractJsonFromResponse(raw: string): string {
  const trimmed = raw.trim();

  // Try to extract from code block first
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const toParse = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;

  // Find first opening brace
  const start = toParse.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found in response");
  }

  // Try parsing progressively larger substrings until we get valid JSON
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < toParse.length; i++) {
    const char = toParse[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) {
        // Found potential end, try parsing
        const candidate = toParse.slice(start, i + 1);
        try {
          JSON.parse(candidate); // Validate it's actually valid JSON
          return candidate;
        } catch {
          // Not valid yet, continue searching
          continue;
        }
      }
    }
  }

  throw new Error("No complete JSON object found in response");
}

/**
 * IMPROVED: Better validation with detailed error messages
 */
function validateAndNormalizeReport(parsed: any): AnalysisReport {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid report structure: expected object, got ${typeof parsed}`);
  }

  // Validate risk_score
  const rawScore = parsed.risk_score;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    throw new Error(
      `Invalid risk_score: expected number, got ${typeof rawScore} (${rawScore})`
    );
  }

  const risk_score = Math.round(Math.max(0, Math.min(100, rawScore)));

  // Determine risk_level - prefer model's judgment if valid
  let risk_level: "low" | "medium" | "high";
  if (
    parsed.risk_level &&
    ["low", "medium", "high"].includes(parsed.risk_level)
  ) {
    risk_level = parsed.risk_level;
  } else {
    // Fallback calculation with consistent thresholds
    risk_level = risk_score >= 70 ? "high" : risk_score >= 40 ? "medium" : "low";
  }

  // Validate red_flags
  if (!Array.isArray(parsed.red_flags)) {
    throw new Error(
      `Invalid red_flags: expected array, got ${typeof parsed.red_flags}`
    );
  }
  const red_flags = parsed.red_flags
    .filter((f: any) => typeof f === "string")
    .map((f: string) => f.trim())
    .filter(Boolean);

  // Ensure at least one red flag
  if (red_flags.length === 0) {
    red_flags.push("No specific risk indicators identified");
  }

  // Validate verification_steps
  if (!Array.isArray(parsed.verification_steps)) {
    throw new Error(
      `Invalid verification_steps: expected array, got ${typeof parsed.verification_steps}`
    );
  }
  const verification_steps = parsed.verification_steps
    .filter((s: any) => typeof s === "string")
    .map((s: string) => s.trim())
    .filter(Boolean);

  // Ensure at least one step
  if (verification_steps.length === 0) {
    verification_steps.push(
      "Search for the claim in reputable news sources",
      "Check official sources and fact-checking sites",
      "Verify the date and context of the information"
    );
  }

  // Validate strings
  if (typeof parsed.neutral_rewrite !== "string") {
    throw new Error(
      `Invalid neutral_rewrite: expected string, got ${typeof parsed.neutral_rewrite}`
    );
  }
  if (typeof parsed.one_line_summary !== "string") {
    throw new Error(
      `Invalid one_line_summary: expected string, got ${typeof parsed.one_line_summary}`
    );
  }

  return {
    risk_score,
    risk_level,
    red_flags,
    verification_steps,
    neutral_rewrite: parsed.neutral_rewrite.trim(),
    one_line_summary: parsed.one_line_summary.trim(),
  };
}

/**
 * IMPROVED: Retry logic with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry on validation errors
      if (lastError.message.includes("Invalid")) {
        throw lastError;
      }

      // Don't retry if we're out of attempts
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Retry failed");
}

/**
 * IMPROVED: Better text analysis prompt with content-aware scoring
 */
async function analyzeTextWithGemini(text: string): Promise<AnalysisReport> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = `You are a misinformation detection system. Analyze the following content for credibility, manipulation tactics, and misinformation risk.

Content to analyze:
"""
${text}
"""

Analyze systematically:
1. What specific claims are made?
2. Are sources cited? Are they credible and verifiable?
3. What manipulation tactics are present? (urgency, fear appeals, too-good-to-be-true promises, emotional manipulation, conspiracy thinking, fake authority)
4. Is this verifiable through reputable sources?
5. What is the overall misinformation risk level?

Risk scoring guidelines (0-100):
- 0-30: Low risk → Factual, neutral tone, credible sources cited, verifiable claims, no manipulation tactics
- 31-69: Medium risk → Unverified claims, missing/questionable sources, emotional language, clickbait, partial truth with misleading context
- 70-100: High risk → Clear misinformation, scams, dangerous medical advice, conspiracy theories, manipulated facts, fake news, obvious deception

IMPORTANT: Score based on content credibility, not just tone. Even politely-worded text can be high-risk if it contains false claims.

Return ONLY a JSON object with this EXACT structure (no markdown, no explanation):
{
  "risk_score": <number 0-100>,
  "risk_level": "<low|medium|high>",
  "red_flags": ["<specific flag 1>", "<specific flag 2>", "<flag 3>"],
  "verification_steps": ["<specific step 1>", "<specific step 2>", "<specific step 3>", "<step 4>"],
  "neutral_rewrite": "<rewrite the content in a neutral, factual way>",
  "one_line_summary": "<one sentence summary of the risk>"
}`;

  return retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_TEXT);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              topK: 1,
              topP: 0.95,
              maxOutputTokens: 2048,
            },
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetail = "Unknown error";
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson?.error?.message || errorText;
        } catch {
          errorDetail = errorText;
        }
        console.error("Gemini API error:", response.status, errorDetail);
        throw new Error(`Gemini API failed: ${response.status} - ${errorDetail}`);
      }

      const data = await response.json();
      const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText || typeof generatedText !== "string") {
        throw new Error("Empty response from Gemini");
      }

      const jsonStr = extractJsonFromResponse(generatedText);
      const parsed = JSON.parse(jsonStr);
      return validateAndNormalizeReport(parsed);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Gemini API timeout");
      }
      throw error;
    }
  });
}

/**
 * IMPROVED: Better image analysis prompt with content-aware scoring
 * KEY FIX: Explicitly tell model to score TEXT content within images
 */
async function analyzeImageWithGemini(
  base64: string,
  mimeType: string
): Promise<AnalysisReport> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const prompt = `You are a visual misinformation detection system analyzing images for deceptive or manipulated content.

CRITICAL INSTRUCTION: You are NOT just looking for pixel-level manipulation. You are analyzing the IMAGE AS A WHOLE for misinformation risk, including:
- TEXT content within the image (captions, overlays, headlines, messages)
- Claims made in the image (even if the photo itself is real)
- Context and intent (scam indicators, fake alerts, manipulated screenshots)

Examine for:

1. **Text-Based Misinformation** (HIGHEST PRIORITY):
   - Fake alerts, warnings, or system messages
   - Scam indicators (urgency, prizes, "act now", fake payment receipts)
   - False medical/health claims
   - Fake news headlines or social media screenshots
   - Conspiracy theories or unverified claims
   
2. **Visual Manipulation**:
   - Deepfakes or AI-generated faces
   - Photo editing (splicing, cloning, warping)
   - Inconsistent lighting, shadows, or perspectives
   - Fake screenshots with edited UI elements
   
3. **Context Manipulation**:
   - Old photos presented as recent events
   - Unrelated images with misleading captions
   - Out-of-context imagery

Risk scoring guidelines (0-100):
- 0-30: Low risk → Authentic content, no suspicious text, clear benign context, no manipulation detected
- 31-69: Medium risk → Suspicious elements, unverified claims in text, unclear provenance, possible manipulation, clickbait imagery
- 70-100: High risk → Clear scam indicators in text, obvious fake alerts, deepfake markers, forged documents, dangerous misinformation, manipulated screenshots

IMPORTANT: 
- If the image contains TEXT with scam/urgency/fake alert language, score 60+ regardless of visual manipulation
- A real photo with fake text overlays is HIGH RISK
- Do NOT default to low scores just because you can't detect pixel manipulation

Return ONLY a JSON object with this EXACT structure (no markdown, no explanation):
{
  "risk_score": <number 0-100>,
  "risk_level": "<low|medium|high>",
  "red_flags": ["<specific indicator 1>", "<specific indicator 2>", "<indicator 3>"],
  "verification_steps": ["<specific action 1>", "<specific action 2>", "<specific action 3>", "<action 4>"],
  "neutral_rewrite": "<describe what the image shows in neutral, factual terms>",
  "one_line_summary": "<one sentence assessment of the image's credibility>"
}`;

  return retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_IMAGE);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: base64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              topK: 1,
              topP: 0.95,
              maxOutputTokens: 2048,
            },
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetail = "Unknown error";
        try {
          const errorJson = JSON.parse(errorText);
          errorDetail = errorJson?.error?.message || errorText;
        } catch {
          errorDetail = errorText;
        }
        console.error("Gemini Vision API error:", response.status, errorDetail);
        throw new Error(
          `Gemini Vision API failed: ${response.status} - ${errorDetail}`
        );
      }

      const data = await response.json();
      const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText || typeof generatedText !== "string") {
        throw new Error("Empty response from Gemini Vision");
      }

      const jsonStr = extractJsonFromResponse(generatedText);
      const parsed = JSON.parse(jsonStr);
      return validateAndNormalizeReport(parsed);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Gemini Vision API timeout");
      }
      throw error;
    }
  });
}

/**
 * IMPROVED: Fallback with better scoring and logging
 */
function getFallbackReport(content: string, mode: string): AnalysisReport {
  console.warn(`⚠️ Using fallback report for mode: ${mode}`);
  
  const hasUrgency =
    /urgent|act now|hurry|limited time|today only|don't miss|breaking|immediately|asap/i.test(
      content
    );
  const hasMoney =
    /\$\d+|\d+\s*dollars|free money|cash|claim|win|prize|jackpot|lottery/i.test(
      content
    );
  const hasHealth =
    /cure|doctor|medical|disease|treatment|remedy|heal|miracle|guaranteed/i.test(
      content
    );
  const hasClickbait =
    /won't believe|shocking|secret|they don't want|one weird trick|doctors hate/i.test(
      content
    );
  const hasAllCaps = /[A-Z]{8,}/.test(content);

  let score = 35;
  const flags: string[] = [];

  if (hasUrgency) {
    score += 20;
    flags.push("Uses urgency or pressure tactics");
  }
  if (hasMoney) {
    score += 20;
    flags.push("Contains financial claims or promises");
  }
  if (hasHealth) {
    score += 15;
    flags.push("Contains health or medical claims");
  }
  if (hasClickbait) {
    score += 15;
    flags.push("Uses sensational or clickbait language");
  }
  if (hasAllCaps) {
    score += 10;
    flags.push("Excessive capitalization for emphasis");
  }

  if (flags.length === 0) {
    flags.push("No credible source verification available");
    flags.push("Unable to verify claims through automated analysis");
  }

  score = Math.min(100, score);

  const level: "low" | "medium" | "high" =
    score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  return {
    risk_score: score,
    risk_level: level,
    red_flags: flags,
    verification_steps: [
      "Search for the specific claim in reputable news outlets",
      "Check official government or organization sources",
      "Verify the date, location, and context of the information",
      "Look for corroboration from multiple independent sources",
      "Consult fact-checking sites like Snopes or FactCheck.org",
      "Avoid sharing until you can independently confirm",
    ],
    neutral_rewrite:
      mode === "image"
        ? "This image requires verification. Check the source, context, and any claims made before sharing."
        : "This claim is circulating online. Verify with multiple reliable sources before accepting or sharing.",
    one_line_summary:
      "Automated AI analysis was unavailable; manual verification strongly recommended.",
    used_fallback: true,
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const now = Date.now();

  // Periodic cleanup
  if (Math.random() < 0.01) {
    cleanupRateLimit();
  }

  // Rate limiting
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.timestamp >= WINDOW_MS) {
    rateLimit.set(ip, { count: 1, timestamp: now });
  } else {
    if (entry.count >= RATE_LIMIT) {
      return NextResponse.json(
        { success: false, error: "Too many requests. Please wait a moment." },
        { status: 429, headers: corsHeaders }
      );
    }
    rateLimit.set(ip, { count: entry.count + 1, timestamp: entry.timestamp });
  }

  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { success: false, error: "Invalid request body" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!body.type || typeof body.type !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing or invalid field: type" },
        { status: 400, headers: corsHeaders }
      );
    }

    let report: AnalysisReport;

    // TEXT MODE
    if (body.type === "text") {
      if (typeof body.text !== "string") {
        return NextResponse.json(
          { success: false, error: "Invalid field: text must be string" },
          { status: 400, headers: corsHeaders }
        );
      }

      const extractedText = body.text.trim();

      if (!extractedText) {
        return NextResponse.json(
          { success: false, error: "Content cannot be empty" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (extractedText.length > MAX_TEXT_LENGTH) {
        return NextResponse.json(
          { success: false, error: `Text exceeds ${MAX_TEXT_LENGTH} characters` },
          { status: 400, headers: corsHeaders }
        );
      }

      try {
        report = await analyzeTextWithGemini(extractedText);
      } catch (error) {
        console.error("Text analysis failed:", error);
        report = getFallbackReport(extractedText, "text");
      }
    }
    // URL MODE
    else if (body.type === "url") {
      if (typeof body.url !== "string") {
        return NextResponse.json(
          { success: false, error: "Invalid field: url must be string" },
          { status: 400, headers: corsHeaders }
        );
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(body.url);
      } catch {
        return NextResponse.json(
          { success: false, error: "Invalid URL format" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return NextResponse.json(
          { success: false, error: "Only HTTP(S) URLs allowed" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (isPrivateIP(parsedUrl.hostname)) {
        return NextResponse.json(
          { success: false, error: "Invalid URL" },
          { status: 400, headers: corsHeaders }
        );
      }

      const response = await fetchWithTimeout(
        parsedUrl.toString(),
        FETCH_TIMEOUT
      );

      if (!response || !response.ok) {
        return NextResponse.json(
          { success: false, error: "Couldn't fetch URL. Try pasting the text instead." },
          { status: 400, headers: corsHeaders }
        );
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/") && !contentType.includes("html")) {
        return NextResponse.json(
          { success: false, error: "URL must return text or HTML content" },
          { status: 400, headers: corsHeaders }
        );
      }

      const html = await response.text();
      let extractedText = stripHtml(html);

      if (!extractedText) {
        return NextResponse.json(
          { success: false, error: "No readable content found at URL" },
          { status: 400, headers: corsHeaders }
        );
      }

      let wasTruncated = false;
      if (extractedText.length > MAX_TEXT_LENGTH) {
        extractedText = extractedText.slice(0, MAX_TEXT_LENGTH);
        wasTruncated = true;
      }

      try {
        report = await analyzeTextWithGemini(extractedText);
        if (wasTruncated) {
          report.truncated = true;
        }
      } catch (error) {
        console.error("URL analysis failed:", error);
        report = getFallbackReport(extractedText, "url");
        if (wasTruncated) {
          report.truncated = true;
        }
      }
    }
    // IMAGE MODE
    else if (body.type === "image") {
      if (typeof body.image_base64 !== "string") {
        return NextResponse.json(
          { success: false, error: "Invalid field: image_base64 must be string" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (typeof body.image_mime !== "string") {
        return NextResponse.json(
          { success: false, error: "Invalid field: image_mime must be string" },
          { status: 400, headers: corsHeaders }
        );
      }

      const validMimeTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/gif",
      ];
      if (!validMimeTypes.includes(body.image_mime.toLowerCase())) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid image format. Use JPG, PNG, WEBP, or GIF.",
          },
          { status: 400, headers: corsHeaders }
        );
      }

      const base64 = body.image_base64;
      const sizeEstimate = (base64.length * 3) / 4;
      const maxSize = 10 * 1024 * 1024; // 10MB

      if (sizeEstimate > maxSize) {
        return NextResponse.json(
          { success: false, error: "Image too large. Maximum 10MB." },
          { status: 400, headers: corsHeaders }
        );
      }

      try {
        report = await analyzeImageWithGemini(base64, body.image_mime);
      } catch (error) {
        console.error("Image analysis failed:", error);
        report = getFallbackReport("", "image");
      }
    }
    // UNKNOWN TYPE
    else {
      return NextResponse.json(
        {
          success: false,
          error: "Unsupported type. Use 'text', 'url', or 'image'.",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: true, data: report },
      { headers: corsHeaders }
    );
  } catch (err) {
    console.error("API Error:", err);
    return NextResponse.json(
      { success: false, error: "An error occurred. Please try again." },
      { status: 500, headers: corsHeaders }
    );
  }
}