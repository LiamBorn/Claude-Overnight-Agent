/**
 * planparse.mjs — parse OVERNIGHT_PLAN.md into machine-readable tasks.
 *
 * The plan file is plain Markdown so a human can read it and another agent could
 * consume it. Machine fields live in fenced ```yaml blocks written in a deliberately
 * restricted subset of YAML:
 *
 *   key: scalar                 # string, number, true/false, null
 *   key: []                     # empty inline list (the only inline collection)
 *   key:                        # block list of scalars
 *     - item
 *   key:                        # block list of maps, one nesting level only
 *     - subkey: value
 *       subkey2: value
 *
 * Anything outside that subset is a hard error. Guessing at a malformed plan at 3am
 * is worse than refusing to start, so this parser never falls back to a best effort.
 *
 * No dependencies. Node >= 18.
 */

const SCALAR_TRUE = new Set(['true', 'yes', 'on']);
const SCALAR_FALSE = new Set(['false', 'no', 'off']);

export class PlanError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line ?? null;
  }
}

/** Strip a trailing `# comment`, respecting quotes. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === '') return '';
  if (text === '[]') return [];
  if (text === '{}') throw new PlanError('inline maps are not supported', lineNo);
  if (text.startsWith('[')) {
    // Allow a simple inline list of scalars: [a, b, c]
    if (!text.endsWith(']')) throw new PlanError(`unterminated inline list: ${text}`, lineNo);
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => parseScalar(part, lineNo));
  }
  if (text.startsWith('{')) throw new PlanError('inline maps are not supported', lineNo);
  if ((text.startsWith('"') && text.endsWith('"') && text.length > 1) ||
      (text.startsWith("'") && text.endsWith("'") && text.length > 1)) {
    const body = text.slice(1, -1);
    return text[0] === '"' ? body.replace(/\\(.)/g, '$1') : body.replace(/''/g, "'");
  }
  if (text === 'null' || text === '~') return null;
  const lower = text.toLowerCase();
  if (SCALAR_TRUE.has(lower)) return true;
  if (SCALAR_FALSE.has(lower)) return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

function splitKey(text, lineNo) {
  // Find the first `:` that is not inside quotes.
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':' && (i + 1 === text.length || /[\s]/.test(text[i + 1]))) {
      return [text.slice(0, i).trim(), text.slice(i + 1)];
    }
  }
  throw new PlanError(`expected "key: value" but got: ${text.trim()}`, lineNo);
}

/**
 * Parse the restricted YAML subset. `startLine` is the 1-based line number of the
 * first line of `source` within the original document, for useful error messages.
 */
export function parseRestrictedYaml(source, startLine = 1) {
  const rows = [];
  source.split('\n').forEach((rawLine, index) => {
    const lineNo = startLine + index;
    if (rawLine.includes('\t')) {
      throw new PlanError('tabs are not allowed for indentation; use spaces', lineNo);
    }
    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim() === '') return;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    rows.push({ indent, text: withoutComment.trim(), lineNo });
  });

  const result = {};
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];
    if (row.indent !== 0) {
      throw new PlanError(`unexpected indentation; top-level keys must start at column 0`, row.lineNo);
    }
    if (row.text.startsWith('- ')) {
      throw new PlanError('the top level of a plan block must be a mapping, not a list', row.lineNo);
    }
    const [key, rest] = splitKey(row.text, row.lineNo);
    if (key === '') throw new PlanError('empty key', row.lineNo);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new PlanError(`duplicate key "${key}"`, row.lineNo);
    }

    if (rest.trim() !== '') {
      result[key] = parseScalar(rest, row.lineNo);
      i++;
      continue;
    }

    // Block value: collect every following row indented further.
    const child = [];
    i++;
    while (i < rows.length && rows[i].indent > 0) {
      child.push(rows[i]);
      i++;
    }
    if (child.length === 0) {
      result[key] = null;
      continue;
    }
    if (!child[0].text.startsWith('- ')) {
      throw new PlanError(
        `"${key}" must be followed by a list of "- " items; nested mappings are not supported`,
        child[0].lineNo,
      );
    }
    result[key] = parseBlockList(key, child);
  }

  return result;
}

function parseBlockList(key, rows) {
  const items = [];
  const bulletIndent = rows[0].indent;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent !== bulletIndent || !row.text.startsWith('- ')) {
      throw new PlanError(`malformed list item under "${key}"`, row.lineNo);
    }
    const head = row.text.slice(2).trim();
    // Gather continuation rows belonging to this item.
    const continuation = [];
    i++;
    while (i < rows.length && rows[i].indent > bulletIndent) {
      continuation.push(rows[i]);
      i++;
    }

    let isMapping = false;
    try {
      splitKey(head, row.lineNo);
      isMapping = true;
    } catch {
      isMapping = false;
    }

    if (!isMapping) {
      if (continuation.length > 0) {
        throw new PlanError(
          `list item under "${key}" is a plain value but has indented lines under it`,
          continuation[0].lineNo,
        );
      }
      items.push(parseScalar(head, row.lineNo));
      continue;
    }

    const entry = {};
    const addPair = (text, lineNo) => {
      const [k, rest] = splitKey(text, lineNo);
      if (Object.prototype.hasOwnProperty.call(entry, k)) {
        throw new PlanError(`duplicate key "${k}" in list item under "${key}"`, lineNo);
      }
      if (rest.trim() === '') {
        throw new PlanError(
          `"${k}" has no value; nesting deeper than one level is not supported`,
          lineNo,
        );
      }
      entry[k] = parseScalar(rest, lineNo);
    };
    addPair(head, row.lineNo);
    for (const cont of continuation) {
      if (cont.text.startsWith('- ')) {
        throw new PlanError(`nested lists are not supported under "${key}"`, cont.lineNo);
      }
      addPair(cont.text, cont.lineNo);
    }
    items.push(entry);
  }
  return items;
}

