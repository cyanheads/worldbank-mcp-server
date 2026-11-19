/**
 * @fileoverview tests/helpers/served-prose.ts — Measures the server-authored
 * prose in a served `tools/list` entry: the tool's `description`, every
 * `description` in its `inputSchema` and in its `outputSchema` outside the
 * framework's error envelope, and the `when` text the framework renders into
 * `error.data.reason`. The framework's envelope text, the reason labels, and
 * the schema structure are not counted.
 * @module tests/helpers/served-prose
 */

/** A served JSON Schema node, as much of it as the measure walks. */
type SchemaNode = { [keyword: string]: unknown };

/** One `tools/list` entry, as much of it as the measure reads. */
export interface ServedTool {
  description?: string;
  inputSchema: SchemaNode;
  name: string;
  outputSchema?: SchemaNode;
}

/** UTF-8 bytes of a tool's server-authored prose, by part. */
export interface ProseBytes {
  description: number;
  input: number;
  output: number;
  total: number;
  when: number;
}

/** The framework's text around the declared `when` clauses in `error.data.reason`. */
const REASON_PREFIX = 'Machine-readable failure mode. Declared by this tool: ';
const REASON_SUFFIX = ' Other values are possible when a failure originates below the handler.';

/** Keywords whose values are data, not schemas, so a `description` key inside one is not prose. */
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

/** Bytes of every `description` string in a schema, at any depth. */
function descriptionBytes(node: unknown): number {
  if (Array.isArray(node))
    return node.reduce((sum: number, item) => sum + descriptionBytes(item), 0);
  if (node === null || typeof node !== 'object') return 0;
  let sum = 0;
  for (const [key, value] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(key)) continue;
    sum +=
      key === 'description' && typeof value === 'string'
        ? utf8Bytes(value)
        : descriptionBytes(value);
  }
  return sum;
}

/** The error envelope's `data.reason` schema, or undefined when the tool advertises no envelope. */
function reasonSchema(outputSchema: SchemaNode): SchemaNode | undefined {
  const path = ['properties', 'error', 'properties', 'data', 'properties', 'reason'];
  let node: unknown = outputSchema;
  for (const key of path) node = (node as SchemaNode | undefined)?.[key];
  return node as SchemaNode | undefined;
}

/**
 * Bytes of the `when` clauses the framework renders into `reason`'s description
 * as `` `reason`: when `` pairs, one per declared reason in `examples` order,
 * joined by a space. Throws when the rendered form no longer matches, so a
 * framework change fails loudly instead of being mismeasured.
 */
function whenBytes(reason: SchemaNode | undefined, tool: string): number {
  const examples = reason?.examples;
  if (!Array.isArray(examples) || examples.length === 0) return 0;
  const rendered = String(reason?.description);
  if (!rendered.startsWith(REASON_PREFIX) || !rendered.endsWith(REASON_SUFFIX))
    throw new Error(
      `${tool}: error.data.reason no longer reads "${REASON_PREFIX}… ${REASON_SUFFIX.trim()}"`,
    );
  const body = rendered.slice(REASON_PREFIX.length, -REASON_SUFFIX.length);
  const labels = examples.map((name) => `\`${String(name)}\`: `);
  let sum = 0;
  let cursor = 0;
  labels.forEach((label, index) => {
    if (body.indexOf(label, cursor) !== cursor)
      throw new Error(`${tool}: ${label}is not where expected in error.data.reason`);
    const start = cursor + label.length;
    const next = labels[index + 1];
    const end = next === undefined ? body.length : body.indexOf(` ${next}`, start);
    if (end < start)
      throw new Error(`${tool}: ${next}does not follow ${label}in error.data.reason`);
    sum += utf8Bytes(body.slice(start, end));
    cursor = end + 1;
  });
  return sum;
}

/** The server-authored prose of one served `tools/list` entry, in UTF-8 bytes. */
export function servedProseBytes(tool: ServedTool): ProseBytes {
  const description = utf8Bytes(tool.description ?? '');
  const input = descriptionBytes(tool.inputSchema);
  const outputSchema = tool.outputSchema ?? {};
  const { error: _envelope, ...success } = (outputSchema.properties ?? {}) as SchemaNode;
  const output = descriptionBytes({ ...outputSchema, properties: success });
  const when = whenBytes(reasonSchema(outputSchema), tool.name);
  return { description, input, output, when, total: description + input + output + when };
}
