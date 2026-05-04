export interface GrepOptions {
  pattern: string;
  regex?: boolean;
  before?: number;
  after?: number;
  maxMatches?: number;
}

export interface GrepMatch {
  lineNumber: number;
  text: string;
  context: Array<{ lineNumber: number; text: string }>;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

function buildMatcher(pattern: string, regex: boolean): (s: string) => boolean {
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex: ${msg}`);
    }
    return (s) => re.test(s);
  }
  const lower = pattern.toLowerCase();
  return (s) => s.toLowerCase().includes(lower);
}

export function grepLog(text: string, opts: GrepOptions): GrepResult {
  const before = opts.before ?? 0;
  const after = opts.after ?? 0;
  const maxMatches = opts.maxMatches ?? 50;
  const matches: GrepMatch[] = [];
  const lines = text.split("\n");
  const matcher = buildMatcher(opts.pattern, opts.regex ?? false);

  for (let i = 0; i < lines.length; i++) {
    if (!matcher(lines[i])) continue;

    const ctxStart = Math.max(0, i - before);
    const ctxEnd = Math.min(lines.length - 1, i + after);
    const context: Array<{ lineNumber: number; text: string }> = [];
    for (let j = ctxStart; j <= ctxEnd; j++) {
      context.push({ lineNumber: j + 1, text: lines[j] });
    }
    matches.push({ lineNumber: i + 1, text: lines[i], context });

    if (matches.length >= maxMatches) {
      // Check if there are any further matches; if so, signal truncation.
      for (let k = i + 1; k < lines.length; k++) {
        if (matcher(lines[k])) return { matches, truncated: true };
      }
      return { matches, truncated: false };
    }
  }

  return { matches, truncated: false };
}
