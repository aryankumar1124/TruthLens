"use client";

import { useState, type ChangeEvent, type DragEvent } from "react";

type RiskLevel = "low" | "medium" | "high";
type Report = {
  risk_score: number;
  risk_level: RiskLevel;
  red_flags: string[];
  verification_steps: string[];
  neutral_rewrite: string;
  one_line_summary: string;
};

const MOCK_REPORT: Report = {
  risk_score: 82,
  risk_level: "high",
  red_flags: ["Urgency language", "No credible source", "Too-good-to-be-true", "Call to share"],
  verification_steps: [
    "Look for the original source (not a forwarded screenshot).",
    "Search the exact claim in reputable outlets.",
    "Check if an official website/agency confirms it.",
    "Verify date, location, and specific details.",
    "Avoid sharing until you can confirm independently."
  ],
  neutral_rewrite:
    "I saw a claim about this circulating. Before sharing, it's worth checking the original source and confirming with reputable reporting or official information.",
  one_line_summary: "A message urges immediate action and sharing while providing no reliable source."
};

function badgeClass(level: RiskLevel) {
  if (level === "high") return "border-red-500/30 bg-red-500/10 text-red-300";
  if (level === "medium") return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
}

function getRiskContext(score: number) {
  if (score >= 80) return "Higher than most scans";
  if (score >= 60) return "Proceed with caution";
  if (score >= 40) return "Some concerns detected";
  return "Lower than most scans";
}

function getRiskMessage(level: RiskLevel) {
  if (level === "high") return "🚨 High-risk signals detected";
  if (level === "medium") return "⚠️ Some risk signals detected";
  return "✓ Relatively lower risk";
}

