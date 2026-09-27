export function readableName(value: string, label?: string): string {
  if (label) return label;
  const words = value.replace(/[._-]+/g, " ").replace(/\bdb\b/gi, "database").replace(/\bx\b/g, "X").replace(/\bnotion\b/gi, "Notion").replace(/\bauth\b/gi, "sign-in").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Workflow";
}