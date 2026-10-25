export function lintFingerprint(path, source, message, root = process.cwd()) {
  // Source, not line number: moving code does not forgive new diagnostics.
  // Compiler messages embed absolute paths/frames after their first line.
  const line = source.split(/\r?\n/)[(message.line ?? 1) - 1]?.trim() ?? '';
  const summary = message.message.split('\n')[0]
    .split(root.replaceAll('\\', '/') + '/').join('<root>/')
    .replace(/\(at line \d+\)/g, '(at line <line>)');
  return JSON.stringify([path, message.ruleId, message.severity, summary, line]);
}
export function newLintMessages(path, source, messages, baseline) {
  const seen = new Map();
  return messages.filter(message => {
    const key = lintFingerprint(path, source, message);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > (baseline[key] ?? 0);
  });
}
