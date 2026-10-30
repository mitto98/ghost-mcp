import type { Json } from '../../ghost.js';

const MAX_OUTPUT_CHARS = 80_000;

function text(value: unknown) {
  let out = JSON.stringify(value, null, 2);
  if (out.length > MAX_OUTPUT_CHARS) {
    out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${out.length - MAX_OUTPUT_CHARS} more characters; lower "limit" or narrow the filter]`;
  }
  return { content: [{ type: 'text' as const, text: out }] };
}

function failure(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Wraps a handler so thrown errors become MCP tool errors instead of protocol errors. */
export function run<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return failure(e);
    }
  };
}

export function joinFilters(...parts: (string | undefined)[]): string | undefined {
  const f = parts.filter((p): p is string => !!p);
  if (!f.length) return undefined;
  return f.length === 1 ? f[0] : f.map((p) => `(${p})`).join('+');
}

export const names = (xs?: Json[]) => xs?.map((x) => x.name ?? x.slug);

export const clean = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function paginated(key: string, res: Json | null, map: (x: Json) => Json) {
  return { [key]: (res?.[key] ?? []).map(map), pagination: res?.meta?.pagination };
}

export function first(res: Json | null, key: string): Json {
  const item = res?.[key]?.[0];
  if (!item) throw new Error(`Ghost returned no ${key} item`);
  return item;
}
