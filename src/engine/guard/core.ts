/**
 * The command guard's decision: tokenise a command line, and answer why a segment of
 * it must be refused, or null when every segment may run.
 *
 * This is a library and stays one. It reads no file, touches no process state and
 * never exits — the caller passes the config in and handles what comes back. Each
 * runtime's hook entry point wraps it (`hook-claude.ts` for Claude Code); the test
 * fixture `guard-batch.mjs` asks it several hundred questions in one process.
 *
 * A PreToolUse hook blocks on exit 2 and ONLY on exit 2, so a hook that can be reached
 * without having asked this library permits the command. That is why the decision is
 * a function with no CLI of its own: the entry point calls it unconditionally and turns
 * every exception into a refusal.
 *
 * What it refuses, segment by segment (one simple command each, through `sudo`, `env`,
 * `timeout`, `xargs` and the other transparent wrappers, by program basename):
 *
 *   - `gh` entirely, and `git fetch|pull|push|remote`: stages do not talk to the forge;
 *     the engine fetches before every stage and does every forge write (design C5);
 *   - an environment assignment in front of any program, a nested shell (`bash -c`,
 *     `eval`), `find -exec|-delete|-fprint*`, and a wrapper hiding a program the guard
 *     has no fence for;
 *   - `node` and `npx tsx`, unless the command starts with one of the prefixes in
 *     `fence.allow`, and `autoclaude` unless it is `autoclaude note` or `autoclaude
 *     gates`; the engine's other verbs are the engine's own (design § 6, C6);
 *   - for git: arguments the shell would still expand, global options, subcommands and
 *     `-c` keys outside an allowlist, config writes, `rebase --exec`, `reset --hard`,
 *     a branch reset (`branch -D|-M|-f`, `checkout -B`, `switch -C`), the pathspecs
 *     `add|rm|mv|checkout|restore` may name, and the reads and stashes that would print a
 *     secret;
 *   - a program the shell decides (an expansion, a substitution or a glob in the program's
 *     own token), and a wrapper flag that hands the command to a split string, a shell or
 *     another directory (`env -S`, `sudo -s`, `env -C`);
 *   - a shell redirection that writes outside the worktree or into a forbidden path, and a
 *     `cd`/`pushd` that leaves the worktree.
 *
 * This is a fence, not a sandbox: it reads text, and a test file the agent writes can
 * spawn anything. It raises the cost of a mistake; the review of every pull request
 * remains the control.
 */
import { matchesAny } from "../../config/globs.js";

/**
 * What the guard is handed, built by the entry point from the project's `ProjectConfig`
 * and the stage's worktree: `forbiddenPaths` and `fence.allow` from the project, and the
 * worktree the stage runs in, as an absolute path. A redirection, a `cd` and a git
 * pathspec are placed against the worktree: whatever lands outside it is refused.
 *
 * `platform` says whose path rules apply — the drive spellings and the case folding of
 * Windows and macOS — and defaults to this process's. The rules are pure string logic, so
 * a test can ask for another OS's.
 */
export interface GuardConfig {
  forbiddenPaths: string[];
  fenceAllow: string[];
  worktree: string;
  platform?: NodeJS.Platform;
}

/**
 * The config handed in for the current call, and the copy checked for it.
 *
 * It is only checked once a decision needs it. That laziness is behaviour, not an
 * optimisation: a call whose config is broken must still be able to run `npm test`,
 * which needs nothing from it — the hook's own test says so. Whatever the caller does
 * when the check throws is the caller's business; nothing here ends a process.
 */
