import fsp from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import type { CaptureJob } from './types.ts';

export interface AiFileEdit {
  filePath: string;
  summary: string;
  updatedContent: string;
}

export interface AiAssistantResult {
  explanation: string;
  edits: AiFileEdit[];
}

export class AiServiceError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AiServiceError';
    this.statusCode = statusCode;
  }
}

const EDITABLE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.md',
  '.txt',
  '.svg',
]);
const MAX_SINGLE_FILE_CHARS = 32_000;
const MAX_TOTAL_CONTEXT_CHARS = 75_000;

let sharedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new AiServiceError(
      503,
      'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
    );
  }
  if (!sharedClient) {
    sharedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return sharedClient;
}

export function isEditableTextFile(relPath: string): boolean {
  const base = path.posix.basename(relPath).toLowerCase();
  if (base === '.gitignore') return true;
  const ext = path.posix.extname(relPath).toLowerCase();
  return EDITABLE_EXTENSIONS.has(ext);
}

export function resolveSafeSiteFile(siteDir: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('\0')) {
    throw new AiServiceError(400, 'Invalid file path.');
  }
  const baseDir = path.resolve(siteDir);
  const resolved = path.resolve(baseDir, clean);
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw new AiServiceError(403, 'Access outside the captured project folder is forbidden.');
  }
  return resolved;
}

async function gatherProjectContext(
  job: CaptureJob,
  selectedFile?: string,
): Promise<{ fileListText: string; filesContextText: string }> {
  const fileListText = job.files
    .map((f) => `- ${f.path} (${f.size} bytes)`)
    .slice(0, 120)
    .join('\n');

  const prioritized: string[] = [];
  if (selectedFile && isEditableTextFile(selectedFile)) {
    prioritized.push(selectedFile);
  }
  if (!prioritized.includes('index.html')) {
    prioritized.push('index.html');
  }
  for (const f of job.files) {
    if (prioritized.length >= 6) break;
    if (
      !prioritized.includes(f.path) &&
      (f.path.endsWith('.css') ||
        f.path.endsWith('.html') ||
        f.path.endsWith('.js') ||
        f.path.endsWith('.tsx') ||
        f.path.endsWith('.jsx') ||
        f.path.endsWith('.ts')) &&
      !f.path.startsWith('recovered-src/')
    ) {
      prioritized.push(f.path);
    }
  }

  let totalChars = 0;
  const sections: string[] = [];

  for (const relPath of prioritized) {
    if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
    try {
      const fullPath = resolveSafeSiteFile(job.siteDir, relPath);
      const raw = await fsp.readFile(fullPath, 'utf8');
      const snippet =
        raw.length > MAX_SINGLE_FILE_CHARS
          ? `${raw.slice(0, MAX_SINGLE_FILE_CHARS)}\n/* ...truncated (${raw.length} total chars)... */`
          : raw;
      sections.push(`=== FILE: ${relPath} ===\n${snippet}`);
      totalChars += snippet.length;
    } catch {
      // Skip missing or unreadable files
    }
  }

  return {
    fileListText,
    filesContextText: sections.join('\n\n'),
  };
}