/** Split a Markdown document into `##` sections, ignoring headings inside code fences. */
function splitSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let preamble = [];
  let current = null;
  let fence = null;

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (fence === null) fence = marker;
      else if (fenceMatch[1].startsWith(fence)) fence = null;
    }
    if (fence === null && /^##\s+/.test(line)) {
      current = { heading: line.replace(/^##\s+/, '').trim(), lineNo, lines: [] };
      sections.push(current);
      return;
    }
    if (current) current.lines.push({ text: line, lineNo });
    else preamble.push({ text: line, lineNo });
  });

  return { preamble, sections };
}

/** Pull the first fenced ```yaml block out of a section's lines. */
function extractYamlBlock(sectionLines) {
  let start = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    if (/^\s*```\s*(yaml|yml)\s*$/i.test(sectionLines[i].text)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < sectionLines.length; i++) {
    if (/^\s*```\s*$/.test(sectionLines[i].text)) {
      return { source: body.join('\n'), startLine: sectionLines[start].lineNo + 1 };
    }
    body.push(sectionLines[i].text);
  }
  throw new PlanError('unterminated ```yaml block', sectionLines[start].lineNo);
}

/** Pull the prose under a `### Heading` inside a section. */
function extractProse(sectionLines, headingPattern) {
  let capturing = false;
  const out = [];
  let fence = null;
  for (const { text } of sectionLines) {
    const fenceMatch = text.match(/^\s*(`{3,})/);
    if (fenceMatch) fence = fence === null ? '```' : null;
    if (fence === null && /^###\s+/.test(text)) {
      capturing = headingPattern.test(text.replace(/^###\s+/, '').trim());
      continue;
    }
    if (capturing) out.push(text);
  }
  return out.join('\n').trim();
}

const TASK_HEADING = /^task\s*:\s*(.+)$/i;

/**
 * Parse a plan document.
 * Returns { title, settings, tasks, warnings }. Throws PlanError on anything malformed.
 */
export function parsePlan(markdown) {
  const { preamble, sections } = splitSections(markdown);
  const titleLine = preamble.find((l) => /^#\s+/.test(l.text));
  const title = titleLine ? titleLine.text.replace(/^#\s+/, '').trim() : 'Overnight plan';

  let settings = {};
  const tasks = [];
  const warnings = [];

  for (const section of sections) {
    const headingText = section.heading;

    if (/^settings$/i.test(headingText)) {
      const block = extractYamlBlock(section.lines);
      if (!block) throw new PlanError('the Settings section has no ```yaml block', section.lineNo);
      settings = parseRestrictedYaml(block.source, block.startLine);
      continue;
    }

    const taskMatch = headingText.match(TASK_HEADING);
    if (!taskMatch) continue; // Free-form prose sections are allowed and ignored.

    const block = extractYamlBlock(section.lines);
    if (!block) {
      throw new PlanError(
        `task "${headingText}" has no \`\`\`yaml block, so it has no id or acceptance criteria`,
        section.lineNo,
      );
    }
    const fields = parseRestrictedYaml(block.source, block.startLine);

    // The heading is "Task: <id> — <title>"; both halves are optional sugar because the
    // yaml block is authoritative, but we use the heading to fill in a missing title.
    const headingRest = taskMatch[1].trim();
    const dashSplit = headingRest.split(/\s+[—–-]\s+/);
    const headingId = dashSplit.length > 1 ? dashSplit[0].trim() : null;
    const headingTitle = dashSplit.length > 1 ? dashSplit.slice(1).join(' - ').trim() : headingRest;

    const task = {
      id: fields.id ?? headingId,
      title: fields.title ?? headingTitle,
      priority: fields.priority ?? 100,
      depends_on: normalizeList(fields.depends_on),
      max_attempts: fields.max_attempts ?? 2,
      scope: normalizeList(fields.scope),
      acceptance: normalizeAcceptance(fields.acceptance, section.lineNo),
      allow_package_install: fields.allow_package_install ?? null,
      goal: extractProse(section.lines, /^goal/i),
      notes: extractProse(section.lines, /^(notes|constraints|notes\s*\/\s*constraints)/i),
      headingLine: section.lineNo,
      raw: fields,
    };

    if (fields.id && headingId && String(fields.id) !== headingId) {
      warnings.push(
        `Task at line ${section.lineNo}: heading says "${headingId}" but the yaml id is "${fields.id}"; the yaml wins.`,
      );
    }
    task.id = task.id === null || task.id === undefined ? null : String(task.id);
    tasks.push(task);
  }

  return { title, settings, tasks, warnings };
}

function normalizeList(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : v));
  return [typeof value === 'string' ? value.trim() : value];
}

function normalizeAcceptance(value, lineNo) {
  const list = normalizeList(value);
  return list.map((entry) => {
    if (typeof entry === 'string') {
      return { command: entry, expect: 'exit_zero', description: null };
    }
    if (entry && typeof entry === 'object') {
      if (!entry.command && !entry.check) {
        throw new PlanError('an acceptance entry needs a "command:" (or "check:") key', lineNo);
      }
      return {
        command: entry.command ?? null,
        check: entry.check ?? null,
        expect: entry.expect ?? 'exit_zero',
        description: entry.description ?? null,
        cwd: entry.cwd ?? null,
      };
    }
    throw new PlanError(`unsupported acceptance entry: ${JSON.stringify(entry)}`, lineNo);
  });
}

export default { parsePlan, parseRestrictedYaml, PlanError };
