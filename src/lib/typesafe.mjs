import { env } from 'node:process';
import { execSync } from 'node:child_process';

import { randomUUID } from 'node:crypto';

export const PINNED_PRODUCTION_MODEL = "jev-1.13.0";
const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = PINNED_PRODUCTION_MODEL;

/**
 * Standard allowlist fields for structured state to prevent accidental secret leakage.
 */
export const DEFAULT_STATE_ALLOWLIST = [
  'title',
  'description',
  'repo',
  'issue',
  'ticket',
  'node',
  'outcome',
  'commit',
  'branch',
  'verified',
  'not_verified',
  'capture',
  'changed_paths',
  'labels',
  'contract_surfaces',
  'target_contracts',
  'diff',
  'diff_or_description',
  'context',
  'patch',
  'telemetry',
  'event_type',
  'agent_id',
  'worktree',
  'task',
  'evidence',
  'status',
  'summary',
  'notes'
];

const SUSPICIOUS_KEY_REGEX = /key|token|secret|password|bearer|auth|credential|privkey/i;

/**
 * Redacts known secret patterns from string content (API keys, JWTs, cloud credentials, tokens).
 */
export function scrubString(str) {
  if (typeof str !== 'string') return str;
  return str
    // Standard credential assignments (api_key=, access_token=, password=, etc.)
    .replace(/(?:api[_-]?key|access[_-]?token|secret|password|token|apiKey|privkey|bearer)\s*[:=]\s*[^\s,;]+/gi, (m) => {
      const parts = m.split(/[:=]/);
      return `${parts[0]}=[REDACTED]`;
    })
    // High-entropy token prefixes: sk-..., GitHub tokens, AWS keys, JWTs
    .replace(/(?:sk-[a-zA-Z0-9_\-]{10,})/g, '[REDACTED_API_KEY]')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\beyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/(?:bearer\s+[a-zA-Z0-9_\-\.]+)/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Recursively scrubs values, dropping suspicious keys and redacting strings.
 */
export function sanitizeValue(val) {
  if (val == null) return val;
  if (typeof val === 'string') {
    return scrubString(val);
  }
  if (Array.isArray(val)) {
    return val.map(item => sanitizeValue(item));
  }
  if (typeof val === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(val)) {
      if (SUSPICIOUS_KEY_REGEX.test(k)) {
        continue;
      }
      clean[k] = sanitizeValue(v);
    }
    return clean;
  }
  return val;
}

/**
 * Projects raw state into an allowlisted, sanitized object or string.
 * Discards unallowlisted keys, recursively strips nested secrets, and bounds length.
 * 
 * @param {string|object} rawState - Raw input context
 * @param {object} [options]
 * @param {string[]} [options.allowlist] - Allowed keys for object state
 * @param {number} [options.maxStateLength] - Max character length (default: 32000)
 * @returns {string} Sanitized state string ready for Jev API
 */
export function projectState(rawState, options = {}) {
  const maxLen = options.maxStateLength ?? 32000;
  const allowlist = options.allowlist || DEFAULT_STATE_ALLOWLIST;

  if (rawState == null) {
    return "";
  }

  let sanitizedObj;
  if (typeof rawState === 'string') {
    sanitizedObj = scrubString(rawState);
  } else if (Array.isArray(rawState)) {
    sanitizedObj = rawState.map(item => sanitizeValue(item));
  } else if (typeof rawState === 'object') {
    sanitizedObj = {};
    for (const key of allowlist) {
      if (Object.prototype.hasOwnProperty.call(rawState, key)) {
        if (!SUSPICIOUS_KEY_REGEX.test(key)) {
          sanitizedObj[key] = sanitizeValue(rawState[key]);
        }
      }
    }
  } else {
    sanitizedObj = rawState;
  }

  let stateStr = typeof sanitizedObj === 'string' ? sanitizedObj : JSON.stringify(sanitizedObj, null, 2);
  if (stateStr.length > maxLen) {
    stateStr = stateStr.slice(0, maxLen) + "\n... [truncated for Jev System One payload limit]";
  }
  return stateStr;
}

/**
 * Formats a sanitized DecisionTrace record for telemetry and audit.
 */
export function createDecisionTrace({
  decisionId = randomUUID(),
  decisionType = 'generic',
  model = DEFAULT_MODEL,
  latencyMs = 0,
  status = 'ok',
  answers = null,
  usage = null,
  error = null
} = {}) {
  return {
    schema_version: 1,
    decision_id: decisionId,
    decision_type: decisionType,
    timestamp: new Date().toISOString(),
    model,
    latency_ms: latencyMs,
    status,
    answers,
    usage: usage || { input_tokens: 0, output_tokens: 0 },
    error: error ? String(error) : null
  };
}

/**
 * Retrieves the TypeSafe API key from process environment or Windows User environment.
 */
export function getApiKey() {
  if (env.TYPESAFE_API_KEY) {
    return env.TYPESAFE_API_KEY;
  }
  if (process.platform === 'win32') {
    try {
      const val = execSync(
        'powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'TYPESAFE_API_KEY\', \'User\')"',
        { encoding: 'utf8' }
      ).trim();
      if (val) {
        env.TYPESAFE_API_KEY = val;
        return val;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Primitive builder: Choice Question
 */
export function choice(instructions, criteria) {
  return {
    type: "choice",
    instructions,
    criteria
  };
}

/**
 * Primitive builder: Score Question
 */
export function score(instructions, criteria) {
  return {
    type: "score",
    instructions,
    criteria
  };
}

/**
 * Primitive builder: Noul (Boolean probability) Question
 */
export function noul(instructions) {
  return {
    type: "noul",
    instructions
  };
}

/**
 * Executes a System One evaluation call against the TypeSafe API.
 * 
 * @param {string|object} state - Application state or context string
 * @param {object} questions - Dictionary of typed questions
 * @param {object} [options]
 * @param {string} [options.model] - Model name (default: jev-1.13.0)
 * @param {string} [options.apiUrl] - API URL
 * @param {string} [options.apiKey] - Explicit API key
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds (default: 5000)
 * @param {number} [options.maxStateLength] - Max characters for state string (default: 32000)
 * @param {string[]} [options.allowlist] - Allowed keys for structured state projection
 * @returns {Promise<{ answers: object, model: string, usage: object, latencyMs: number }>}
 */
export async function queryJev(state, questions, options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : getApiKey();
  if (!apiKey) {
    throw new Error("Missing TYPESAFE_API_KEY environment variable.");
  }

  const apiUrl = options.apiUrl || DEFAULT_API_URL;
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxStateLength = options.maxStateLength ?? 32000;

  const stateStr = projectState(state, {
    maxStateLength,
    allowlist: options.allowlist
  });

  const payload = {
    state: stateStr,
    model,
    questions
  };

  const startTime = performance.now();

  let response;
  let lastError;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        break;
      }

      const status = response.status;
      const text = await response.text();
      if ((status === 429 || status >= 500) && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new Error(`TypeSafe API error HTTP ${status}: ${text}`);
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        throw new Error(`TypeSafe API request timed out after ${timeoutMs}ms.`);
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }

  if (!response || !response.ok) {
    throw lastError || new Error("Failed to reach TypeSafe API after retries.");
  }

  const latencyMs = Math.round(performance.now() - startTime);
  const data = await response.json();

  return {
    answers: data.answers,
    model: data.model,
    usage: data.usage || { input_tokens: 0, output_tokens: 0 },
    latencyMs
  };
}
