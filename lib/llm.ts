// Fallback/inline buildPrompt to avoid a missing-module TypeScript error
// and ensure this file compiles even if ./prompt is not present.
function buildPrompt(userText: string): string {
  return `You are an assistant that analyzes text for potential misinformation and outputs a single JSON object with the following keys: \n` +
    `risk_score (number 0-100), risk_level (one of \"low\", \"medium\", \"high\"), red_flags (array of strings), verification_steps (array of strings), neutral_rewrite (string), one_line_summary (string).\n` +
    `Respond ONLY with the JSON object. Do not include any surrounding commentary.\n\nInput:\n${userText}`;
}

export type RiskReport = {
  risk_score: number;
  risk_level: "low" | "medium" | "high";
  red_flags: string[];
  verification_steps: string[];
  neutral_rewrite: string;
  one_line_summary: string;
};

/**
 * Extracts the first complete JSON object from LLM output.
 * Handles code blocks and nested braces safely.
 */
function extractFirstJsonObject(raw: string): string {
  const trimmed = raw.trim();

  // If wrapped in ```json block, extract inner content
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const toParse = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;

  const start = toParse.indexOf("{");
  if (start === -1) {
    throw new Error("Invalid LLM response format");
  }

  let depth = 0;
  let i = start;

  while (i < toParse.length) {
    const c = toParse[i];

    // Skip string content safely
    if (c === '"') {
      i++;
      while (i < toParse.length) {
        if (toParse[i] === "\\") {
          i += 2;
          continue;
        }
        if (toParse[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) {
        return toParse.slice(start, i + 1);
      }
    }

    i++;
  }

  throw new Error("Invalid LLM response format");
}

function parseReport(jsonStr: string): RiskReport {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Invalid LLM response format");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid LLM response structure");
  }

  const obj = parsed as Record<string, unknown>;

  // Risk score validation
  const rawScore = obj.risk_score;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    throw new Error("Invalid LLM response structure");
  }

  const risk_score = Math.round(Math.max(0, Math.min(100, rawScore)));

  const risk_level: RiskReport["risk_level"] =
    risk_score <= 33 ? "low" :
    risk_score <= 66 ? "medium" :
    "high";

  // red_flags
  if (
    !Array.isArray(obj.red_flags) ||
    obj.red_flags.some((f) => typeof f !== "string")
  ) {
    throw new Error("Invalid LLM response structure");
  }

  const red_flags = (obj.red_flags as string[])
    .map((s) => s.trim())
    .filter(Boolean);

  // verification_steps
  if (
    !Array.isArray(obj.verification_steps) ||
    obj.verification_steps.some((s) => typeof s !== "string")
  ) {
    throw new Error("Invalid LLM response structure");
  }

  const verification_steps = (obj.verification_steps as string[])
    .map((s) => s.trim())
    .filter(Boolean);

  if (typeof obj.neutral_rewrite !== "string") {
    throw new Error("Invalid LLM response structure");
  }

  if (typeof obj.one_line_summary !== "string") {
    throw new Error("Invalid LLM response structure");
  }

  return {
    risk_score,
    risk_level,
    red_flags,
    verification_steps,
    neutral_rewrite: obj.neutral_rewrite.trim(),
    one_line_summary: obj.one_line_summary.trim(),
  };
}

async function callLLM(userText: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const prompt = buildPrompt(userText);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 500,
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      throw new Error(`LLM API failed: ${response.status}`);
    }

    const data = await response.json();

    const output =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!output || typeof output !== "string") {
      throw new Error("Empty LLM response");
    }

    return output;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("LLM API timeout");
    }

    throw err;
  }
}

/**
 * Public function used by API route.
 */
export async function analyzeText(userText: string): Promise<RiskReport> {
  const raw = await callLLM(userText);
  const jsonStr = extractFirstJsonObject(raw);
  return parseReport(jsonStr);
}
