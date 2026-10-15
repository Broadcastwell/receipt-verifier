// The plain() rule the Absence Index uses to cut an excerpt from an answer: markdown links keep their
// text, emphasis, code, heading, quote and table marks become spaces, and all spacing collapses to one
// space. A receipt excerpt (without its leading "... " and trailing " ...") is a substring of plain()
// of the full answer text. This copies the rule exactly; do not change it without the Index changing it.

export function plain(text) {
  return String(text)
    .replace(/\(\[([^\]]+)\]\(([^)]+)\)\)/g, '($1)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEAD = '... ';
const TRAIL = ' ...';

// The excerpt as cut from the plain text: without the marks that say it was cut.
export function excerptCore(excerpt) {
  let core = String(excerpt);
  if (core.startsWith(LEAD)) core = core.slice(LEAD.length);
  if (core.endsWith(TRAIL)) core = core.slice(0, core.length - TRAIL.length);
  return core;
}
