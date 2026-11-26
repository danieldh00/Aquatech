// PreToolUse-vangrail voor Claude Code: dwingt de "niet doen"-regels uit CLAUDE.md en AGENTS.md mechanisch af.
// Leest de toolaanroep als JSON van stdin; exitcode 2 + melding op stderr = geblokkeerd.
// Cross-platform (Node). Uitzetten voor één sessie kan alleen door de mens: omgevingsvariabele AQUATECH_HOOKS_OFF=1.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_FILES, BASH_RULES, FILE_RULES, RELEASE_FILES } from './rules.mjs';

/** Voert git uit in een map en geeft de uitvoer terug (leeg bij een fout). */
function git(directory, args) {
  try {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Geeft de regels van `newText` terug die niet in `oldText` staan (zonder witruimte aan de randen). */
export function addedLines(oldText, newText) {
  const known = new Set(String(oldText || '').split(/\r?\n/).map((line) => line.trim()));
  return String(newText || '').split(/\r?\n/).filter((line) => line.trim() && !known.has(line.trim()));
}

/** Haalt de `for: [...]`-doelgroepen uit een stuk releases.js en normaliseert de witruimte. */
function stripAudience(text) {
  return String(text).replace(/,?\s*\bfor:\s*\[[^\]]*\]\s*,?/g, '').replace(/\s+/g, '');
}

/** Telt het aantal `for:`-doelgroepen in een stuk tekst. */
function countAudience(text) {
  return (String(text).match(/\bfor:\s*\[/g) || []).length;
}

/** Controleert een wijziging aan een beschermd releasebestand en geeft een melding terug (of null). */
export function releaseProblem(rel, change) {
  if (rel === RELEASE_FILES.changelog) {
    return 'CHANGELOG.md nooit zelf aanraken: release.yml doet dat na de merge. Maak een changes/<naam>.md.';
  }
  if (rel === RELEASE_FILES.releases) {
    const audienceOnly = stripAudience(change.old) === stripAudience(change.new) && countAudience(change.new) > countAudience(change.old) && change.old.trim() !== '';
    return audienceOnly ? null : 'releases.js nooit zelf aanraken (alleen een ontbrekende doelgroep `for: [...]` toevoegen mag). Maak een changes/<naam>.md.';
  }
  if (rel === RELEASE_FILES.packageJson) {
    const versionOf = (text) => (String(text).match(/"version"\s*:\s*"[^"]*"/) || [''])[0];
    const oldVersion = versionOf(change.old);
    const newVersion = versionOf(change.new);
    if (newVersion && oldVersion !== newVersion) {
      return 'De versie in package.json nooit zelf wijzigen: release.yml verhoogt hem na de merge.';
    }
  }
  return null;
}

/** Verzamelt de wijzigingen {old, new} van een Edit/Write/MultiEdit-aanroep. */
export function changesOf(toolName, input, existing) {
  if (toolName === 'Write') return [{ old: existing, new: input.content || '' }];
  if (toolName === 'MultiEdit') return (input.edits || []).map((edit) => ({ old: edit.old_string || '', new: edit.new_string || '' }));
  return [{ old: input.old_string || '', new: input.new_string || '' }];
}

/** Beoordeelt een bestandswijziging; geeft { deny, ask, warn } met meldingen terug. */
export function checkFile(rel, changes, onMaster) {
  const result = { deny: [], ask: [], warn: [] };
  if (onMaster) result.deny.push('Nooit rechtstreeks op master werken: maak een branch vers vanaf origin/master (claude/<naam>).');
  for (const change of changes) {
    const problem = releaseProblem(rel, change);
    if (problem) result.deny.push(problem);
  }
  const added = changes.flatMap((change) => addedLines(change.old, change.new)).join('\n');
  for (const rule of FILE_RULES) {
    if (!rule.paden.test(rel) || (rule.nietIn && rule.nietIn.test(rel))) continue;
    if (rule.patroon.test(added)) (rule.niveau === 'warn' ? result.warn : result.deny).push(`[${rule.id}] ${rule.melding}`);
  }
  for (const entry of ASK_FILES) if (entry.pad.test(rel)) result.ask.push(entry.melding);
  return result;
}

/** Beoordeelt een Bash-opdracht; geeft { deny, ask, warn } met meldingen terug. */
export function checkBash(command, context = {}) {
  const result = { deny: [], ask: [], warn: [] };
  for (const rule of BASH_RULES) {
    if (rule.alleenBij && !rule.alleenBij.test(command)) continue;
    const text = rule.negeerRegel ? command.split(/\r?\n/).filter((line) => !rule.negeerRegel.test(line)).join('\n') : command;
    if (rule.patroon.test(text)) result.deny.push(`[${rule.id}] ${rule.melding}`);
  }
  if (/\b(?:sed\s+-i|perl\s+-pi|tee|>>?|mv|cp)\b[^|;&]*(?:CHANGELOG\.md|frontend\/nieuws\/releases\.js)/.test(command)) {
    result.deny.push('[releasebestanden] CHANGELOG.md en releases.js nooit zelf aanraken: maak een changes/<naam>.md.');
  }
  const isPush = /\bgit\s+push\b/.test(command);
  if (/\bgit\s+(?:commit|push)\b/.test(command) && context.branch === 'master') {
    result.deny.push('[master] Nooit rechtstreeks op master committen of pushen: werk in een eigen branch.');
  }
  if (isPush && /(?:\s|:)(?:refs\/heads\/)?master(?:\s|$)/.test(command)) {
    result.deny.push('[master] Nooit naar master pushen: maak een PR.');
  }
  if (isPush && /\s(?:--force(?![-\w])|-f)(?:\s|$)/.test(command)) {
    result.deny.push('[force-push] Geen force-push (gebruik --force-with-lease alleen op je eigen branch na een merge).');
  }
  if (isPush && context.hubChangedWithoutFragment) {
    result.warn.push('Er is een wijziging in hub/ maar nog geen changes/<naam>.md (zonder fragment faalt version-must-increase; alleen docs/CI: label geen-releasenotes).');
  }
  return result;
}

/** Leest stdin volledig als tekst. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Zet het resultaat om in een exitcode en uitvoer voor Claude Code. */
function finish(result) {
  if (result.deny.length) {
    process.stderr.write(`Geblokkeerd door de projectvangrail (.claude/hooks):\n- ${result.deny.join('\n- ')}\n`);
    process.exit(2);
  }
  const output = { hookEventName: 'PreToolUse' };
  if (result.ask.length) {
    output.permissionDecision = 'ask';
    output.permissionDecisionReason = result.ask.join(' ');
  }
  if (result.warn.length) output.additionalContext = `Let op: ${result.warn.join(' ')}`;
  if (output.permissionDecision || output.additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
  process.exit(0);
}

/** Hoofdprogramma: leest de aanroep en beoordeelt hem. */
async function main() {
  if (process.env.AQUATECH_HOOKS_OFF === '1') process.exit(0);
  let call;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const input = call.tool_input || {};
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || call.cwd || process.cwd());
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (call.tool_name === 'Bash') {
    let hubChangedWithoutFragment = false;
    if (/\bgit\s+push\b/.test(input.command || '')) {
      const files = git(root, ['diff', '--name-only', 'origin/master...HEAD']).split('\n').filter(Boolean);
      hubChangedWithoutFragment = files.some((file) => file.startsWith('hub/')) && !files.some((file) => /^changes\/(?!README\.md$).+\.md$/.test(file));
    }
    finish(checkBash(input.command || '', { branch, hubChangedWithoutFragment }));
    return;
  }
  if (!input.file_path) process.exit(0);
  const absolute = isAbsolute(input.file_path) ? input.file_path : resolve(root, input.file_path);
  const rel = relative(root, absolute).split('\\').join('/');
  if (rel.startsWith('..')) process.exit(0);
  const existing = call.tool_name === 'Write' && existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  finish(checkFile(rel, changesOf(call.tool_name, input, existing), branch === 'master'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