let configSource: unknown = null;
let config: GuardConfig | null = null;
/** The directory the shell stands in when the command starts, when the caller knows it. */
let startDir: string | undefined;

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function projectConfig(): GuardConfig {
  if (config) return config;
  const c = configSource as Record<string, unknown> | null;
  const missing: string[] = [];
  if (!c || typeof c !== "object") {
    missing.push("the config itself");
  } else {
    if (!isStrings(c.forbiddenPaths)) missing.push("forbiddenPaths");
    if (!isStrings(c.fenceAllow)) missing.push("fenceAllow");
    const platform = c.platform === undefined ? process.platform : c.platform;
    if (typeof platform !== "string") missing.push("platform");
    else if (
      typeof c.worktree !== "string" ||
      placePath(c.worktree, null, platform as NodeJS.Platform) === null
    )
      missing.push("worktree (an absolute path)");
  }
  // The two lists are read further down, and a missing one must not read as an empty
  // fence: `forbiddenPaths ?? []` would let `git rm` on the engine's own files through;
  // the worktree is what every path is placed against. Throwing is the whole difference:
  // the hook's outer catch turns it into exit 2, and a driver sees an error instead of a
  // verdict.
  if (missing.length) {
    config = null;
    throw new TypeError(
      `the command guard's config is missing ${missing.join(", ")}; a command that needs it is refused`,
    );
  }
  config = c as unknown as GuardConfig;
  return config;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

const OPERATOR_CHARS = ";|&()<>\n";

/** One word as the shell will read it, and whether the shell still decides its value. */
interface Token {
  text: string;
  /** An unquoted `$`, a substitution, an unquoted brace or a leading `~`. */
  dynamic: boolean;
  /** Where in `text` the first part the shell decides begins. */
  dynamicAt?: number;
  /** An unquoted `*` or `?`: a glob the shell expands. */
  glob?: boolean;
  /** An unquoted `[`, which opens a glob class when a `]` follows it. */
  bracket?: boolean;
}

/** One simple command: its tokens, and the targets its redirections write. */
type Segment = Token[] & { writes?: string[] };

/**
 * Splits a command the way a POSIX shell would read it, without expanding anything.
 * Returns segments (one per simple command), each a list of tokens `{ text, dynamic }`.
 * `dynamic` marks a token whose final value the shell decides: it carried an unquoted
 * `$`, a command substitution, an unquoted brace or a leading `~`. The command inside a
 * `$( )` or backticks becomes a segment of its own, so it is checked like any other.
 */
function tokenize(command: string): Segment[] {
  const segments: Segment[] = [];
  let seg: Segment = [];
  let segWrites: string[] = [];
  let cur: Token | null = null;
  const heredocs: Array<{ delimiter: string; strip: boolean }> = [];
  const n = command.length;
  let i = 0;
  let mode: "plain" | "single" | "double" = "plain";

  const open = () => {
    if (!cur) cur = { text: "", dynamic: false };
  };
  const add = (ch: string, dynamic = false, unquoted = false) => {
    open();
    if (dynamic && !cur!.dynamic) cur!.dynamicAt = cur!.text.length;
    cur!.text += ch;
    if (dynamic) cur!.dynamic = true;
    if (unquoted && (ch === "*" || ch === "?")) cur!.glob = true;
    if (unquoted && ch === "[") cur!.bracket = true;
  };
  const endToken = () => {
    if (cur) seg.push(cur);
    cur = null;
  };
  const endSegment = () => {
    endToken();
    // A redirection with no command (`> file`, `true && > file`) still truncates the file,
    // so a segment with writes and no tokens is kept.
    if (seg.length || segWrites.length) {
      // A property on the array, so every existing `seg.map(t => t.text)` still works.
      seg.writes = segWrites;
      segments.push(seg);
    }
    seg = [];
    segWrites = [];
  };
  const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\r";

  /** One word, quotes honoured, no expansion: a redirection target or a here-document delimiter. */
  function readWord(): string {
    while (i < n && isSpace(command[i])) i++;
    let word = "";
    let quote: string | null = null;
    while (i < n) {
      const c = command[i]!;
      if (quote) {
        if (c === quote) quote = null;
        else word += c;
        i++;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        word += command[i + 1]!;
        i += 2;
        continue;
      }
      if (isSpace(c) || OPERATOR_CHARS.includes(c)) break;
      word += c;
      i++;
    }
    return word;
  }

  /** After a newline: drop the bodies of the here-documents opened on the line before. */
  function skipHeredocBodies() {
    while (heredocs.length) {
      const { delimiter, strip } = heredocs.shift()!;
      while (i < n) {
        let end = command.indexOf("\n", i);
        if (end < 0) end = n;
        let line = command.slice(i, end);
        if (strip) line = line.replace(/^\t+/, "");
        i = end + 1;
        if (line === delimiter) break;
      }
    }
  }

  /** `$( ... )` or backticks: the inner command is its own segment; the outer token is dynamic. */
  function nested(start: number, close: string): number {
    let depth = 1;
    let j = start;
    let quote: string | null = null;
    while (j < n) {
      const c = command[j]!;
      if (quote) {
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if (close === ")" && (c === "'" || c === '"')) {
        quote = c;
        j++;
        continue;
      }
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (close === ")" && c === "(") depth++;
      if (c === close && --depth === 0) break;
      j++;
    }
    add("", true);
    for (const inner of tokenize(command.slice(start, j))) segments.push(inner);
    return Math.min(j + 1, n);
  }

  /**
   * A redirection: `>`, `>>`, `>|`, `<>`, `2>&1`, `<`, and (from the caller) `&>`, `&>>`.
   * The fd in front is dropped; the target of a *write* is kept, because a shell
   * redirection writes a file and no `Edit(...)` permission rule binds Bash. Without it,
   * `echo x > <a forbidden path>` and then running what it wrote are two permitted
   * commands — write and execute, straight past the fence that exists to keep the engine's
   * own code out of an agent's reach. `>&2`, `2>&1` and `>&-` duplicate or close a
   * descriptor and write no file; `>& file` does write one.
   */
  function redirection(dropFd = true) {
    if (dropFd && cur && /^\d+$/.test((cur as Token).text)) cur = null;
    endToken();
    const write = command[i] === ">" || (command[i] === "<" && command[i + 1] === ">");
    i++;
    let dup = false;
    while (i < n && (command[i] === ">" || command[i] === "&" || command[i] === "|")) {
      if (command[i] === "&") dup = true;
      i++;
    }
    const target = readWord();
    if (write && target && !(dup && /^(\d+|-)$/.test(target))) segWrites.push(target);
  }

  while (i < n) {
    const c = command[i]!;
    if (mode === "single") {
      if (c === "'") mode = "plain";
      else add(c);
      i++;
      continue;
    }
    if (mode === "double") {
      if (c === '"') {
        mode = "plain";
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < n && '"\\$`'.includes(command[i + 1]!)) {
        add(command[i + 1]!);
        i += 2;
        continue;
      }
      if (c === "$" && command[i + 1] === "(") {
        i = nested(i + 2, ")");
        continue;
      }
      if (c === "`") {
        i = nested(i + 1, "`");
        continue;
      }
      add(c, c === "$");
      i++;
      continue;
    }
    // plain
    if (c === "\\") {
      if (i + 1 < n && command[i + 1] !== "\n") add(command[i + 1]!);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      open();
      mode = c === "'" ? "single" : "double";
      i++;
      continue;
    }
    if (c === "#" && !cur) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      endSegment();
      i++;
      skipHeredocBodies();
      continue;
    }
    if (isSpace(c)) {
      endToken();
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      // `<<WORD` opens a here-document and `<<<word` a here-string; both are data.
      if (cur && /^\d+$/.test((cur as Token).text)) cur = null;
      endToken();
      i += 2;
      if (command[i] === "<") {
        i++;
        readWord();
        continue;
      }
      const strip = command[i] === "-";
      if (strip) i++;
      heredocs.push({ delimiter: readWord(), strip });
      continue;
    }
    if (c === "<" || c === ">") {
      redirection();
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      i = nested(i + 2, ")");
      continue;
    }
    if (c === "`") {
      i = nested(i + 1, "`");
      continue;
    }
    if (c === "&" && command[i + 1] === ">") {
      // `&>file` and `&>>file` write stdout and stderr to the file. Read as the operator
      // `&`, they ended the segment and the write landed in an empty one, which was dropped.
      i++;
      redirection(false);
      continue;
    }
    if (";|&()".includes(c)) {
      endSegment();
      i++;
      continue;
    }
    if (c === "$" || c === "{" || c === "}" || (c === "~" && !cur)) {
      add(c, true);
      i++;
      continue;
    }
    add(c, false, true);
    i++;
  }
  endSegment();
  return segments;
}

// ---------------------------------------------------------------------------
// Which program a segment runs
// ---------------------------------------------------------------------------

/** `git`, `git.exe`, `/usr/bin/git`, `C:\Program Files\Git\bin\git.exe` are all git. */
function program(text: string): string {
  return (text.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/**
 * Whether the shell rather than the text decides what a token is: an expansion or a
 * substitution in it, or an unquoted glob — `*`, `?`, or a `[` with a `]` after it (a lone
 * `[` is the test command).
 */
function unreadable(t: Token): boolean {
  return t.dynamic || t.glob === true || (t.bracket === true && /\[.*\]/.test(t.text));
}

/** Programs that run a command the guard cannot read; refused outright. */
const SHELLS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "source",
  ".",
]);

/**
 * Programs that run the command after them, with what each one puts in front of it.
 *
 * `value` are the flags that take their value as the next token — `nice -n 10`,
 * `env -u NAME`, `sudo -u user`, `xargs -n 1` — and `operand` says whether the wrapper
 * takes one positional argument of its own, which only `timeout` does. A flag spelled
 * `--kill-after=5` or glued (`-oL`, `-n10`) carries its value with it and needs no entry.
 *
 * The grammar is read rather than guessed at, because the token after the wrapper's
 * arguments *is* the program and nothing beyond it is ever consulted (`invocation` says
 * why). Both ways of being wrong end in a refusal: a value flag this does not know leaves
 * the pointer on the value, and one it wrongly thinks takes a value moves the pointer past
 * the program — either way the next token is not a fenced program and the command is
 * refused for hiding one.
 */
interface WrapperSpec {
  value: string[];
  operand?: boolean;
}

const WRAPPER_ARGS: Record<string, WrapperSpec | undefined> = {
  sudo: { value: ["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "-U", "-h", "--host"] },
  doas: { value: ["-u", "-C"] },
  env: { value: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"] },
  nohup: { value: [] },
  time: { value: ["-o", "--output", "-f", "--format"] },
  nice: { value: ["-n", "--adjustment"] },
  ionice: { value: ["-c", "--class", "-n", "--classdata", "-p", "--pid"] },
  command: { value: [] },
  builtin: { value: [] },
  exec: { value: ["-a"] },
  xargs: {
    value: ["-n", "-L", "-I", "-i", "-d", "-P", "-s", "-E", "-a", "--max-args", "--max-lines", "--replace", "--delimiter", "--max-procs", "--max-chars", "--eof", "--arg-file"], // prettier-ignore
  },
  timeout: { value: ["-k", "--kill-after", "-s", "--signal"], operand: true },
  stdbuf: { value: ["-i", "-o", "-e", "--input", "--output", "--error"] },
};

/** `timeout`'s own operand: a number, optionally with a unit — `30`, `5s`, `0.5m`. */
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/**
 * Shell keywords that precede a command; looked through as well, and harmless.
 *
 * A keyword takes no operand of its own, so the token after it is the program itself and
 * nothing is hidden. They are kept apart from the wrappers above because the fail-closed
 * refusal is about a hidden program: applied to these, it would refuse every compound
 * command a session writes (`if …; then npm run test:ci; fi`, `{ … ; }`).
 */
const WRAPPER_KEYWORDS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "{",
  "}",
]);

/**
 * The programs this file has a fence for, and therefore the set a wrapper may hide.
 *
 * A look-through that knows only `["git", "gh"]` makes a wrapper a way around every other
 * fence: for `timeout 30 node -e "…"` the loop stops on `30`, `node` is not recognised,
 * `30` becomes the program, and `checkSegment` falls through to `null`. So
 * `timeout 30 node -e "require('child_process')"` and `nice -n 10 node -e "1"` were
 * permitted while their unwrapped spellings were refused, and `timeout 30 git push` was
 * refused — the proof that it worked for exactly two programs.
 */
const FENCED = new Set(["git", "gh", "node", "npx", "autoclaude"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Past one wrapper's own arguments: its flags, the values of the flags that take one, and
 * its single positional operand where it has one.
 *
 * The operand is only consumed when it looks like the one the wrapper takes. `timeout 30`
 * and `timeout 5s` are durations; `timeout git status` is a malformed command, and eating
 * `git` there would hide the program the guard exists to read — so the duration test
 * decides it rather than the position.
 */
/**
 * Wrapper flags that hand the command to something the guard cannot follow: a string split
 * into a command (`env -S`), a shell that re-reads it (`sudo -s`, `sudo -i`, `doas -s`), or
 * another directory or root (`env -C`, `sudo -D`, `sudo -R`). `short` are the flag letters,
 * in a bundle too; a letter in `values` takes the rest of its bundle as its value. A long
 * option is refused by any prefix getopt would accept for it (`--split`, `--sh`).
 */
const WRAPPER_DANGER: Record<
  string,
  { short: string; values: string; long: string[] } | undefined
> = {
  env: { short: "SC", values: "uPa", long: ["--split-string", "--chdir"] },
  sudo: {
    short: "siDR",
    values: "ugpCUhrtT",
    long: ["--shell", "--login", "--chdir", "--chroot"],
  },
  doas: { short: "s", values: "uC", long: [] },
};

function wrapperDanger(p: string, seg: Segment, from: number, spec: WrapperSpec): string | null {
  const danger = WRAPPER_DANGER[p];
  if (!danger) return null;
  const hits = (flag: string): boolean => {
    if (flag.startsWith("--")) {
      const name = flag.split("=")[0]!;
      return name.length >= 3 && danger.long.some((l) => l.startsWith(name));
    }
    for (const ch of flag.slice(1)) {
      if (danger.short.includes(ch)) return true;
      if (danger.values.includes(ch)) return false; // the rest of the bundle is its value
    }
    return false;
  };
  // The same walk over the wrapper's flags as `afterWrapperArgs`, values skipped.
  let k = from;
  while (k < seg.length && seg[k]!.text.startsWith("-")) {
    const flag = seg[k]!.text;
    k++;
    if (flag === "--") break;
    if (hits(flag))
      return `${p} ${flag} hands the command to a split string, a shell or another directory, which the guard cannot follow`;
    if (spec.value.includes(flag) && k < seg.length) k++;
  }
  return null;
}

function afterWrapperArgs(seg: Segment, from: number, spec: WrapperSpec): number {
  let i = from;
  while (i < seg.length && seg[i]!.text.startsWith("-")) {
    const flag = seg[i]!.text;
    i++;
    if (spec.value.includes(flag) && i < seg.length) i++;
  }
  if (spec.operand && i < seg.length && DURATION.test(seg[i]!.text)) i++;
  return i;
}

/** What a segment runs: the assignments in front, the program and its arguments. */
interface Invocation {
  assigns: string[];
  /** The program by basename, lower-cased, `.exe`/`.cmd`/`.bat` stripped. */
  program: string;
  /** The program's own token, as typed. */
  token: Token;
  args: Token[];
}

/**
 * The assignments in front, the program by basename, and its arguments — or a refusal
 * when a wrapper leaves the program unreadable.
 *
 * Three outcomes, not two: `null` when the segment runs nothing, `{ refusal }` when a
 * wrapper hides the program, and the invocation otherwise. The refusal is what makes the
 * wrapper case fail closed; returning the wrapper's operand as the program is what
 * permitted `timeout 30 node -e …`, because no branch in `checkSegment` claims `30`.
 *
 * **The walk never scans.** A walk that searches the whole segment for a fenced word
 * behind the wrapper is a hole of its own: in `env -i bash -c evil autoclaude note 5 x`
 * the pointer moves off `bash` onto the permitted command further along, the decision is
 * made about that, and what runs is `bash -c evil` — the same class one program over, and
 * `sh`, `nohup`, `exec`, `command`, `xargs` and `stdbuf` all reach it.
 *
 * So one wrapper is consumed at a time, and the token after its arguments **is** the
 * program: another wrapper repeats the step, a keyword is stepped over, an assignment is
 * collected — which is how the assignment fence reaches an assignment *between* the
 * wrapper and the program — and anything else ends the walk. Nothing past that token is
 * ever consulted, so a shell there meets `SHELLS`, a fenced program its own branch, and
 * anything else the refusal below.
 */
function invocation(seg: Segment): Invocation | { refusal: string } | null {
  const assigns: string[] = [];
  let i = 0;
  /** Where the first program wrapper sat, or -1: only that kind can hide the program. */
  let wrapperAt = -1;
  for (;;) {
    if (i >= seg.length) return null;
    const tok = seg[i]!;
    const t = tok.text;
    // An assignment has a literal name before its `=`. One the shell assembles
    // (`$(printf 'git push ')x=1`) is a command word, which word splitting may turn into
    // any program at all.
    if (ASSIGNMENT.test(t) && !(tok.dynamic && (tok.dynamicAt ?? 0) <= t.indexOf("="))) {
      assigns.push(t);
      i++;
      continue;
    }
    // A keyword or a wrapper only as typed: `env$(printf ' bash -c evil')` reads as `env`
    // and is not one. The brace group's `{` and `}` are marked dynamic and are keywords.
    if (!unreadable(tok) || t === "{" || t === "}") {
      const p = program(t);
      if (WRAPPER_KEYWORDS.has(p)) {
        i++;
        continue;
      }
      const spec = WRAPPER_ARGS[p];
      if (spec) {
        const danger = wrapperDanger(p, seg, i + 1, spec);
        if (danger) return { refusal: danger };
        if (wrapperAt < 0) wrapperAt = i;
        i = afterWrapperArgs(seg, i + 1, spec);
        continue;
      }
    }
    break;
  }
  const token = seg[i]!;
  // The program the shell assembles is no program the guard can name: `$(echo git) push`,
  // `g=git; $g push`, `$'git' push` and `/usr/bin/g?t push` all run git.
  if (unreadable(token))
    return {
      refusal: `the program "${token.text}" is decided by the shell (an expansion, a substitution or a glob); name the program`,
    };
  const p = program(token.text);
  // Behind a wrapper, only a program this file has a fence for may run: a shell is
  // refused by `SHELLS` below, an assignment by the fence above it, and anything else is
  // something the guard cannot decide about — the wrapper is hiding it. Named with the
  // arguments it was hidden behind, because those are the tokens a reader would otherwise
  // take for the program.
  if (wrapperAt >= 0 && assigns.length === 0 && !FENCED.has(p) && !SHELLS.has(p)) {
    const shown = seg
      .slice(wrapperAt, i)
      .map((t) => t.text)
      .join(" ");
    return {
      refusal: `a wrapper (${shown}) hides the program from the guard; run the program without it`,
    };
  }
  return { assigns, program: p, token, args: seg.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Where a path lands
// ---------------------------------------------------------------------------

/** Whether the platform's file systems fold case: Windows and macOS do by default. */
const foldsCase = (platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin";

/** Whether a path is absolute on the platform, however it is spelled there. */
function isAbsolutePath(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /^([a-zA-Z]:|[\\/])/.test(path) : path.startsWith("/");
}

/**
 * A path made absolute and normal the way the guard compares paths: forward slashes,
 * `.` and repeated separators dropped, `..` applied, case folded where the platform folds
 * it, and on Windows the drive written `c:/…` whichever of `C:\…`, `C:/…` or Git Bash's
 * `/c/…` was typed. A relative path is taken from `base`, itself a placed path.
 *
 * `null` when the location cannot be read: a relative path with no base, a drive-relative
 * `C:x`, or on Windows a Git Bash path such as `/tmp` or `/usr`, which lands in the Git
 * installation rather than anywhere the guard can name.
 */
function placePath(path: string, base: string | null, platform: NodeJS.Platform): string | null {
  const p = path.replace(/\\/g, "/");
  let root: string;
  let rest: string;
  let m: RegExpMatchArray | null;
  if (platform === "win32" && (m = p.match(/^([a-zA-Z]):\/(.*)$/))) {
    root = `${m[1]!.toLowerCase()}:/`;
    rest = m[2]!;
  } else if (platform === "win32" && (m = p.match(/^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/))) {
    root = `${m[1]!.toLowerCase()}:/`;
    rest = m[2] ?? "";
  } else if (platform === "win32" && p.startsWith("//")) {
    root = "//";
    rest = p.slice(2);
  } else if (platform === "win32" && /^([a-zA-Z]:|\/)/.test(p)) {
    return null;
  } else if (platform !== "win32" && p.startsWith("/")) {
    root = "/";
    rest = p.slice(1);
  } else {
    return base === null ? null : placePath(`${base}/${p}`, null, platform);
  }
  const out: string[] = [];
  for (const s of rest.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  const placed = root + out.join("/");
  return foldsCase(platform) ? placed.toLowerCase() : placed;
}

/** A placed path relative to the placed worktree: "" for the worktree itself, null outside it. */
function inWorktree(path: string, worktree: string): string | null {
  if (path === worktree) return "";
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** `cd`, `pushd` and `popd`: the builtins that move the shell. */
const MOVES = new Set(["cd", "pushd", "popd"]);

/** The words that make part of a command run more than once: a loop, or a function. */
const REPEATS = new Set(["for", "while", "until", "select", "function"]);

/** How many directories the guard follows a command through before it stops trying. */
const MAX_PLACES = 64;

/** Where a command may run, worked out once per command. */
interface Places {
  platform: NodeJS.Platform;
  /** The worktree, placed. */
  worktree: string;
  /**
   * Every directory the shell may stand in while the command runs, placed: the one it
   * starts in and each one a `cd` or `pushd` in the command may take it to; null for one
   * the guard cannot read.
   */
  dirs: Array<string | null>;
  /** Why a `cd`, `pushd` or `popd` segment is refused. */
  moves: Map<Segment, string>;
}

/**
 * The directories a command may run in.
 *
 * The guard decides every segment on its own, but a `cd` moves every segment after it:
 * `cd tools && echo x > engine/x.ts` writes `tools/engine/x.ts`, and a relative path is
 * only placed against the directory the shell stands in. So the directory changes are
 * read first, and each later path is placed against **every** directory the shell may be
 * in by then: the start, and each `cd`/`pushd` target taken from each of those. That is an
 * over-approximation on purpose — a `cd` in a subshell, after `||`, or that fails, leaves
 * the shell where it was, and that place is in the set as well.
 *
 * Refused, because no single place follows from them: a target the shell decides (`cd
 * $DIR`, `cd ~`, `cd -`, a bare `cd`, which goes home), one that lands outside the
 * worktree, `pushd` without a directory or with `+N`/`-N`, a `popd` with nothing this
 * command pushed, and a relative target in a command with a loop or a function, where it
 * may apply more than once. `CDPATH` is not read; the stage's environment is expected not
 * to set it.
 */
function places(segments: Segment[], command: string): Places {
  const cfg = projectConfig();
  const platform = cfg.platform ?? process.platform;
  const worktree = placePath(cfg.worktree, null, platform)!;
  const start = startDir === undefined ? worktree : placePath(startDir, null, platform);
  const dirs: Array<string | null> = [start];
  const moves = new Map<Segment, string>();
  const repeats =
    /\(\s*\)/.test(command) ||
    segments.some((s) => s.some((t) => !t.dynamic && REPEATS.has(t.text)));
  let pushed = 0;
  for (const seg of segments) {
    const inv = invocation(seg);
    if (!inv || "refusal" in inv || !MOVES.has(inv.program)) continue;
    const verb = inv.program;
    const args = inv.args;
    let k = 0;
    while (k < args.length && /^-[LPe@n]+$/.test(args[k]!.text)) k++;
    if (args[k]?.text === "--") k++;
    const target = args[k];
    const refuse = (why: string) => moves.set(seg, `${verb} ${why}; stay inside the worktree`);
    if (verb === "popd") {
      if (target) refuse(`${target.text} reaches into a directory stack the guard does not follow`);
      else if (pushed === 0)
        refuse("returns to a directory pushed before this command, which the guard cannot place");
      else pushed--;
      continue;
    }
    if (!target) {
      refuse(
        verb === "cd"
          ? "without a directory goes home"
          : "without a directory swaps to one pushed before this command",
      );
      continue;
    }
    const t = target.text;
    if (t === "-") {
      refuse("- returns to the previous directory, which may be anywhere");
      continue;
    }
    if (verb === "pushd" && /^[+-]\d+$/.test(t)) {
      refuse(`${t} rotates a directory stack the guard does not follow`);
      continue;
    }
    if (unreadable(target) || /[~$`*?[\]{}]/.test(t)) {
      refuse(`${t}: the shell decides where that is`);
      continue;
    }
    if (repeats && !isAbsolutePath(t, platform)) {
      refuse(
        `${t}: a relative directory in a command with a loop or a function may apply more than once; use the absolute path`,
      );
      continue;
    }
    const reached = dirs.map((d) => (d === null ? null : placePath(t, d, platform)));
    if (reached.some((d) => d === null || inWorktree(d, worktree) === null)) {
      refuse(`${t} leaves the worktree, or goes where the guard cannot place it`);
      continue;
    }
    for (const d of reached) if (!dirs.includes(d)) dirs.push(d);
    if (dirs.length > MAX_PLACES) {
      refuse(`${t}: the command changes directory more often than the guard follows`);
      continue;
    }
    if (verb === "pushd") pushed++;
  }
  return { platform, worktree, dirs, moves };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** Global options an agent may put before the subcommand, with their arity. Anything else is refused. */
// -C is absent on purpose: it takes the whole command to another directory, and every
// check here is written against path *names*, so `git -C <main directory> checkout .`
// reads exactly like the harmless one. Nothing a stage runs needs it; the engine passes a
// cwd to spawn instead.
const GIT_GLOBAL_OPTIONS = new Map<string, number>([
  ["-c", 1],
  ["--no-pager", 0],
  ["-P", 0],
  ["--no-optional-locks", 0],
  ["--literal-pathspecs", 0],
  ["--no-replace-objects", 0],
  ["--no-advice", 0],
  ["--version", 0],
  ["--help", 0],
]);

/** The keys `-c` may set: display and identity, nothing that names a command, a file or a hook. */
const GIT_C_KEYS =
  /^(core\.quotepath|user\.name|user\.email|color\.ui|advice\.[a-z]+|rebase\.autostash|fetch\.prune)$/i;

const GIT_SUBCOMMANDS = new Set([
  "add",
  "blame",
  "branch",
  "cat-file",
  "checkout",
  "commit",
  "config",
  "describe",
  "diff",
  "help",
  "log",
  "ls-files",
  "ls-remote",
  "merge-base",
  "mv",
  "rebase",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "rm",
  "show",
  "stash",
  "status",
  "switch",
  "version",
  "worktree",
]);

/**
 * The subcommands that talk to the remote or change which one there is.
 *
 * A stage fetches, pulls and pushes nothing: the engine fetches before every stage and
 * does every forge write, and the stage's environment holds no forge credential (design
 * C5). Checked before the allowlist, so the reason names the rule rather than a list.
 */
const GIT_FORGE = new Set(["fetch", "pull", "push", "remote"]);

const BRANCH_DANGER_LONG = new Set(["--delete", "--move", "--force", "--copy"]);

const CONFIG_WRITE_FLAGS =
  /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)$/;
const CONFIG_READ_FLAGS =
  /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope)$/;
const CONFIG_WRITE_VERBS = new Set(["set", "unset", "edit", "rename-section", "remove-section"]);

/**
 * `git branch` may not delete, move, copy over or reset a branch it names.
 *
 * The source refused this for the protected branches only, read from the project config.
 * The guard's config carries no branch names (`GuardConfig`), so it cannot tell a
 * protected branch from another, and refuses the operation for every named branch: a
 * stage creates and lists branches, and the engine manages the rest (design C5, § 7.4).
 * The shared refs of a worktree are the main checkout's, so a branch deleted here is
 * deleted there.
 */
function checkBranch(rest: string[]): string | null {
  const danger = rest.find(
    (a) =>
      BRANCH_DANGER_LONG.has(a.split("=")[0]!) || (/^-[a-zA-Z]+$/.test(a) && /[dDmMfcC]/.test(a)),
  );
  const named = rest.find((a) => !a.startsWith("-"));
  if (danger && named)
    return `git branch ${danger} would delete, move or reset ${named}; the guard knows no protected branches, so it refuses this for every branch, which the engine manages`;
  return null;
}

/** Reads are fine; every form that writes the configuration is refused, alias.* included. */
function checkConfig(rest: string[]): string | null {
  const flags = rest.filter((a) => a.startsWith("-"));
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const write = flags.find((f) => CONFIG_WRITE_FLAGS.test(f));
  if (write)
    return `git config ${write} writes the configuration, which is not the agent's to change`;
  if (CONFIG_WRITE_VERBS.has(positionals[0] ?? ""))
    return `git config ${positionals[0]} writes the configuration, which is not the agent's to change`;
  if (flags.some((f) => CONFIG_READ_FLAGS.test(f))) return null;
  if (positionals[0] === "get" || positionals[0] === "list") return null;
  if (positionals.length <= 1) return null;
  return `git config would write ${positionals[0]}; the configuration is not the agent's to change`;
}

/**
 * A file the guard treats as a secret whatever `forbiddenPaths` says: `.env`, `.env.local`,
 * `.env.<anything>` — and not `.env.example`, which is the checked-in template.
 *
 * Built in rather than configured, because the protection it mirrors is: the settings deny
 * `Read` on `.env.local` and `Edit` on every `.env` file, and `cat`, `grep` and `sed` are
 * denied by name for walking around those. `git` is on the allow list and walks around them
 * too — `git add -f .env.local` stages the file, and from the index it rides into a commit
 * and a push — so the same protection has to exist on this side of the fence. A project
 * that fences its secrets in `config.forbiddenPaths` as well is covered twice, which costs
 * nothing.
 */
function isSecretFile(path: string): boolean {
  // Lower-cased the way `program()` is: the filesystems this guard runs on (Windows, macOS)
  // fold case, so `git add .ENV.LOCAL` stages the real `.env.local` there.
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (name === ".env.example") return false;
  return name === ".env" || name.startsWith(".env.");
}

/**
 * `git add|rm|mv|checkout|restore` may not name a forbidden path, a secret or a path
 * outside the worktree.
 *
 * A pathspec reaches a forbidden file in more ways than its literal path: a directory
 * above it (`tools`, `.`), a magic pathspec (`:(top)`, `:(icase)`, `:(glob)`) or a
 * wildcard, which git matches with fnmatch by default. All of those are refused when
 * the command rolls files back to another commit or removes them: `rm`, `mv`,
 * `checkout <tree-ish> -- <path>`, `restore --source`. A plain `git checkout -- .` or
 * `git restore .` returns to the index, which holds the guard as committed, and stays
 * allowed.
 *
 * `add` is on the list for its literal paths only, and deliberately not as a verb that
 * rolls back: `git add -A` and `git add .` are the everyday commit path and stay
 * permitted, while `git add <a forbidden path>` is refused the way `git rm` on it is.
 *
 * git reads a pathspec from the directory the shell stands in, so each one is placed
 * against every directory the command may run in (`cd tools && git rm engine/x.ts`), an
 * absolute one against the worktree, and on Windows and macOS with case folded. A magic
 * pathspec is refused for every verb: `:/` and `:(top)` read from the top of the
 * repository, whichever directory the shell is in, and `:(icase)` folds case.
 */
/**
 * A pathspec as git will read it, not as it was typed.
 *
 * git collapses `.` segments and repeated separators, so the fence has to: otherwise
 * `git rm tools/engine/guard.ts` is refused while `git rm ././tools/engine/guard.ts` and
 * `git rm tools//engine//guard.ts` delete the same file. `..` is refused before this
 * runs, so dropping segments can only make more paths match `forbiddenPaths`, never fewer.
 */
function normalizePathspec(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
}

function checkFencedPaths(sub: string, rest: string[], pl: Places): string | null {
  const dashdash = rest.indexOf("--");
  const positionals = rest.filter(
    (a, i) => i !== dashdash && (i > dashdash && dashdash >= 0 ? true : !a.startsWith("-")),
  );
  const before = dashdash >= 0 ? rest.slice(0, dashdash).filter((a) => !a.startsWith("-")) : [];
  const rollsBack =
    sub === "rm" ||
    sub === "mv" ||
    (sub === "checkout" && (before.length >= 1 || (dashdash < 0 && positionals.length >= 2))) ||
    (sub === "restore" && rest.some((a) => /^(--source(=|$)|-s$|-s.)/.test(a)));
  const fold = (s: string) => (foldsCase(pl.platform) ? s.toLowerCase() : s);
  const forbidden = (projectConfig().forbiddenPaths ?? []).map(fold);
  // The literal directory in front of each glob: `tools/engine/**` guards `tools/engine`.
  const roots = forbidden.map((g) => g.split("*")[0]!.replace(/\/$/, "")).filter(Boolean);
  // The file is read by git, not by the guard, so its contents cannot be checked at all.
  const fromFile = rest.find((a) => /^--pathspec-from-file(=|$)|^--pathspec-file-nul$/.test(a));
  if (fromFile) return `git ${sub} ${fromFile}: the paths come from a file the guard cannot read`;
  const paths = dashdash >= 0 ? rest.slice(dashdash + 1) : positionals;
  // Where the shell may stand, relative to the worktree: `checkSegment` has refused git
  // already if any of them lies outside it.
  const prefixes = pl.dirs.map((d) => inWorktree(d as string, pl.worktree) as string);
  for (const a of paths) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(a))
      return `git ${sub} ${a}: a path outside the worktree is not readable here`;
    if (a.startsWith(":"))
      return `git ${sub} ${a}: a magic pathspec can reach a forbidden path; name the file`;
    for (const prefix of prefixes) {
      let path: string;
      if (isAbsolutePath(a, pl.platform)) {
        const placed = placePath(a, null, pl.platform);
        const rel = placed === null ? null : inWorktree(placed, pl.worktree);
        if (rel === null)
          return `git ${sub} ${a}: a path outside the worktree is not readable here`;
        path = rel;
      } else {
        path = fold(normalizePathspec(prefix ? `${prefix}/${a}` : a));
      }
      if (matchesAny(path, forbidden))
        return `git ${sub} would change ${a}, a forbidden path (config.forbiddenPaths)`;
      if (isSecretFile(path))
        return `git ${sub} names ${a}, a secret the session may not read or stage (the settings deny reading and editing the .env files; this is the same fence on git's side)`;
      if (!rollsBack) continue;
      if (/[*?[\]]/.test(a))
        return `git ${sub} ${a}: a wildcard can reach a forbidden path; name the file`;
      if (path === "" || path === "." || roots.some((r) => r === path || r.startsWith(`${path}/`)))
        return `git ${sub} ${a} covers a forbidden path (config.forbiddenPaths); name the files instead`;
    }
  }
  return null;
}

/**
 * `git add`: the two flags that stage what the ignore rules keep out, then the pathspecs.
 *
 * `.gitignore` is the only thing refusing `git add .env.local` in a normal checkout, and
 * `-f` overrides exactly that; `-N` stages an entry for the path without its content, which
 * `git diff` then prints and a later `git add -u` completes. Both are one step from a
 * commit and a push, so they are refused whatever path follows them — the pathspec check
 * below covers the names, and this covers the override.
 *
 * Bundled and glued spellings included: `-vf` carries the `f`, and `--force=1` is a broken
 * command that must still not read as a different one.
 */
function checkAdd(rest: string[], pl: Places): string | null {
  const override = rest.find(
    (a) =>
      /^(-f|--force|-N|--intent-to-add)$/.test(a.split("=")[0]!) ||
      (/^-[a-zA-Z]+$/.test(a) && /[fN]/.test(a.slice(1))),
  );
  if (override)
    return `git add ${override} stages a file the ignore rules keep out of the index, and from the index it reaches a commit and a push`;
  return checkFencedPaths("add", rest, pl);
}

/**
 * `git checkout -B`, `git switch -C` and `git worktree add -B` create a branch, or reset it
 * to another commit when it exists. Refused for every branch, as `git branch -f` is: the
 * guard knows no protected branches (`checkBranch`).
 */
function branchReset(sub: string, opts: string[]): string | null {
  const letter = sub === "switch" ? "C" : "B";
  const reset = opts.find(
    (a) =>
      new RegExp(`^-[a-zA-Z]*${letter}`).test(a) ||
      (sub === "switch" && /^--force-/.test(a.split("=")[0]!)),
  );
  if (!reset) return null;
  return `git ${sub} ${reset} resets the branch it names when it exists; the guard knows no protected branches, so it refuses this for every branch, which the engine manages`;
}

/** The flags that take untracked files into a stash, in every spelling git accepts. */
const STASH_UNTRACKED = /^(-u|--include-untracked|-a|--all)$/;

/**
 * `git stash`: the push forms may not take untracked files with them.
 *
 * An untracked file is the one thing the index does not already hold — `.env.local`, a
 * scratch file, anything `.gitignore` covers with `-a` — and a stash of it is readable
 * again through `git stash show -p` and `git stash pop`, neither of which the guard can
 * tell from an ordinary one. So the flags are refused where they are taken: `push`, `save`
 * and the bare `git stash`, which is `push`. `git stash push -m x`, `list`, `show -p`,
 * `pop` and `apply` are untouched.
 */
function checkStash(rest: string[]): string | null {
  const verb = rest.find((a) => !a.startsWith("-"));
  const pushes = verb === undefined || verb === "push" || verb === "save";
  if (!pushes) return null;
  const flag = rest.find(
    (a) =>
      STASH_UNTRACKED.test(a.split("=")[0]!) || (/^-[a-zA-Z]+$/.test(a) && /[ua]/.test(a.slice(1))),
  );
  if (flag)
    return `git stash ${flag} stashes untracked files, which git stash show -p prints back; stash the tracked changes or leave them`;
  return null;
}

function checkGit(args: string[], pl: Places): string | null {
  // `--no-index` reads two paths off the file system instead of the index, so
  // `git diff --no-index /dev/null .env.local` prints a file the session may not read —
  // `cat` under another name, through the one program on the allow list that has a reason
  // to read files. Refused wherever it appears, because it is never part of a command an
  // agent has to run.
  const noIndex = args.find((a) => a.split("=")[0] === "--no-index");
  if (noIndex)
    return `git ${noIndex} reads files outside the index, which is how a fenced file gets printed`;
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const opt = args[i]!;
    const arity = GIT_GLOBAL_OPTIONS.get(opt);
    if (arity === undefined) return `git global option ${opt} is not on the allowlist`;
    if (opt === "-c") {
      const key = (args[i + 1] ?? "").split("=")[0]!;
      if (!GIT_C_KEYS.test(key))
        return `git -c ${key} is not on the allowlist of command-line settings`;
    }
    i += 1 + arity;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  if (GIT_FORGE.has(sub))
    return `git ${sub} talks to the remote; stages do not fetch, pull, push or change remotes, the engine fetches before every stage and pushes what it publishes`;
  if (!GIT_SUBCOMMANDS.has(sub)) return `git ${sub} is not on the allowlist of autonomous sessions`;
  switch (sub) {
    case "branch":
      return checkBranch(rest);
    case "config":
      return checkConfig(rest);
    case "rebase": {
      const exec = rest.find((a) => a === "-x" || a === "--exec" || /^--exec=|^-x./.test(a));
      if (exec) return `git rebase ${exec} runs a command the guard cannot read`;
      return null;
    }
    case "reset":
      if (rest.includes("--hard"))
        return "git reset --hard discards commits; use a new commit instead";
      return null;
    case "ls-remote": {
      // `--upload-pack="git push origin x:develop #"` runs that string on the local side;
      // the value is one token here, so the nested push is never a segment.
      const exec = rest.find((a) => /^(--upload-pack|--exec)(=|$)|^-u/.test(a));
      if (exec) return `git ${sub} ${exec} runs a program the guard cannot read`;
      return null;
    }
    case "worktree": {
      const verb = rest.find((a) => !a.startsWith("-"));
      if (verb && !["list", "add", "remove", "prune"].includes(verb))
        return `git worktree ${verb} is not on the allowlist`;
      if (verb === "add") return branchReset("worktree add", rest);
      return null;
    }
    case "switch":
      return branchReset(sub, rest);
    case "add":
      return checkAdd(rest, pl);
    case "stash":
      return checkStash(rest);
    case "checkout": {
      // Options only: after `--` a path may begin with `-B`.
      const dashdash = rest.indexOf("--");
      const reset = branchReset(sub, dashdash >= 0 ? rest.slice(0, dashdash) : rest);
      return reset ?? checkFencedPaths(sub, rest, pl);
    }
    case "rm":
    case "mv":
    case "restore":
      return checkFencedPaths(sub, rest, pl);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

/**
 * Every gh call, whatever its verb: a stage holds no forge credential and calls gh not at
 * all; the engine prefetches the issue and pull request data a stage needs and does every
 * forge write (design C5). The source decided gh by subcommand, verb, `api` method and the
 * labels a command applied; all of that collapses into this one refusal.
 */
const GH_REFUSAL = "gh: stages do not call gh; the engine prefetches what they need";

// ---------------------------------------------------------------------------
// Per segment
// ---------------------------------------------------------------------------

/**
 * The engine verbs a stage runs itself: its milestone notes and the project's gates. Every
 * other `autoclaude` verb is the engine's to run around the stage (design § 6: the engine
 * is `autoclaude <verb>`; C5: the engine writes).
 */
const ENGINE_VERBS = ["autoclaude note", "autoclaude gates"];

/** What every refusal of the interpreter fence tells the model it may run instead. */
const FENCE_RULE = "a stage runs autoclaude note, autoclaude gates and the prefixes in fence.allow";

/** The flags that hand an interpreter its code on the command line. */
const EVAL_FLAG = /^(-e|--eval|-p|--print)$/;

/** Shell syntax a prefix may not carry: an operator, a redirection, an expansion, a comment. */
const PREFIX_SYNTAX = /[;|&()<>\n`$#]/;

/**
 * Whether an invocation starts with a prefix, token for token.
 *
 * The prefix is read by the same tokeniser as the command, so quoting means the same on
 * both sides, and it has to be one plain simple command: a prefix carrying an operator, a
 * redirection or a token the shell would expand matches nothing. The program is compared
 * by basename, the way the guard identifies programs everywhere else, unless the prefix
 * names it by path, which then has to be typed as it stands; every other token must be the
 * same text exactly, so `tools/gen.mjs` is neither `tools/gen.mjsx` nor `./tools/gen.mjs`.
 *
 * A token of the command that the shell still expands never stands in for one of the
 * prefix's: `autoclaude $(printf 'publish 7 ')note` reads as `note` with the substitution
 * dropped, and runs `autoclaude publish 7 note`. What follows the prefix is the command's
 * own business.
 */
function startsWith(inv: Invocation, prefix: string): boolean {
  if (PREFIX_SYNTAX.test(prefix)) return false;
  const parsed = tokenize(prefix);
  if (parsed.length !== 1) return false;
  const want = parsed[0]!;
  if (want.some((t) => t.dynamic)) return false;
  const have = [inv.token, ...inv.args];
  if (have.length < want.length) return false;
  return want.every((w, k) => {
    const h = have[k]!;
    if (h.dynamic) return false;
    if (k > 0 || /[\\/]/.test(w.text)) return h.text === w.text;
    return program(h.text) === program(w.text);
  });
}

/**
 * The interpreter fence: `node`, `npx tsx` and `autoclaude`.
 *
 * An interpreter handed a path the session chose runs a program the session wrote, so
 * each of these runs only what a prefix names: `autoclaude note` and `autoclaude gates`,
 * the engine verbs a stage runs itself, and the project's own `fence.allow`. Anything
 * else is refused, `node` and `npx tsx` with no argument included — both are a REPL.
 *
 * The eval flags are refused first, whatever `fence.allow` says, and keep their own
 * message: they hand the interpreter its code on the command line. They are decided on the
 * interpreter's first argument alone, so a quoted note further along whose text happens
 * to be "-e" is data, while `--eval=x` and the bundled `-pe` fall to the prefix rule like
 * any other argument.
 */
function checkFence(inv: Invocation): string | null {
  const { program: p, args } = inv;
  if (p === "node" && EVAL_FLAG.test(args[0]?.text ?? ""))
    return "node -e runs code the guard cannot read";
  if (p === "npx" && EVAL_FLAG.test(args[1]?.text ?? ""))
    return `npx tsx ${args[1]!.text} runs code the guard cannot read`;
  if (ENGINE_VERBS.some((v) => startsWith(inv, v))) return null;
  if (projectConfig().fenceAllow.some((v) => startsWith(inv, v))) return null;
  if (p === "autoclaude")
    return `autoclaude ${args[0]?.text ?? "without a verb"} is the engine's to run; ${FENCE_RULE}`;
  return `${p === "npx" ? "npx tsx" : "node"} runs a program the guard cannot read; ${FENCE_RULE}`;
}

/** Package runners: they run a package's program by name, and may fetch the package first. */
const RUNNERS = new Set(["npx", "pnpx", "bunx", "npm", "pnpm", "yarn", "bun"]);

/** The runners that take the command straight away; the others may name a verb first. */
const DIRECT_RUNNERS = new Set(["npx", "pnpx", "bunx"]);

/** The verbs a runner runs the command after: `npm exec`, `pnpm dlx`, `bun x`, `yarn run`. */
const RUNNER_VERBS = new Set(["exec", "x", "dlx", "run", "run-script"]);

/** The programs the interpreter fence decides, which no runner may run in their place. */
const RUN_FENCED = new Set(["autoclaude", "node", "tsx"]);

/**
 * A package runner in front of a fenced program, or of a shell.
 *
 * `npx autoclaude publish 7`, `npm exec autoclaude merge 12` and `npx node -e x` run what
 * the interpreter fence refuses, one program over; and `npx -c '…'`, `npm exec --call` and
 * `pnpm exec --shell-mode` hand a string to a shell. The runner's command is found the way
 * the runner reads it: past its flags (a flag's value may be the token after it, so that
 * one is checked too), past a verb such as `exec` or `dlx`, and the first token after that
 * is the command; nothing beyond it is consulted, so `npx vitest run test/autoclaude` is
 * the runner's business. Any other command stays the permission layer's: the guard does not
 * fence `npx` (ruling R38).
 *
 * `autoclaude` through a runner is refused even for `note` and `gates`: a runner may fetch
 * a package of that name from the registry rather than run the engine.
 */
function checkRunner(p: string, args: Token[]): string | null {
  let verb = DIRECT_RUNNERS.has(p);
  let afterFlag = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    const t = a.text;
    if (t.startsWith("-")) {
      if (/^(-c|--call|--shell-mode)(=|$)/.test(t))
        return `${p} ${t} runs a shell command the guard cannot read`;
      afterFlag = true;
      continue;
    }
    if (!verb && !afterFlag && RUNNER_VERBS.has(t)) {
      verb = true;
      continue;
    }
    if (unreadable(a)) return `${p} runs "${t}", which the shell decides; name the command`;
    const name = program(t).replace(/@.*$/, "");
    // `npx tsx <script>` itself is the fence's own shape, decided by `checkFence`.
    if (RUN_FENCED.has(name) && !(p === "npx" && k === 0 && t === "tsx")) {
      if (name === "autoclaude")
        return `autoclaude through ${p} may run a package of that name fetched from the registry; ${FENCE_RULE}, typed as they stand`;
      return `${name} through ${p} runs a program the guard cannot read; ${FENCE_RULE}`;
    }
    if (!afterFlag) return null;
    afterFlag = false;
  }
  return null;
}

/** `>` to one of these is not a write to a file, and needs no config to decide. */
const NOWHERE = /^(\/dev\/(null|stdout|stderr|fd\/\d+)|NUL)$/i;

/** What the shell would expand in a redirection target: the guard cannot place that. */
const TARGET_SYNTAX = /[~$`*?[\]{}]/;

/**
 * A shell redirection that would write outside the worktree or into a fenced path.
 *
 * Checked before the program is even identified, because it is the shell doing the
 * writing: `echo`, `sort`, `npm run x` — the verb is irrelevant. Each target is placed
 * against every directory the shell may stand in (`places`): it must land inside the
 * worktree, and there outside `forbiddenPaths`, the same list `checkFencedPaths` uses for
 * `git checkout`, which is what makes this consistent rather than a second policy. A
 * target the shell would still expand — `~`, `$HOME`, a substitution, a glob, a brace
 * sequence such as `{e..e}` — is refused, because its place is the shell's to decide.
 */
function checkWrites(seg: Segment, place: () => Places): string | null {
  const targets = (seg.writes ?? []).filter((t) => !NOWHERE.test(t));
  if (!targets.length) return null;
  const forbidden = projectConfig().forbiddenPaths ?? [];
  for (const t of targets) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(t)) return `a redirection to ${t} leaves the worktree`;
    if (TARGET_SYNTAX.test(t))
      return `a redirection to ${t} goes where the shell decides (~, $, a substitution, a glob or braces); name the file inside the worktree`;
    const pl = place();
    const fold = (s: string) => (foldsCase(pl.platform) ? s.toLowerCase() : s);
    for (const d of pl.dirs) {
      const placed = d === null ? null : placePath(t, d, pl.platform);
      const rel = placed === null ? null : inWorktree(placed, pl.worktree);
      if (rel === null) return `a redirection to ${t} leaves the worktree`;
      if (matchesAny(rel, forbidden.map(fold)))
        return `a redirection would write ${t}, a forbidden path (config.forbiddenPaths)`;
    }
  }
  return null;
}

function checkSegment(seg: Segment, place: () => Places): string | null {
  const wrote = checkWrites(seg, place);
  if (wrote) return wrote;
  const inv = invocation(seg);
  if (!inv) return null;
  // A wrapper the guard cannot see past, or a program the shell decides: refused here
  // rather than turned into a program name no branch below claims.
  if ("refusal" in inv) return inv.refusal;
  const { program: p, args, assigns } = inv;
  if (SHELLS.has(p)) return `${p} runs a nested shell the guard cannot read`;
  // In front of every program, not only in front of `git`. Below the program-specific
  // branches, the shapes the interpreter fence permits could be handed
  // `NODE_OPTIONS=--require=./x.js` — a module preloaded from a file the session may
  // write in its worktree — and the guard's own decision would be `null`. An assignment
  // in front of anything changes what it does, and what it changes is not something this
  // can read.
  if (assigns.length)
    return `an environment assignment (${assigns[0]!.split("=")[0]}=...) in front of ${p} changes what it does`;
  // -fprintf, -fprint, -fprint0 and -fls write a file with no shell redirection and no
  // subprocess, so neither the permission layer's verb match nor a redirection check sees
  // them: `find . -maxdepth 0 -fprintf <the guard's own module> PWNED` overwrites it. The
  // verb looks fenced because -exec and -delete are refused, which is what makes it easy
  // to miss.
  if (
    p === "find" &&
    args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprintf|fprint|fprint0|fls)$/.test(a.text))
  )
    return "find -exec, -delete and -fprint* run or write things the guard cannot read";
  if (MOVES.has(p)) return place().moves.get(seg) ?? null;
  if (RUNNERS.has(p)) {
    const ran = checkRunner(p, args);
    if (ran) return ran;
  }
  if (
    p === "autoclaude" ||
    p === "node" ||
    (p === "npx" && args[0] && program(args[0].text) === "tsx")
  )
    return checkFence(inv);
  if (p === "gh") return GH_REFUSAL;
  if (p !== "git") return null;
  const dynamic = args.find((a) => a.dynamic);
  if (dynamic)
    return `${p} argument "${dynamic.text}" carries shell syntax ($, backtick, braces or ~) the guard cannot expand`;
  // Resolved here, once a git invocation is certain: git is refused whenever the config
  // cannot be read, because the forbidden paths are then unknown — including for a
  // subcommand that reads none.
  projectConfig();
  // git works on the repository of the directory it runs in: from outside the worktree
  // that is another checkout, which none of the checks below are written for.
  const pl = place();
  if (pl.dirs.some((d) => d === null || inWorktree(d, pl.worktree) === null))
    return "git would run in a directory outside the worktree, which none of the guard's git checks are written for; run it inside the worktree";
  const words = args.map((a) => a.text);
  return checkGit(words, pl);
}

/**
 * The refusal for one command, or null when it may run.
 *
 * The config is required rather than found here: a library that went looking for it
 * would need a failure path of its own, and the only one a hook has is the refusal its
 * caller makes of a throw. It is checked at most once per call, and only once a decision
 * needs it.
 *
 * `cwd` is the directory the shell stands in when the command starts, when the caller
 * knows it (Claude Code reports it in the hook's payload); without it the command is taken
 * to start in the worktree. A shell that keeps its directory between commands starts the
 * next one wherever the last `cd` left it.
 */
export function refusalFor(command: string, cfg: GuardConfig, cwd?: string): string | null {
  if (!cfg) {
    throw new TypeError("refusalFor needs the guard config");
  }
  if (typeof command !== "string") {
    throw new TypeError("refusalFor needs the command as a string");
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new TypeError("refusalFor needs the starting directory as a string");
  }
  configSource = cfg;
  config = null;
  startDir = cwd;
  try {
    return decide(command);
  } finally {
    configSource = null;
    config = null;
    startDir = undefined;
  }
}

function decide(command: string): string | null {
  const segments = tokenize(command);
  // Worked out on first use: a command with no path in it needs no config for this.
  let known: Places | null = null;
  const place = (): Places => (known ??= places(segments, command));
  for (const seg of segments) {
    const reason = checkSegment(seg, place);
    if (reason) {
      const shown = seg
        .map((t) => t.text)
        .join(" ")
        .slice(0, 200);
      return `${reason}. Command: ${shown}`;
    }
  }
  return null;
}
