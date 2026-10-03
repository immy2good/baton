import { readFileSync, statSync, existsSync } from 'node:fs';

/**
 * Base Harness Adapter.
 *
 * Implements Paperclip-style modular adapter design for parsing agent runtime output
 * streams and logs into structured events without third-party dependencies.
 */
export class BaseHarnessAdapter {
  constructor(harnessName, options = {}) {
    this.name = harnessName;
    this.options = options;
    this.buffer = '';
    this.currentTurn = 0;
    this.byteOffset = 0;
  }

  /**
   * Parses an incoming chunk of stdout/log text into structured events.
   * Concrete adapters override `parseLine` or `parseChunk`.
   *
   * @param {string} chunk - Raw text data
   * @returns {Array<object>} Array of parsed events
   */
  parseChunk(chunk) {
    if (!chunk) return [];
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    // Keep incomplete trailing line in buffer
    this.buffer = lines.pop() || '';

    const events = [];
    for (const line of lines) {
      const parsed = this.parseLine(line);
      if (Array.isArray(parsed)) {
        events.push(...parsed);
      } else if (parsed) {
        events.push(parsed);
      }
    }
    return events;
  }

  /**
   * Parses a single line of log text.
   *
   * @param {string} line
   * @returns {object|Array<object>|null}
   */
  parseLine(line) {
    // Default implementation: passthrough or simple error check
    if (/error|fatal|panic/i.test(line)) {
      return {
        type: 'error',
        harness: this.name,
        message: line.trim(),
        timestamp: Date.now()
      };
    }
    return null;
  }

  /**
   * Tails new content from a file path on disk starting from `byteOffset`.
   * Non-invasive read that does not lock the file or interfere with the launcher.
   *
   * @param {string} filePath - Absolute path to log file
   * @returns {Array<object>} Parsed events from newly appended bytes
   */
  tailLog(filePath) {
    if (!existsSync(filePath)) return [];
    try {
      const stat = statSync(filePath);
      if (stat.size <= this.byteOffset) {
        // File shrank or hasn't grown
        if (stat.size < this.byteOffset) {
          this.byteOffset = 0; // Rotated or truncated
        } else {
          return [];
        }
      }

      const length = stat.size - this.byteOffset;
      const buffer = Buffer.alloc(length);
      const fd = readFileSync(filePath); // Safe for small-to-medium log slices
      const newSlice = fd.subarray(this.byteOffset, stat.size).toString('utf8');
      this.byteOffset = stat.size;

      return this.parseChunk(newSlice);
    } catch {
      return [];
    }
  }

  /**
   * Current cumulative turn count.
   */
  get turn() {
    return this.currentTurn;
  }

  reset() {
    this.buffer = '';
    this.currentTurn = 0;
    this.byteOffset = 0;
  }
}
