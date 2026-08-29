type ContainerFrame =
  | {
    readonly kind: "array";
    readonly value: readonly unknown[];
    index: number;
  }
  | {
    readonly kind: "object";
    readonly value: Record<string, unknown>;
    readonly keys: readonly string[];
    index: number;
  };

function serializeCanonical(root: unknown, comparable: boolean): string {
  let output = "";
  let pending: unknown = root;
  let hasPending = true;
  const active = new WeakSet<object>();
  const stack: ContainerFrame[] = [];

  while (hasPending || stack.length > 0) {
    if (hasPending) {
      const current = pending;
      hasPending = false;
      if (current === undefined && comparable) {
        output += "undefined";
        continue;
      }
      if (
        current === null ||
        typeof current === "boolean" ||
        typeof current === "string"
      ) {
        output += JSON.stringify(current);
        continue;
      }
      if (typeof current === "number" && Number.isFinite(current)) {
        output += JSON.stringify(current);
        continue;
      }
      if (!current || typeof current !== "object") {
        throw new TypeError("The value contains a non-JSON value.");
      }
      if (active.has(current)) {
        throw new TypeError("The value contains a cycle and is not JSON.");
      }
      active.add(current);
      if (Array.isArray(current)) {
        output += "[";
        stack.push({ kind: "array", value: current, index: 0 });
      } else {
        const record = current as Record<string, unknown>;
        output += "{";
        stack.push({
          kind: "object",
          value: record,
          keys: Object.keys(record)
            .filter((key) => !comparable || record[key] !== undefined)
            .sort(),
          index: 0,
        });
      }
      continue;
    }

    const frame = stack[stack.length - 1]!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        output += "]";
        active.delete(frame.value);
        stack.pop();
        continue;
      }
      if (frame.index > 0) output += ",";
      pending = frame.value[frame.index];
      frame.index += 1;
      hasPending = true;
      continue;
    }

    if (frame.index >= frame.keys.length) {
      output += "}";
      active.delete(frame.value);
      stack.pop();
      continue;
    }
    if (frame.index > 0) output += ",";
    const key = frame.keys[frame.index]!;
    frame.index += 1;
    output += `${JSON.stringify(key)}:`;
    pending = frame.value[key];
    hasPending = true;
  }

  return output;
}

/** Stable JSON serialization with memory proportional to nesting depth, not array width. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, false);
}

/** Stable comparison form that preserves the legacy handling of `undefined`. */
export function canonicalComparableJson(value: unknown): string {
  return serializeCanonical(value, true);
}

/** Clones JSON data without the recursive-depth limit of `structuredClone`. */
export function cloneCanonicalJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