// === NEW: fileToDataUrl helper ===
async function fileToDataUrl(file: File): Promise<{ dataUrl: string; base64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ dataUrl, base64, mime: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [copied, setCopied] = useState(false);
  const [checkedSteps, setCheckedSteps] = useState<boolean[]>([]);

  // === NEW: input mode state ===
  const [mode, setMode] = useState<"text" | "url" | "image">("text");
  const [url, setUrl] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // === NEW: updated handleScan payload ===
  async function handleScan() {
    setError(null);
    setReport(null);
    setCheckedSteps([]);

    let payload: any = {};

    if (mode === "text") {
      const trimmed = text.trim();
      if (!trimmed) {
        setError("Paste some text first.");
        return;
      }
      payload = { type: "text", text: trimmed };
    } else if (mode === "url") {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setError("Enter a URL first.");
        return;
      }
      payload = { type: "url", url: trimmedUrl };
    } else if (mode === "image") {
      if (!imageFile) {
        setError("Upload an image first.");
        return;
      }
      try {
        const { base64, mime } = await fileToDataUrl(imageFile);
        payload = { type: "image", image_base64: base64, image_mime: mime };
      } catch {
        setError("Failed to process image.");
        return;
      }
    }

    setLoading(true);
    try {
  const res = await fetch("http://localhost:3001/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json: any = await res.json();

  if (!res.ok || json?.success === false) {
    setError(json?.error ?? "Scan failed.");
    return;
  }

  const reportData = json?.data ?? json;

  setReport(reportData);
  setCheckedSteps(
    new Array(reportData.verification_steps?.length || 0).fill(false)
  );

} catch {
  setError("Backend request failed (check Network tab).");
  setReport(null);
  return;
} finally {
  setLoading(false);
}
  }

  function copy(textToCopy: string) {
    navigator.clipboard?.writeText(textToCopy).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function toggleStep(idx: number) {
    setCheckedSteps((prev) => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  }

  // === NEW: handle image upload ===
  async function handleImageUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    processImageFile(file);
  }

  // === NEW: process image file (shared between click and drag-drop) ===
  async function processImageFile(file: File) {
    // Validate file type
    if (!file.type.startsWith("image/")) {
      setError("Please drop an image file (PNG/JPG).");
      return;
    }

    setError(null);
    setReport(null);
    setImageFile(file);

    try {
      const { dataUrl } = await fileToDataUrl(file);
      setImagePreview(dataUrl);
    } catch {
      setError("Failed to load image preview.");
    }
  }

  // === NEW: drag and drop handlers ===
  function handleDragEnter(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    // Helps some browsers show the right cursor state
    e.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const dt = e.dataTransfer;

    // More robust than files[0] only
    const item = dt.items && dt.items.length > 0 ? dt.items[0] : null;
    const file = item?.kind === "file" ? item.getAsFile() : dt.files?.[0];

    if (file) processImageFile(file);
  }

  const charCount = text.trim().length;
  const charLimit = 1200;
  const charPercent = Math.min((charCount / charLimit) * 100, 100);

  return (
    <main className="relative min-h-screen bg-zinc-950 text-zinc-100 overflow-hidden flex flex-col">
      {/* Animated mesh gradient background */}
      <div className="fixed inset-0 opacity-40">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl animate-blob" />
        <div className="absolute top-0 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl animate-blob animation-delay-2000" />
        <div className="absolute bottom-0 left-1/3 w-96 h-96 bg-indigo-500/20 rounded-full blur-3xl animate-blob animation-delay-4000" />
      </div>

      {/* === Central darker purple glow for depth === */}
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none opacity-30">
        <div className="w-[800px] h-[800px] bg-purple-700/25 rounded-full blur-3xl" />
      </div>

      {/* Noise texture overlay */}
      <div
        className="fixed inset-0 opacity-[0.015] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' /%3E%3C/svg%3E")`
        }}
      />

      <style jsx>{`
        @keyframes blob {
          0%,
          100% {
            transform: translate(0, 0) scale(1);
          }
          33% {
            transform: translate(30px, -50px) scale(1.1);
          }
          66% {
            transform: translate(-20px, 20px) scale(0.9);
          }
        }
        .animate-blob {
          animation: blob 7s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
        @keyframes shimmer {
          0% {
            background-position: -1000px 0;
          }
          100% {
            background-position: 1000px 0;
          }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite linear;
          background: linear-gradient(
            to right,
            transparent 0%,
            rgba(255, 255, 255, 0.1) 50%,
            transparent 100%
          );
          background-size: 1000px 100%;
        }
      `}</style>

      {/* Make content push footer down */}
      <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 flex-1">
        {/* Header */}
        <header className="mb-12 text-center">
          <h1 className="text-5xl font-bold tracking-tight bg-gradient-to-br from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent">
            TruthLens
          </h1>
          <p className="mt-4 text-lg text-zinc-400 max-w-2xl mx-auto">
            Paste a tweet, headline, or forward. Get a{" "}
            <span className="font-medium text-zinc-300">misinformation risk report</span> — not "true/false."
          </p>
          <p className="mt-2 text-sm text-zinc-500">Risk estimate only — verify before sharing</p>
        </header>

        {/* Input Section */}
        <section className="mx-auto max-w-3xl mb-8">
          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl p-6 shadow-2xl shadow-black/20 hover:border-zinc-700/50 transition-all duration-300">
            <label className="block text-sm font-medium text-zinc-300 mb-4">Content to scan</label>

            {/* === NEW: tabs UI === */}
            <div className="flex gap-1 mb-6 p-1.5 bg-zinc-950/60 rounded-xl border border-zinc-800/30 backdrop-blur-sm">
              <button
                onClick={() => setMode("text")}
                className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 ${
                  mode === "text"
                    ? "bg-gradient-to-br from-zinc-800 to-zinc-800/80 text-zinc-100 shadow-lg shadow-black/20"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40"
                }`}
              >
                Text
              </button>
              <button
                onClick={() => setMode("url")}
                className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 ${
                  mode === "url"
                    ? "bg-gradient-to-br from-zinc-800 to-zinc-800/80 text-zinc-100 shadow-lg shadow-black/20"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40"
                }`}
              >
                URL
              </button>
              <button
                onClick={() => setMode("image")}
                className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 ${
                  mode === "image"
                    ? "bg-gradient-to-br from-zinc-800 to-zinc-800/80 text-zinc-100 shadow-lg shadow-black/20"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40"
                }`}
              >
                Image
              </button>
            </div>

            {/* === NEW: conditional inputs === */}
            {mode === "text" && (
              <>
                {/* Quick examples */}
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => setText("URGENT!!! Govt giving $5,000 today only. Share to claim.")}
                    className="flex items-center gap-2 text-xs rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 hover:bg-red-500/10 hover:border-red-500/30 transition-all"
                  >
                    <span className="text-red-400">⚠</span>
                    <span className="text-zinc-300">Scam Example</span>
                  </button>
                  <button
                    onClick={() =>
                      setText("Doctors don't want you to know this 2-ingredient drink cures diabetes in 3 days.")
                    }
                    className="flex items-center gap-2 text-xs rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 hover:bg-yellow-500/10 hover:border-yellow-500/30 transition-all"
                  >
                    <span className="text-yellow-400">⚕</span>
                    <span className="text-zinc-300">Health Misinfo</span>
                  </button>
                  <button
                    onClick={() => setText("Library will be closed Monday for maintenance.")}
                    className="flex items-center gap-2 text-xs rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 hover:bg-emerald-500/10 hover:border-emerald-500/30 transition-all"
                  >
                    <span className="text-emerald-400">✓</span>
                    <span className="text-zinc-300">Normal Info</span>
                  </button>
                </div>

                <div className="relative">
                  <textarea
                    className="w-full resize-none rounded-xl border border-zinc-800/50 bg-zinc-950/60 p-4 text-sm leading-relaxed outline-none focus:border-zinc-600 focus:ring-2 focus:ring-zinc-600/20 transition-all placeholder:text-zinc-600"
                    rows={6}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder='Example: "URGENT!!! Govt giving $5,000 today only. Share to claim."'
                  />
                  {loading && (
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer pointer-events-none" />
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="relative w-10 h-10">
                      <svg className="w-10 h-10 transform -rotate-90">
                        <circle
                          cx="20"
                          cy="20"
                          r="16"
                          stroke="currentColor"
                          strokeWidth="2"
                          fill="none"
                          className="text-zinc-800"
                        />
                        <circle
                          cx="20"
                          cy="20"
                          r="16"
                          stroke="currentColor"
                          strokeWidth="2"
                          fill="none"
                          strokeDasharray={`${2 * Math.PI * 16}`}
                          strokeDashoffset={`${2 * Math.PI * 16 * (1 - charPercent / 100)}`}
                          className={`transition-all duration-300 ${
                            charPercent > 90 ? "text-red-400" : charPercent > 75 ? "text-yellow-400" : "text-zinc-500"
                          }`}
                          strokeLinecap="round"
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500 font-medium">
                        {Math.round(charPercent)}%
                      </span>
                    </div>
                    <span className="text-xs text-zinc-500">
                      {charCount} / {charLimit}
                    </span>
                  </div>

                  <button
                    onClick={handleScan}
                    disabled={loading}
                    className="relative rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-white/10 overflow-hidden"
                  >
                    {loading && (
                      <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                    )}
                    <span className="relative">{loading ? "Scanning..." : "Scan"}</span>
                  </button>
                </div>
              </>
            )}

            {mode === "url" && (
              <>
                <div className="relative mb-4">
                  <input
                    type="url"
                    className="w-full rounded-xl border border-zinc-800/50 bg-zinc-950/60 px-4 py-3.5 text-sm leading-relaxed outline-none focus:border-zinc-600 focus:ring-2 focus:ring-zinc-600/20 transition-all placeholder:text-zinc-600"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/article-to-verify"
                  />
                  {loading && (
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer pointer-events-none" />
                  )}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={handleScan}
                    disabled={loading}
                    className="relative rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-white/10 overflow-hidden"
                  >
                    {loading && (
                      <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                    )}
                    <span className="relative">{loading ? "Scanning..." : "Scan"}</span>
                  </button>
                </div>
              </>
            )}

            {mode === "image" && (
              <>
                {!imagePreview ? (
                  <label
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`flex flex-col items-center justify-center w-full h-56 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${
                      isDragging
                        ? "border-blue-500/50 bg-blue-500/10"
                        : "border-zinc-800/50 hover:border-zinc-700/50 bg-zinc-950/40"
                    }`}
                  >
                    <div className="flex flex-col items-center justify-center py-6">
                      <div
                        className={`w-16 h-16 mb-4 rounded-full flex items-center justify-center transition-colors ${
                          isDragging ? "bg-blue-500/20" : "bg-zinc-800/50 group-hover:bg-zinc-800/70"
                        }`}
                      >
                        <svg
                          className={`w-8 h-8 transition-colors ${
                            isDragging ? "text-blue-400" : "text-zinc-500 group-hover:text-zinc-400"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                          />
                        </svg>
                      </div>
                      <p className={`mb-2 text-sm transition-colors ${isDragging ? "text-blue-300" : "text-zinc-400"}`}>
                        <span className="font-semibold">{isDragging ? "Drop image here" : "Click to upload"}</span>
                        {!isDragging && " or drag and drop"}
                      </p>
                      <p className="text-xs text-zinc-600">PNG, JPG, or GIF (up to 10MB)</p>
                    </div>
                    <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                  </label>
                ) : (
                  <div className="space-y-4">
                    <div className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imagePreview}
                        alt="Upload preview"
                        className="w-full max-h-80 object-contain rounded-xl border border-zinc-800/50 bg-zinc-950/60"
                      />
                      <button
                        aria-label="Remove image"
                        title="Remove image"
                        onClick={() => {
                          setImageFile(null);
                          setImagePreview(null);
                        }}
                        className="absolute top-3 right-3 p-2 rounded-lg bg-zinc-900/90 backdrop-blur-sm border border-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/90 transition-all opacity-0 group-hover:opacity-100"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-zinc-500 truncate">{imageFile?.name}</span>
                      <button
                        onClick={handleScan}
                        disabled={loading}
                        className="relative rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-white/10 overflow-hidden"
                      >
                        {loading && (
                          <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                        )}
                        <span className="relative">{loading ? "Scanning..." : "Scan"}</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {error && (
              <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}
          </div>

          {!report && !loading && (
            <div className="mt-8 text-center">
              <div className="inline-flex items-center gap-2 text-sm text-zinc-600">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 animate-pulse" />
                <span>
                  {mode === "text" && "Paste text above to analyze misinformation risk"}
                  {mode === "url" && "Enter a URL to analyze its content for misinformation"}
                  {mode === "image" && "Upload an image to analyze for misinformation"}
                </span>
              </div>
            </div>
          )}
        </section>

        {/* Results */}
        {report && (
          <section className="mx-auto max-w-7xl">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Left */}
              <div className="space-y-6">
                <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl p-8 shadow-2xl shadow-black/20">
                  <div className="flex items-start justify-between mb-6">
                    <div className="flex-1">
                      <p className="text-xs uppercase tracking-wider text-zinc-500 font-medium mb-2">Risk Score</p>
                      <div className="flex items-baseline gap-3">
                        <p className="text-6xl font-bold tracking-tight">{report.risk_score}</p>
                        <span className="text-zinc-600 text-sm">/100</span>
                      </div>
                      <p className="mt-2 text-xs text-zinc-500">{getRiskContext(report.risk_score)}</p>
                    </div>
                    <span
                      className={`rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide ${badgeClass(
                        report.risk_level
                      )}`}
                    >
                      {report.risk_level}
                    </span>
                  </div>

                  <div className="text-center">
                    <p className="text-sm text-zinc-400">{getRiskMessage(report.risk_level)}</p>
                    <p className="mt-1 text-xs text-zinc-600">Verify before sharing</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl p-6 shadow-2xl shadow-black/20">
                  <p className="text-xs uppercase tracking-wider text-zinc-500 font-medium mb-3">Summary</p>
                  <p className="text-sm text-zinc-300 leading-relaxed">{report.one_line_summary}</p>
                </div>

                <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl p-6 shadow-2xl shadow-black/20">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs uppercase tracking-wider text-zinc-500 font-medium">Red Flags</p>
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-red-500/10 border border-red-500/30 text-xs font-bold text-red-400">
                      {report.red_flags.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {report.red_flags.map((flag, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-800/30 px-3 py-2 text-xs font-medium text-zinc-300 hover:border-zinc-600/50 transition-colors"
                      >
                        <span className="text-red-400 text-sm">▲</span>
                        {flag}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right */}
              <div className="space-y-6">
                <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl p-6 shadow-2xl shadow-black/20">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs uppercase tracking-wider text-zinc-500 font-medium">Verification Checklist</p>
                    <span className="text-xs text-zinc-600">
                      {checkedSteps.filter(Boolean).length}/{report?.verification_steps?.length || 0} done

                    </span>
                  </div>
                  <ul className="space-y-3">
                    {report.verification_steps.map((step, idx) => (
                      <li key={idx} className="flex items-start gap-3 group">
                        <button
                          onClick={() => toggleStep(idx)}
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all ${
                            checkedSteps[idx]
                              ? "border-emerald-500/50 bg-emerald-500/20"
                              : "border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600"
                          }`}
                        >
                          {checkedSteps[idx] && <span className="text-emerald-400 text-xs">✓</span>}
                        </button>
                        <span
                          className={`text-sm leading-relaxed transition-all ${
                            checkedSteps[idx] ? "text-zinc-500 line-through" : "text-zinc-300"
                          }`}
                        >
                          {step}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl p-6 shadow-2xl shadow-black/20">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-xs uppercase tracking-wider text-zinc-500 font-medium">Share-Safe Rewrite</p>
                    <button
                      onClick={() => copy(report.neutral_rewrite)}
                      className={`rounded-lg border px-4 py-1.5 text-xs font-medium active:scale-95 transition-all ${
                        copied
                          ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                          : "border-zinc-700/50 bg-zinc-800/30 hover:bg-zinc-800/60 hover:border-zinc-600"
                      }`}
                    >
                      {copied ? "✓ Copied!" : "Copy"}
                    </button>
                  </div>
                  <div className="rounded-lg border border-zinc-800/30 bg-zinc-950/40 p-4">
                    <p className="text-sm text-zinc-300 leading-relaxed">{report.neutral_rewrite}</p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Footer pinned to bottom */}
      <footer className="py-6 text-center text-sm text-zinc-600">
        Built for Siren&apos;s Call — Misinformation &amp; Deceptive AI Track
      </footer>
    </main>
  );
}