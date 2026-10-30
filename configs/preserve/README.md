# Preserved Patterns Configuration

This directory contains JSON files specifying regular expression patterns that the distillation engine will protect.

## The Contract
Files must follow the `{ "patterns": string[] }` schema:
```json
{
  "patterns": [
    "^\\s*\\|.*\\|\\s*$",
    "<!--\\s*slm-gate:verbatim-start\\s*-->"
  ]
}
```

## Extend vs Replace
Controlled by `DISTILL_PRESERVE_MODE` in your `.env`:
- `extend`: Your patterns are appended to the built-in defaults.
- `replace`: Only your patterns (plus any adapter patterns like TLS) are used.

## RE2 Safety
Patterns are executed in Node.js using V8's regex engine. Avoid pathological backtracking by keeping patterns simple and bounded.

## The Line-Based Caveat
The regex preservation engine operates **line-by-line**. It cannot inherently protect multi-line blocks (like a fenced code block) unless every internal line independently matches a pattern.
Fenced code blocks, tables, headings and frontmatter are protected as whole blocks by the built-in rules in `src/utils/elision.ts` before any pattern is tried; these patterns are the extra, line-based floor on top of them. With `DISTILL_ADAPTIVE=on`, lines whose meaning matches a past expansion are protected too.
