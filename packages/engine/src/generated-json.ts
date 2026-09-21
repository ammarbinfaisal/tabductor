/** Model output may include a code fence or trailing commas. Normalize only those
 * formatting mistakes; incomplete or otherwise invalid JSON still needs model repair.
 * Keep this separate from parsers for user input and workflow execution results. */
export function parseGeneratedJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(source);
  } catch (error) {
    let normalized = "";
    let inString = false;
    let escaped = false;
    let previousToken = "";
    for (let i = 0; i < source.length; i++) {
      const char = source[i]!;
      if (inString) {
        normalized += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === "," && previousToken !== "{" && previousToken !== "[" && previousToken !== ",") {
        let next = i + 1;
        while (next < source.length && /[\t\n\r ]/.test(source[next]!)) next++;
        if (source[next] === "}" || source[next] === "]") continue;
      }
      normalized += char;
      if (char === '"') inString = true;
      if (!/[\t\n\r ]/.test(char)) previousToken = char;
    }
    // Retain the original position in diagnostics if normalization cannot fix it.
    try { return JSON.parse(normalized); } catch { throw error; }
  }
}
