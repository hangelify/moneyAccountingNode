// PreToolUse (Bash): block commands that destroy data, rewrite shared
// history, skip the commit checks or grow a baseline. Only the command words
// are checked: quoted strings and heredoc bodies (commit messages, grep
// patterns) are dropped first, and each `;`/`&&`/`||`/`|` segment is checked
// on its own.
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = String(input?.tool_input?.command ?? '');

function stripQuotedAndHeredocs(text) {
  // Heredoc bodies: <<'EOF' / <<"EOF" / <<-EOF ... EOF
  let out = text.replace(
    /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g,
    ' ',
  );
  out = out.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  return out;
}

const segments = stripQuotedAndHeredocs(command)
  .split(/&&|\|\||;|\||\n/)
  .map((s) => s.trim().split(/\s+/).filter(Boolean));

const reasons = [];
for (const words of segments) {
  const env = [];
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) env.push(words.shift());
  const line = words.join(' ');
  const isGit = words[0] === 'git';
  const sub = isGit ? words[1] : '';
  const args = isGit ? words.slice(2) : [];

  if (/(^|\s)(npx\s+)?mikro-orm\s+schema:(update|drop|fresh)\b|npm\s+run\s+schema:/.test(line)) {
    reasons.push('mikro-orm schema:* changes the database outside migrations; write a migration.');
  }
  if (/(mikro-orm|npm\s+run)\s+migration:fresh\b/.test(line) && !process.env.CI) {
    reasons.push('migration:fresh drops the whole database; only CI runs it.');
  }
  if (sub === 'push' && args.some((a) => /^(-f|--force|--force-with-lease(=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/.test(a) || /^\+/.test(a))) {
    reasons.push('force push rewrites shared history.');
  }
  if (sub === 'commit' && args.some((a) => a === '--no-verify' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) {
    reasons.push('skipping the commit checks; fix what they report.');
  }
  if (env.some((e) => /^HUSKY=0$/.test(e))) {
    reasons.push('HUSKY=0 skips the commit checks; fix what they report.');
  }
  if (/eslint\b.*--suppress-(all|rule)\b/.test(line)) {
    reasons.push('growing eslint-suppressions.json hides new violations; fix them.');
  }
  if (/depcruise\b.*--baseline\b/.test(line) && !/shrink-only/.test(line)) {
    reasons.push('only npm run arch:baseline (shrink-only) may touch the dependency-cruiser baseline.');
  }
}

if (reasons.length > 0) {
  process.stderr.write(`Blocked: ${[...new Set(reasons)].join(' ')}\n`);
  process.exit(2);
}