export async function runAiCodeAssistant(options: {
  job: CaptureJob;
  prompt: string;
  mode: 'explain' | 'modify';
  selectedFile?: string;
  history?: Array<{ role: 'user' | 'model'; text: string }>;
}): Promise<AiAssistantResult> {
  const { job, prompt, mode, selectedFile, history = [] } = options;
  const ai = getGeminiClient();
  const { fileListText, filesContextText } = await gatherProjectContext(job, selectedFile);

  const historyLines = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n');

  const systemInstruction = [
    'You are the SiteGrab AI Code Assistant helping a developer inspect, explain, style, make responsive, or fix frontend errors in a captured static website.',
    'Rules:',
    '1. Base every explanation and edit ONLY on the actual captured project files provided in the prompt. Never invent unrelated sample sites or fake files.',
    '2. Static snapshots do NOT include server-side backends, authentication, or live databases. If the user asks about backend/database behavior, clearly explain that static capture only includes client-side HTML, CSS, and JS.',
    '3. Keep relative local asset paths (./assets/...) intact whenever editing HTML or CSS.',
    '4. When mode is "explain", return an empty "edits" array and put a clear, structured technical explanation in "explanation".',
    '5. When mode is "modify", provide complete, valid, working file contents in "updatedContent" for each modified file (only include files that actually change, using their exact relative paths from the project tree). Keep changes focused and preserve existing functionality.',
  ].join('\n');

  const userPrompt = [
    `Captured Target URL: ${job.url}`,
    `Mode: ${mode.toUpperCase()}`,
    selectedFile ? `Focused File: ${selectedFile}` : '',
    '',
    'Captured Project Files:',
    fileListText,
    '',
    'File Contents:',
    filesContextText,
    historyLines ? `\nRecent Conversation:\n${historyLines}` : '',
    `\nUser Request:\n${prompt}`,
  ]
    .filter(Boolean)
    .join('\n');

  const callGenerate = async (modelName: string) =>
    ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            explanation: {
              type: Type.STRING,
              description: 'Clear explanation of the code or summary of modifications made.',
            },
            edits: {
              type: Type.ARRAY,
              description: 'List of modified files with their complete updated contents.',
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: {
                    type: Type.STRING,
                    description:
                      'Exact relative path inside the captured project (e.g., index.html or assets/css/main.css).',
                  },
                  summary: {
                    type: Type.STRING,
                    description: 'Brief 1-sentence description of what changed in this file.',
                  },
                  updatedContent: {
                    type: Type.STRING,
                    description: 'Complete updated file contents.',
                  },
                },
                required: ['filePath', 'summary', 'updatedContent'],
              },
            },
          },
          required: ['explanation', 'edits'],
        },
      },
    });

  try {
    let response;
    try {
      response = await callGenerate('gemini-4-hydrogen');
    } catch (primaryErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : '';
      if (primaryMsg.includes('503') || primaryMsg.includes('UNAVAILABLE')) {
        await new Promise((r) => setTimeout(r, 500));
        response = await callGenerate('gemini-3.1-flash-lite');
      } else {
        throw primaryErr;
      }
    }

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      throw new AiServiceError(502, 'AI assistant returned an empty response.');
    }

    const parsed = JSON.parse(rawText) as Partial<AiAssistantResult>;
    const validEdits: AiFileEdit[] = [];

    if (mode === 'modify' && Array.isArray(parsed.edits)) {
      for (const edit of parsed.edits) {
        if (
          !edit ||
          typeof edit.filePath !== 'string' ||
          typeof edit.updatedContent !== 'string'
        ) {
          continue;
        }
        const cleanRel = edit.filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!isEditableTextFile(cleanRel)) continue;
        // Validate path stays inside siteDir
        resolveSafeSiteFile(job.siteDir, cleanRel);
        validEdits.push({
          filePath: cleanRel,
          summary: typeof edit.summary === 'string' ? edit.summary : `Updated ${cleanRel}`,
          updatedContent: edit.updatedContent,
        });
      }
    }

    return {
      explanation:
        typeof parsed.explanation === 'string' && parsed.explanation.trim()
          ? parsed.explanation.trim()
          : 'Completed inspection.',
      edits: validEdits,
    };
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    const msg = err instanceof Error ? err.message : 'AI request failed.';
    if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('API_KEY_INVALID')) {
      throw new AiServiceError(
        403,
        'Gemini API key was rejected or missing. Please verify GEMINI_API_KEY in Settings > Secrets.',
      );
    }
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      throw new AiServiceError(
        429,
        'AI rate limit or quota reached. Please wait a moment and try again.',
      );
    }
    if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
      throw new AiServiceError(
        503,
        'AI assistant is temporarily busy due to high demand. Please try again in a few moments.',
      );
    }
    throw new AiServiceError(502, 'AI assistant could not process this request. Please try again.');
  }
}
