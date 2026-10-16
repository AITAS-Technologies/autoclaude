import { beforeAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { refusalFor, type GuardConfig } from "../../../src/engine/guard/core.js";

const BATCH = "test/fixtures/guard/guard-batch.mjs";
const REGISTER = pathToFileURL(resolve("test/helpers/ts-register.mjs")).href;

// An engine test: the guard reads forbidden paths and the fence prefixes from the config it
// is handed, so this file pins no project's values. Another project's config, another
// vocabulary, the same guard.
const FIXTURE: GuardConfig = {
  forbiddenPaths: ["tools/engine/**", ".autoclaude/config.json", ".github/workflows/**"],
  fenceAllow: ["npx tsx tools/codegen.ts"],
  worktree: "/work/tree",
  platform: "linux",
};
const cfg = FIXTURE;

/**
 * The reasons that changed with the port, named after the design section that changed
 * them. The commands are the source's; only the expected reason moved.
 *
 * - `C5_GIT`, `C5_GH`: design C5, "models read, the engine writes". The source answered
 *   each push with its own rule (the option, the refspec, the protected branch) and each
 *   gh call with its verb, method or label; a stage now fetches, pulls, pushes and calls
 *   gh not at all, so all of them collapse into one refusal each.
 * - `FENCE`: design § 6 and C6, the engine is `autoclaude <verb>` and nothing runs through
 *   tsx at run time. The source permitted one interpreter shape (the tsx loader in front
 *   of an engine script); the fence now permits `autoclaude note`, `autoclaude gates` and
 *   the prefixes in `fence.allow`, and refuses every other node and `npx tsx` command.
 */
const C5_GIT = /stages do not fetch, pull, push or change remotes/;
const C5_GH = /stages do not call gh; the engine prefetches/;
const FENCE = /autoclaude note, autoclaude gates and the prefixes in fence\.allow/;

const BLOCKED: Array<[string, RegExp]> = [
  ["git push --force origin trunk", C5_GIT],
  ["git push -f origin agent/1-x", C5_GIT],
  ["git push -fu origin agent/1-x", C5_GIT],
  ["git push --force-with-lease origin agent/1-x", C5_GIT],
  ["git push origin +agent/1-x", C5_GIT],
  ["git push origin HEAD:trunk", C5_GIT],
  ["git push origin trunk", C5_GIT],
  ["git push origin agent/1-x:release", C5_GIT],
  ["git push origin :trunk", C5_GIT],
  ["git push origin --delete agent/1-x", C5_GIT],
  ["git push origin HEAD", C5_GIT],
  ["git push", C5_GIT],
  ["git push origin", C5_GIT],
  ["git push origin $BRANCH", /shell syntax/],
  ["git push origin agent/1-x:refs/locks/merge", C5_GIT],
  ["git -c core.quotePath=false push --force origin agent/1-x", C5_GIT],
  // A shell redirection writes a file and no Edit(...) permission rule binds Bash, so a
  // write into a forbidden path and then running what it wrote would be two permitted
  // commands — write and execute.
  ["echo x > tools/engine/evil.ts", /redirection would write/],
  ["echo x >> .autoclaude/config.json", /redirection would write/],
  ["npm run build > .autoclaude/config.json", /redirection would write/],
  ["echo x > ../outside.txt", /leaves the worktree/],
  // find writes with no redirection and no subprocess; -exec and -delete being refused is
  // what made the verb look fenced.
  ["find . -maxdepth 0 -fprintf tools/engine/guard.mjs PWNED", /fprint/],
  ["find . -fprint .autoclaude/config.json", /fprint/],
  ["find . -fls out.txt", /fprint/],
  // -C takes the whole command somewhere every check here is blind to, because they are
  // written against path names.
  ["git -C C:/project checkout .", /global option -C/],
  ["git -C .. status", /global option -C/],
  // git collapses `.` segments and repeated separators, so the fence has to as well, or
  // the same file is refused by one spelling and deleted by another.
  ["git rm ././tools/engine/deep.ts", /forbidden path/],
  ["git rm tools//engine//deep.ts", /forbidden path/],
  ["git checkout ././.autoclaude/config.json", /forbidden path/],
  // The paths come from a file the guard cannot read.
  ["git rm --pathspec-from-file=p.txt", /cannot read/],
  ["git checkout --pathspec-file-nul", /cannot read/],
  ["git -C /tmp/x push origin trunk", /global option -C/],
  ["sudo git push --force origin agent/1-x", C5_GIT],
  ["GIT_TRACE=1 git push -f origin agent/1-x", /environment assignment/],
  ['bash -c "git push --force origin agent/1-x"', /nested shell/],
  ["npm test && git push origin trunk", C5_GIT],
  ["git push origin agent/1-x; gh repo delete o/r --yes", C5_GIT],
  ["git branch -D trunk", /protected/],
  ["git branch -M release old-release", /protected/],
  ["gh repo delete o/r", C5_GH],
  ["gh repo archive", C5_GH],
  ["gh secret set X --body y", C5_GH],
  ["gh workflow disable ci.yml", C5_GH],
  ["gh api -X DELETE /repos/o/r", C5_GH],
  ["gh api --method PATCH repos/o/r -f name=x", C5_GH],
  ["gh api repos/o/r/actions/secrets/X --input body.json", C5_GH],
  ["gh api graphql -f query='mutation { deleteRef }'", C5_GH],
  ["gh pr merge 12 --squash", C5_GH],
  ["gh pr close 12", C5_GH],
  ["gh issue edit 7 --body 'new criteria'", C5_GH],
  ["gh issue edit 7 --title x", C5_GH],
  ["gh label delete agent-ready", C5_GH],
  ["gh -R o/r pr merge 5", C5_GH],
  // The levers a first draft of an allowlist leaves open.
  ['git -c alias.x="push --force" x origin release', /alias/],
  ["git config alias.p 'push --force'", /alias/],
  ["gh api -XDELETE /repos/o/r", C5_GH],
  ["gh api -fname=x repos/o/r", C5_GH],
  ["gh pr edit 12 --base release", C5_GH],
  ["gh pr review 12 --approve", C5_GH],
  ["gh pr ready 12", C5_GH],
  ["gh issue close 7", C5_GH],
  ["gh issue edit 7 --add-label agent-migration-ok", C5_GH],
  ["gh issue edit 7 --add-label agent-working,agent-migration-ok", C5_GH],
  ["gh issue edit 7 --add-label=agent-migration-ok", C5_GH],
  // The other spellings of the same four things.
  ["git --git-dir /tmp/x push origin trunk", /global option --git-dir/],
  ["git --work-tree=/tmp/x push origin agent/1-x", /global option --work-tree/],
  ["git --namespace=x push origin agent/1-x", /global option --namespace/],
  ["git --exec-path=/tmp/evil push origin agent/1-x", /global option --exec-path/],
  ["git --config-env=alias.p=VAR p", /alias/],
  ["gh issue edit 7 --add-label agent-working --add-label agent-migration-ok", C5_GH],
  ['gh issue edit 7 --add-label "agent-working, agent-migration-ok"', C5_GH],
  ["gh pr create --fill --label agent-migration-ok", C5_GH],
  ["gh pr create --fill -l agent-migration-ok", C5_GH],
  ["gh issue create --title x --label bug,agent-migration-ok", C5_GH],
  ["git push origin agent/x:heads/trunk", C5_GIT],
  ["git push origin agent/x:heads/release", C5_GIT],
  ["gh alias set nuke 'pr merge 12 --squash'", C5_GH],
  ["gh extension install owner/gh-nuke", C5_GH],
  ["gh config set pager 'rm -rf .'", C5_GH],
  // Live in an intended deployment.
  ["gh issue edit 7 --add-label AGENT-Migration-OK", C5_GH],
  ['gh issue edit 7 --add-label agent-working -b "new criteria"', C5_GH],
  ["gh issue edit 7 -t x --add-label agent-working", C5_GH],
  ["gh issue edit 7 --add-label agent-working -F body.md", C5_GH],
  ["gh issue edit 7 --add-assignee me", C5_GH],
  ['git rebase --exec "git.exe push origin agent/x:trunk" HEAD~1', /--exec/],
  ["git rebase -x 'git push origin trunk' HEAD~1", /-x/],
  ["git.exe push origin trunk", C5_GIT],
  ["/usr/bin/git push --force origin agent/1-x", C5_GIT],
  ['"C:/Program Files/Git/bin/git.exe" push origin trunk', C5_GIT],
  ["gh.exe repo delete o/r", C5_GH],
  // A bundled short flag hid the method or the field from the api check.
  ["gh api -iX DELETE repos/o/r/git/refs/heads/trunk", C5_GH],
  ["gh api -iXPUT repos/o/r/pulls/14/merge", C5_GH],
  ["gh api -if labels[]=agent-migration-ok repos/o/r/issues/7/labels", C5_GH],
  ["gh api -X POST repos/o/r/issues/7/labels -f labels[]=x", C5_GH],
  ["gh api graphql -f query=@mutation.graphql", C5_GH],
  ["gh api graphql -F query=@q.graphql", C5_GH],
  // Escapes in the guard alone.
  ["gh pr -R o/r merge 14", C5_GH],
  ["gh issue --repo o/r edit 7 --body x", C5_GH],
  ["gh pr --repo=o/r merge 14", C5_GH],
  ["gh ext install owner/gh-nuke", C5_GH],
  ["gh cs delete", C5_GH],
  ["gh co 5", C5_GH],
  ["gh pr checkout 5", C5_GH],
  ["gh pr create --fill -lagent-migration-ok", C5_GH],
  ["git config Alias.p 'push --force'", /alias/i],
  ["GIT_CONFIG_PARAMETERS=\"'alias.p=push --force'\" git p", /environment assignment/],
  ["git -c include.path=/abs/file p", /-c include\.path/],
  ["git -c core.hooksPath=/tmp/h commit -m x", /-c core\.hooksPath/],
  ["git -c core.sshCommand=evil fetch origin", /-c core\.sshCommand/],
  ["git config --global core.hooksPath /tmp/h", /writes|would write/],
  ["git config --add alias.p push", /writes/],
  ["git config set alias.p push", /writes/],
  ["git pu''sh origin trunk", C5_GIT],
  ['git push origin agent/x:tru"nk"', C5_GIT],
  ["git push origin {trunk,release}", /shell syntax/],
  ["p=push; git $p origin trunk", /shell syntax/],
  ["git push origin agent/x:$(echo trunk)", /shell syntax/],
  ["git push origin agent/x:`echo trunk`", /shell syntax/],
  ['git commit -m "$(git push origin trunk)"', C5_GIT],
  ["git push origin 'refs/heads/*:refs/heads/*'", C5_GIT],
  // The guard's own files, and anything else under forbiddenPaths, through git.
  ["git rm tools/engine/guard.mjs", /forbidden path/],
  ["git checkout HEAD~1 -- tools/engine/guard.mjs", /forbidden path/],
  ["git restore --source=HEAD~1 .autoclaude/config.json", /forbidden path/],
  ["git mv src/x.ts tools/engine/x.ts", /forbidden path/],
  ["git checkout HEAD -- ../../tools/engine/guard.mjs", /outside the worktree/],
  // A program through fetch or ls-remote, the pathspecs that reach a forbidden file
  // without naming it, and the brace group.
  ['git fetch . --upload-pack="git push origin agent/x:trunk #"', C5_GIT],
  ["git fetch --upload-pack=evil origin", C5_GIT],
  ["git fetch origin --exec=evil", C5_GIT],
  ["git ls-remote -u 'git push origin trunk #' .", /-u/],
  ["git ls-remote --upload-pack evil origin", /upload-pack/],
  ["git checkout abc1234 -- tools", /covers a forbidden path/],
  ["git checkout abc1234 -- .", /covers a forbidden path/],
  ["git checkout abc1234 tools/engine/guard.mjs", /forbidden path/],
  ["git checkout HEAD~1 -- ':(top)tools/engine/guard.mjs'", /magic pathspec/],
  ["git checkout HEAD~1 -- ':(icase)TOOLS/ENGINE/GUARD.MJS'", /magic pathspec/],
  ["git checkout HEAD~1 -- ':(glob)tools/**/*.mjs'", /magic pathspec/],
  ["git checkout HEAD~1 -- 'tools/**/*.mjs'", /wildcard/],
  ["git restore --source=abc1234 tools", /covers a forbidden path/],
  ["git restore -s abc1234 -- .", /covers a forbidden path/],
  ["git rm -r tools", /covers a forbidden path/],
  ["git rm -r .", /covers a forbidden path/],
  ["git rm -r ':/tools/engine'", /magic pathspec/],
  ["git mv tools tools-old", /covers a forbidden path/],
  ["/usr/bin/git push origin trunk", C5_GIT],
  ["/mingw64/bin/git push origin trunk", C5_GIT],
  ["/c/Program\\ Files/Git/cmd/git.exe push origin trunk", C5_GIT],
  ["{ git push origin trunk; }", C5_GIT],
  ["f() { git push origin trunk; }; f", C5_GIT],
  ["git branch -Df trunk", /protected/],
  // A path that starts like the permitted prefix and leaves it, a path outside, and a test
  // file: none of them is the prefix `npx tsx tools/codegen.ts`, token for token.
  ["npx tsx tools/codegen.ts/../../evil.ts", FENCE],
  ["npx tsx /tmp/evil.ts", FENCE],
  ["npx tsx test/evil.ts", FENCE],
  // Nested shells and code runners, whatever they carry.
  ["sh -c 'git status'", /nested shell/],
  ['eval "git push origin trunk"', /nested shell/],
  ["node -e \"require('child_process').execSync('git push origin trunk')\"", /node -e/],
  ["node -p 'process.env'", /node -e/],
  // Two spellings of the same thing that a flag list alone reads as ordinary arguments:
  // `=` instead of a space, and the bundled pair. Both run code, and both are refused
  // because no permitted prefix starts that way.
  ["node --eval='process.exit(0)'", FENCE],
  ['node -pe "1+1"', FENCE],
  // A session that can hand `node` a path it chose can run a program it wrote, so every
  // node shape no prefix names stays refused. The loader with no script is the tsx REPL.
  ["node tools/engine/notes.ts note 5 'x'", FENCE],
  ["node dist/cli.mjs tools/engine/notes.ts show", FENCE],
  ["node node_modules/tsx/dist/cli.mjs", FENCE],
  ["node node_modules/tsx/dist/cli.mjs tools/other/x.ts", FENCE],
  ["node node_modules/tsx/dist/cli.mjs tools/engine/../../evil.ts", FENCE],
  // Segment by segment, like every other family: a permitted first segment does not carry
  // the second one through.
  ["autoclaude note 5 'x' && node -e \"x\"", /node -e/],
  // An assignment in front of the permitted shapes: `--require` preloads a file the
  // session may write in its worktree, and `autoclaude` is a node program too.
  ["NODE_OPTIONS=--require=./x.js autoclaude note 5 x", /environment assignment/],
  ["NODE_OPTIONS=--require=./x.js npx tsx tools/codegen.ts", /environment assignment/],
  ["find . -name '*.md' -exec git push origin trunk \\;", /find -exec/],
  ["timeout 30 git push origin trunk", C5_GIT],
  ["env GIT_DIR=/tmp/x git push origin agent/1-x", /environment assignment/],
  // A wrapper's own operand is not a flag: for `timeout 30 node …` a look-through that
  // knew only git and gh stopped on `30`, `30` became the program, and the segment fell
  // through to "allowed" while its unwrapped spelling was refused.
  ["timeout 30 node -e \"require('child_process')\"", /node -e runs code/],
  ['nice -n 10 node -e "1"', /node -e runs code/],
  ["timeout 5 node node_modules/tsx/dist/cli.mjs ../../evil.ts", FENCE],
  // And a wrapper that hides no fenced program at all is refused rather than waved
  // through: the operand may be the program (`sleep`), an operand of the wrapper, or a
  // spelling nothing here reads, and the guard cannot tell which — so it fails closed and
  // says which wrapper it could not see past.
  ["timeout 30 sleep 5", /wrapper \(timeout 30\) hides the program/],
  ["nohup bash -c 'git push origin trunk'", /hides the program|nested shell/],
  // A look-through that scans the whole segment for a fenced word never tests a shell
  // adjacent to the wrapper: the pointer moves off `bash` onto the permitted command
  // further along, the decision is made about that, and what runs is `bash -c evil`. The
  // look-through consumes the wrapper's own flags, their values and its numeric operand,
  // and then the next token *is* the program, whatever it is.
  ["env -i bash -c evil autoclaude note 5 x", /nested shell/],
  ["nohup bash -c evil autoclaude note 5 x", /nested shell/],
  ["exec bash -c evil autoclaude note 5 x", /nested shell/],
  ["command bash -c evil autoclaude note 5 x", /nested shell/],
  ["xargs -0 sh -c evil autoclaude note 5 x", /nested shell/],
  ["stdbuf -oL bash -c evil autoclaude note 5 x", /nested shell/],
  // The unwrapped spelling: the control that says the six rows above are about the
  // wrapper and not about the shell test itself.
  ["bash -c evil autoclaude note 5 x", /nested shell/],
  // And stacked, because one wrapper is consumed per step: the shell is still the token
  // the walk stops on, however many wrappers stand in front of it.
  ["xargs -n 1 bash -c evil autoclaude note 5 x", /nested shell/],
  ["timeout 30 env -i bash -c evil git fetch origin", /nested shell/],
  // An assignment between the wrapper and the program is collected too, so the
  // assignment fence fires behind a wrapper as well as in front of the program.
  ["timeout 30 GIT_DIR=/tmp/x git push origin agent/1-x", /environment assignment/],
  ["timeout 30 NODE_OPTIONS=--require=./x.js autoclaude note 5 x", /environment assignment/],
  // The wrapper's own argument grammar, which is what decides where the program is:
  // `timeout 5s` is a duration and not a program, `-k 5` takes its value with it, and
  // `sudo -u me` skips the user rather than reading it as the program.
  ["timeout 5s node -e 1", /node -e runs code/],
  ["timeout -k 5 30 node -e 1", /node -e runs code/],
  ["sudo -u me git push origin trunk", C5_GIT],
  /**
   * Three ways a git command reads or stages a file the session may not read.
   *
   * The settings deny `Read` and `Edit` on the `.env` files, and the file readers are
   * denied by name for walking around those — but three of git's verbs walk around them
   * too: `--no-index` diffs two paths outside the index and prints them, so `/dev/null`
   * against a secret is `cat` by another name; `git add -f` and `-N` override the ignore
   * rules that are the only thing keeping a secret out of the index, and from there it
   * rides into a commit; and `git stash push -u` stashes untracked files, which
   * `git stash show -p` then prints.
   */
  ["git diff --no-index /dev/null .env.local", /--no-index/],
  ["git diff --no-index --stat a b", /--no-index/],
  // The redirected spelling: the redirection check passes (`out.txt` is not fenced) and
  // the refusal is the diff's own.
  ["git diff --no-index /dev/null .env.local > out.txt", /--no-index/],
  ["git add -f .env.local", /ignore rules/],
  ["git add --force .env.local", /ignore rules/],
  ["git add -N .env.local", /ignore rules/],
  ["git add --intent-to-add .env.local", /ignore rules/],
  // Bundled, because a short flag is not always alone.
  ["git add -vf .env.local", /ignore rules/],
  // And the plain spelling, which only `.gitignore` refuses: the guard mirrors the deny
  // rules rather than trusting a file it does not read.
  ["git add .env.local", /a secret/],
  ["git add -- .env.local", /a secret/],
  ["git add src/x.ts .env.production", /a secret/],
  // Case folds on the file systems this guard runs on, so the spelling must not matter.
  ["git add .ENV.LOCAL", /a secret/],
  ["git add .Env", /a secret/],
  // `add` is one of the verbs whose pathspecs are checked against `forbiddenPaths`, so
  // the engine's own files cannot be staged by name any more than they can be removed.
  ["git add tools/engine/guard.mjs", /forbidden path/],
  ["git add -- .autoclaude/config.json", /forbidden path/],
  ["git stash push -u", /untracked/],
  ["git stash push --include-untracked", /untracked/],
  ["git stash -u", /untracked/],
  ["git stash push -a", /untracked/],
  ["git stash push --all", /untracked/],
  ["git stash save -u", /untracked/],
  ["git stash push -ku -m wip", /untracked/],
  // The rest of the allowlist edge.
  ["git reset --hard origin/trunk", /reset --hard/],
  ["git worktree lock .", /git worktree lock/],
  ["git clean -fdx", /git clean is not on the allowlist/],
  ["git pull origin trunk", C5_GIT],
  ["gh pr view 12 --web", C5_GH],
  ["gh browse", C5_GH],
  /**
   * Allowed in the source, refused here: each row is a command the source let through and
   * a listed change of the port now refuses, with the design section that changed it.
   */
  // Design C5: a stage pushes and fetches nothing; the engine fetches before every stage.
  ["git push -u origin agent/7-login-form", C5_GIT],
  ["git push origin agent/7-login-form", C5_GIT],
  ["git push -q origin agent/1-x:agent/1-x", C5_GIT],
  ["git push -u origin HEAD:agent/1-x", C5_GIT],
  ["git -c core.quotePath=false push -u origin agent/1-x", C5_GIT],
  ["git fetch origin trunk", C5_GIT],
  ["git fetch origin", C5_GIT],
  ["git fetch --prune origin", C5_GIT],
  ["timeout 30 git fetch origin", C5_GIT],
  // Design C5: a stage calls gh not at all; what it needs from the forge is prefetched.
  ["gh issue edit 7 --add-label agent-fix-1,agent-working", C5_GH],
  ["gh pr create --fill --label enhancement", C5_GH],
  ["gh pr create --fill", C5_GH],
  ["gh pr view 12 --json statusCheckRollup", C5_GH],
  ["gh pr checks 12", C5_GH],
  ["gh pr list --state open", C5_GH],
  ["gh issue view 7 --json title,body", C5_GH],
  ["gh issue edit 7 --add-label agent-working", C5_GH],
  ["gh issue edit 7 --remove-label agent-ready", C5_GH],
  ["gh issue edit 7 --add-label agent-working --remove-label agent-ready", C5_GH],
  ["gh issue comment 7 --body-file -", C5_GH],
  ["gh api repos/o/r/pulls/12", C5_GH],
  ["gh api repos/o/r/issues/7/timeline --paginate", C5_GH],
  ["gh run view 123 --log-failed", C5_GH],
  ["gh run list --branch agent/1-x --json databaseId", C5_GH],
  ["gh auth status", C5_GH],
  ["gh pr list --label agent-migration-ok --json number", C5_GH],
  ["gh issue list -l agent-migration-ok", C5_GH],
  ["gh api graphql -f query='query { viewer { login } }'", C5_GH],
  [
    'gh api graphql -f query=\'query($n: Int!) { repository(owner: "o", name: "r") { issue(number: $n) { title } } }\' -F n=7',
    C5_GH,
  ],
  ["gh api -X GET repos/o/r/issues -f state=open", C5_GH],
  ["gh api -iX GET rate_limit", C5_GH],
  ["gh api -H 'Accept: application/vnd.github+json' repos/o/r/pulls/12", C5_GH],
  // Design § 6 and C6: the engine's scripts became `autoclaude <verb>`, and publishing is
  // the engine's (C5), so the script that published is now a verb a stage may not run.
  ["autoclaude publish 7", FENCE],
  // Design C6: nothing runs through the tsx loader at run time, so the loader form of the
  // milestone note is gone; `autoclaude note` is what a stage runs instead.
  ["node node_modules/tsx/dist/cli.mjs tools/engine/notes.ts note 5 'x'", FENCE],
  ["node node_modules/tsx/dist/cli.mjs tools/ci/check.ts", FENCE],
  ["cd x && node node_modules/tsx/dist/cli.mjs tools/engine/notes.ts note 5 'x'", FENCE],
  // GuardConfig carries no branch names (the brief's interface), so the guard cannot tell
  // a protected branch from any other, and refuses deleting, moving or resetting every one
  // of them; branches and worktrees are the engine's to manage (design C5, § 7.4).
  ["git branch -D agent/1-x", /protected/],
];

const ALLOWED = [
  // A redirection to nowhere is not a write, and needs no config to decide.
  "npm run test:ci > /dev/null 2>&1",
  "npx vitest run test/ 2>&1",
  "echo x > notes.txt",
  'find . -name "*.ts"',
  "git --no-pager log -1 --format=%s",
  "git status && git diff",
  "git commit -m 'fix: keep accents; do not push --force'",
  "git branch --show-current",
  "npm run test:ci",
  // Quoted text is data, decided by the command it is an argument of: a note that names a
  // refused command does not run it.
  'autoclaude note 7 "git push origin trunk refused"',
  "autoclaude note 5 'gh pr merge is a human action'",
  // The events log, written in single quotes as the standing rule says.
  "autoclaude note 5 'x'",
  "git commit -m 'feat: x' -m 'The body mentions git push --force origin trunk and gh pr merge.'",
  "git commit -F - <<'EOF'\nfeat: x\n\ngit push origin trunk is refused by the guard.\nEOF",
  "git.exe status",
  "git add *.ts",
  "git add -A && git commit -m 'x' > /dev/null 2>&1",
  "git config --get user.name",
  "git config user.name",
  "git config --list",
  "git worktree add /tmp/x origin/trunk",
  "git worktree remove --force /tmp/x",
  "git worktree prune",
  "git checkout -b agent/2-y",
  "git checkout -- src/x.ts",
  "git rm src/x.ts",
  "git rebase origin/trunk",
  "git rebase --continue",
  "git log origin/trunk..HEAD --oneline",
  "git diff --name-only origin/trunk...HEAD -- 'tests/**' 'src/**/*.test.ts'",
  "git rev-parse --show-toplevel",
  "git worktree list --porcelain",
  "git ls-remote --heads origin agent/1-x",
  "command -v git",
  "echo git push origin trunk",
  // Returning to the index is not a rollback.
  "git checkout -- .",
  "git restore .",
  "git restore --staged src/x.ts",
  "git checkout agent/2-y",
  "git checkout abc1234 -- src/x.ts",
  "git rm -r src/old",
  "git mv src/a.ts src/b.ts",
  // The positive controls for the three refusals above: the everyday staging, the diffs
  // that read the index and the history, and the stash forms that touch nothing untracked.
  // Without these, refusing `git add`, `git diff` and `git stash` outright would pass.
  "git add -A",
  "git add src/x.ts",
  "git add -p",
  "git add -n src/x.ts",
  "git add src/x.ts .env.example",
  "git diff origin/trunk...HEAD",
  "git diff --cached",
  "git stash push -m wip",
  "git stash show -p",
  "git stash list",
  "git stash pop",
  "git ls-files --others",
  // The positive controls for the wrapper rule above: the look-through still finds the
  // fenced program behind the wrapper and decides from there, so a read stays a read.
  // Without these rows, refusing every wrapped command would pass the block above. The
  // source's control was `timeout 30 git fetch origin`, which a stage may not run any more
  // (design C5); `git status` keeps the control.
  "timeout 30 git status",
  // Each of the argument shapes the wrapper walk has to know: a value-taking short flag
  // (`nice -n 10`, `xargs -n 1`), a long one (`env -u PATH`), and a wrapper in front of
  // the permitted engine verb and of any other `npx` program, which the guard leaves to
  // the permission layer.
  "nice -n 10 git status",
  "xargs -n 1 git status",
  "env -u PATH git status",
  "timeout 30 autoclaude note 5 x",
  "timeout 30 npx vitest run test/",
  // A shell keyword is not a wrapper with operands — after `then` or `{` the next token is
  // the program itself — so the fail-closed refusal must not reach the compound commands
  // the sessions actually write.
  "if git diff --quiet; then npm run test:ci; fi",
  "command -v git && git status",
];

/**
 * The decision, asked in one process. The hook's contract — exit 2, fail-closed — is
 * tested on `claudeHook` in hook-claude.test.ts; everything here is about what the guard
 * decides, which is pure and does not need a process each.
 */
/** What the batch decided about one command: a refusal, an allow, or a crash. */
type Verdict = { reason: string | null; threw: string | null };

function decide(commands: string[]): Map<string, Verdict> {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      REGISTER,
      "--disable-warning=ExperimentalWarning",
      BATCH,
    ],
    {
      input: JSON.stringify({ config: FIXTURE, commands }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (r.status !== 0) throw new Error(`guard-batch failed (${r.status}): ${r.stderr}`);
  const rows = JSON.parse(r.stdout) as Array<{ command: string } & Verdict>;
  return new Map(rows.map((x) => [x.command, { reason: x.reason, threw: x.threw }]));
}

/**
 * A crash is not a refusal.
 *
 * A driver that renders a throw as `reason: "the guard itself failed: …"` makes it truthy,
 * so a tokeniser change that made a family of respellings throw would leave every one of
 * those rows green on an exception string. Every assertion below goes through here first.
 */
function ran(v: Verdict | undefined, command: string): Verdict {
  expect(v, `${command} was never decided`).not.toBeUndefined();
  expect((v as Verdict).threw, `${command} crashed the guard`).toBeNull();
  return v as Verdict;
}

const BOOLEAN_OPTIONS = new Set(["--global", "--add", "--hard", "--force", "--fill", "--squash"]);

function respellings(cmd: string): string[] {
  const out = new Set<string>();
  out.add(cmd.replace(/\b(git|gh) /g, "$1.exe "));
  out.add(`ENV=1 ${cmd}`);
  out.add(cmd.replace(/\b(git|gh) (\S\S)/, "$1 $2''"));
  // Only for options that take a value: `--global=x` or `--hard=x` is a different, broken
  // command that git itself rejects, not a respelling.
  out.add(
    cmd.replace(/(--[a-z-]+) (?!-)(\S+)/g, (m, opt: string, val: string) =>
      BOOLEAN_OPTIONS.has(opt) ? m : `${opt}=${val}`,
    ),
  );
  out.add(cmd.replace(/\bgh ([a-z]+) /, "gh $1 -R o/r "));
  out.add(cmd.replace(/agent-migration-ok/g, "AGENT-MIGRATION-OK"));
  out.add(
    cmd
      .replace(/origin (trunk|release)\b/, "origin heads/$1")
      .replace(/:(trunk|release)\b/, ":heads/$1"),
  );
  out.add(cmd.replace(/(--[a-z-]+ \S+)/, "$1 $1"));
  out.add(cmd.replace(/\b(git|gh) /, "/usr/bin/$1 "));
  out.add(`{ ${cmd}; }`);
  out.delete(cmd);
  return [...out];
}

/** Computed once. */
const RESPELLINGS = new Map(BLOCKED.map(([cmd]) => [cmd, respellings(cmd)] as const));

/**
 * Every command in this file, decided by one spawn, and that spawn happens in a hook.
 *
 * In the describe callbacks it would run during collection: a batch that threw would fail
 * the whole file's collection rather than a test, and a broken guard would read in CI as a
 * guard with no tests.
 */
describe("command guard, every command decided in one batch", () => {
  let verdicts = new Map<string, Verdict>();

  beforeAll(() => {
    verdicts = decide([
      ...BLOCKED.map(([cmd]) => cmd),
      ...ALLOWED,
      ...[...RESPELLINGS.values()].flat(),
    ]);
  });

  describe("blocks the absolute limits", () => {
    for (const [cmd, reason] of BLOCKED) {
      it(`blocks: ${cmd}`, () => {
        const got = ran(verdicts.get(cmd), cmd);
        expect(got.reason, `${cmd} was allowed`).toBeTruthy();
        expect(got.reason as string).toMatch(reason);
      });
    }
  });

  describe("lets ordinary work through", () => {
    for (const cmd of ALLOWED) {
      it(`allows: ${cmd}`, () => {
        // `ran` refuses the undefined case: turning a command the batch never decided into
        // null would make a dropped row, a key that failed to round-trip through JSON and a
        // truncated stdout all read as "allowed".
        expect(ran(verdicts.get(cmd), cmd).reason, `${cmd} was refused`).toBeNull();
      });
    }
  });

  // One case per blocked row: the table is the list of spellings someone thought of,
  // these are the rest.
  describe("keeps a blocked command blocked under respelling", () => {
    for (const [cmd] of BLOCKED) {
      const variants = RESPELLINGS.get(cmd) as string[];
      it(`stays blocked under ${variants.length} respellings: ${cmd}`, () => {
        for (const v of variants) {
          expect(ran(verdicts.get(v), v).reason, `${v} was allowed`).toBeTruthy();
        }
      });
    }
  });
});

describe("the port's own rules", () => {
  it("refuses gh in a stage", () => {
    expect(refusalFor("gh issue view 3", cfg)).toMatch(/engine prefetches/);
  });

  it.each(["git fetch origin develop", "git pull", "git push origin HEAD", "git remote add x y"])(
    "refuses %s",
    (c) => expect(refusalFor(c, cfg)).not.toBeNull(),
  );

  // Through every spelling the tokeniser already looks through: a permitted global option,
  // the global options that are refused anyway, wrappers, keywords and a nested shell.
  it.each([
    "git -c core.quotePath=false fetch origin",
    "git -c user.name=x pull",
    "git --no-pager remote -v",
    "git -C /elsewhere push origin HEAD",
    "git --git-dir=/elsewhere/.git fetch",
    "timeout 30 git pull origin trunk",
    "env -u PATH git remote update",
    "sudo -u me git fetch",
    "{ git remote set-url origin x; }",
    "if true; then git pull; fi",
    'bash -c "git fetch origin"',
    "git.exe pull",
    "/usr/bin/git remote add x y",
    "git pu''ll",
    'git commit -m "$(git push origin HEAD)"',
  ])("refuses the forge verbs however they are spelled: %s", (c) => {
    expect(refusalFor(c, cfg)).not.toBeNull();
  });

  it("allows autoclaude note and gates, and the project's fence.allow prefixes", () => {
    expect(refusalFor("autoclaude note 7 'tests red a.test.ts'", cfg)).toBeNull();
    // Ruling R38: the prefix is tried on a program the guard fences, so the test tells an
    // allow from a refusal — refused without the prefix, allowed with it, and a longer
    // token than the prefix's stays refused.
    const migration = "node scripts/new-migration.js add_x";
    expect(refusalFor(migration, { ...cfg, fenceAllow: [] })).toMatch(FENCE);
    const allow = { ...cfg, fenceAllow: ["node scripts/new-migration.js"] };
    expect(refusalFor(migration, allow)).toBeNull();
    expect(refusalFor("node scripts/new-migration.jsx add_x", allow)).toMatch(FENCE);
    // Ruling R7's example: `npx` with any program but tsx is not fenced by the guard at all,
    // prefix or not (ruling R38); Claude Code's permission layer refuses it without an allow
    // rule, which is where `fence.allow` opens it.
    expect(refusalFor("npx dbtool migration new add_x", { ...cfg, fenceAllow: [] })).toBeNull();
    expect(refusalFor("autoclaude gates", cfg)).toBeNull();
    expect(refusalFor("autoclaude gates --fix lint", cfg)).toBeNull();
    expect(refusalFor("cd x && autoclaude note 5 'x'", cfg)).toBeNull();
    expect(refusalFor("{ autoclaude note 5 x; }", cfg)).toBeNull();
    expect(refusalFor("npx tsx tools/codegen.ts --out src/gen.ts", cfg)).toBeNull();
    expect(
      refusalFor("node tools/gen.mjs", { ...cfg, fenceAllow: ["node tools/gen.mjs"] }),
    ).toBeNull();
  });

  it("refuses every other engine verb", () => {
    for (const c of [
      "autoclaude publish 7",
      "autoclaude merge 12",
      "autoclaude guard --runtime claude",
      "autoclaude",
      "autoclaude --help",
      "autoclaude notes 5 x",
      "autoclaude gate",
      "timeout 30 autoclaude publish 7",
      "/usr/local/bin/autoclaude publish 7",
      // Through a package runner, which reads its own flags and verb before the command.
      "npx autoclaude publish 7",
      "npx autoclaude@1 merge 12",
      "npx @scope/autoclaude publish 7",
      "npx --yes autoclaude publish 7",
      "npx -p autoclaude autoclaude publish 7",
      "npx -p other autoclaude publish 7",
      "npx --package=autoclaude autoclaude merge 12",
      "npm exec autoclaude publish 7",
      "npm exec -- autoclaude publish 7",
      "npm x autoclaude publish 7",
      "npm --prefix x exec autoclaude publish 7",
      "pnpm exec autoclaude publish 7",
      "pnpm dlx autoclaude publish 7",
      "pnpm -C dir exec autoclaude publish 7",
      "pnpx autoclaude publish 7",
      "yarn dlx autoclaude publish 7",
      "yarn autoclaude publish 7",
      "yarn run autoclaude publish 7",
      "bunx autoclaude publish 7",
      "bun x autoclaude publish 7",
      "timeout 30 npx autoclaude publish 7",
      // Even the permitted verbs: a runner may fetch a package of that name instead.
      "npx autoclaude note 5 x",
      "npx -y autoclaude gates",
    ])
      expect(refusalFor(c, cfg), c).toMatch(FENCE);
  });

  it("does not let a package runner run a fenced interpreter, or a shell string", () => {
    for (const c of [
      "npx --yes tsx evil.ts",
      "npx -p tsx tsx evil.ts",
      "npx tsx@4 evil.ts",
      "npm exec tsx evil.ts",
      "pnpm dlx tsx evil.ts",
      "npx node -e x",
      "npm exec node evil.js",
      "yarn node evil.js",
    ])
      expect(refusalFor(c, cfg), c).toMatch(FENCE);
    for (const c of [
      "npx -c 'autoclaude publish 7'",
      "npx --call='git push origin HEAD'",
      "npm exec -c 'autoclaude merge 12'",
      "npm exec --call 'x'",
      "pnpm exec --shell-mode 'autoclaude publish 7'",
      "pnpm dlx -c 'x'",
    ])
      expect(refusalFor(c, cfg), c).toMatch(/runs a shell command the guard cannot read/);
    // A command the runner names from the shell is no command the guard can read.
    expect(refusalFor("npx $PKG publish", cfg)).toMatch(/which the shell decides/);
    // The plain `npx tsx` shape is still the fence's own, and the runner's other commands
    // are its business: nothing past the command is read.
    expect(refusalFor("npx tsx tools/codegen.ts", cfg)).toBeNull();
    for (const c of [
      "npx vitest run test/autoclaude",
      "npx --yes vitest run",
      "npm test",
      "npm run build",
      "npm install --save-dev autoclaude",
      "yarn add -D tsx",
      "pnpm exec vitest run",
    ])
      expect(refusalFor(c, cfg), c).toBeNull();
  });

  it("matches a prefix on whole tokens, never on a part of one", () => {
    const allow = { ...cfg, fenceAllow: ["npx tsx tools/gen.ts", "node tools/gen.mjs"] };
    expect(refusalFor("npx tsx tools/gen.ts", allow)).toBeNull();
    expect(refusalFor("npx tsx tools/gen.ts --check", allow)).toBeNull();
    // A longer token is another token.
    expect(refusalFor("npx tsx tools/gen.tsx", allow)).toMatch(FENCE);
    expect(refusalFor("node tools/gen.mjsx", allow)).toMatch(FENCE);
    expect(refusalFor("node tools/gen.mjs.evil", allow)).toMatch(FENCE);
    // A shorter one too: the prefix is all of its tokens.
    expect(refusalFor("npx tsx tools", allow)).toMatch(FENCE);
    expect(refusalFor("node", allow)).toMatch(FENCE);
    // Another path to "the same" file is not the prefix.
    expect(refusalFor("node ./tools/gen.mjs", allow)).toMatch(FENCE);
    // The tokeniser splits operators off first, so what follows a permitted prefix is a
    // segment of its own and decided as one.
    expect(refusalFor("node tools/gen.mjs; node -e evil", allow)).toMatch(/node -e/);
    expect(refusalFor("node tools/gen.mjs&&npx tsx evil.ts", allow)).toMatch(FENCE);
    // Quotes concatenate like the shell's: these are the prefix's own tokens.
    expect(refusalFor("node 'tools/gen.mjs'", allow)).toBeNull();
    expect(refusalFor('autoclaude "note" 5 x', cfg)).toBeNull();
  });

  // The shell decides what a dynamic token becomes. `$(printf 'publish 7 ')note` reads as
  // `note` with the substitution dropped, and runs `autoclaude publish 7 note`; so a token
  // the shell still expands never counts as one of the prefix's own.
  it("does not let a token the shell expands stand in for a prefix token", () => {
    for (const c of [
      "autoclaude $(printf 'publish 7 ')note",
      "autoclaude `printf publish`note 7",
      "autoclaude no${X}te 5 x",
      "autoclaude $VERB 5 x",
      "autoclaude {note,publish} 5",
      "node tools/gen.mjs$(printf ' -e evil')",
    ])
      expect(refusalFor(c, { ...cfg, fenceAllow: ["node tools/gen.mjs"] }), c).not.toBeNull();
    // What follows the prefix is the command's own business.
    expect(refusalFor('autoclaude note 5 "$NOTE"', cfg)).toBeNull();
  });

  it("keeps the interpreter's eval forms refused whatever fence.allow says", () => {
    const loose = { ...cfg, fenceAllow: ["node", "npx tsx"] };
    expect(refusalFor("node -e 'x'", loose)).toMatch(/node -e runs code/);
    expect(refusalFor("node --print 1", loose)).toMatch(/node -e runs code/);
    expect(refusalFor("npx tsx -e 'x'", loose)).toMatch(/runs code the guard cannot read/);
    expect(refusalFor("npx tsx --eval 'x'", loose)).toMatch(/runs code the guard cannot read/);
  });

  it("does not let fence.allow open git, gh, a shell or a wrapper's hidden program", () => {
    const wide = {
      ...cfg,
      fenceAllow: ["git push", "gh issue view", "bash scripts/x.sh", "timeout 5 sleep"],
    };
    expect(refusalFor("git push origin HEAD", wide)).toMatch(C5_GIT);
    expect(refusalFor("gh issue view 3", wide)).toMatch(C5_GH);
    expect(refusalFor("bash scripts/x.sh", wide)).toMatch(/nested shell/);
    expect(refusalFor("timeout 5 sleep 1", wide)).toMatch(/hides the program/);
  });

  // Review Focus 2: text a stranger wrote on GitHub, carrying shell syntax and option-like
  // tokens, must never be interpreted.
  describe("GitHub-controlled text", () => {
    const TITLE = "Fix login & logout --replace $(rm -rf ~) `id`";

    it("is refused inside bash -c, however it is quoted", () => {
      for (const c of [
        `bash -c "autoclaude note 7 '${TITLE}'"`,
        `bash -c 'autoclaude note 7 "${TITLE}"'`,
        `sh -c "${TITLE}"`,
        `env -i bash -c '${TITLE}'`,
      ])
        expect(refusalFor(c, cfg), c).toMatch(/nested shell/);
    });

    it("is one data token in single quotes: no operator splits it, no substitution runs", () => {
      // `&` would end the segment and `$( )` and backticks would open their own: had any of
      // them been read as syntax, the fenced commands below would be found and refused.
      const fenced = "Fix login & gh pr merge 1 --replace $(git push origin HEAD) `node -e x`";
      expect(refusalFor(`autoclaude note 7 '${fenced}'`, cfg)).toBeNull();
      expect(refusalFor(`git commit -m '${fenced}'`, cfg)).toBeNull();
      expect(refusalFor(`autoclaude note 7 '${TITLE}'`, cfg)).toBeNull();
    });

    it("has its substitutions decided as commands of their own when they are not quoted away", () => {
      // In double quotes the shell runs `$( )` and backticks, and the guard reads each of
      // them as a segment: a forge call or an interpreter inside is refused.
      expect(refusalFor('autoclaude note 7 "Fix $(git push origin HEAD)"', cfg)).toMatch(C5_GIT);
      expect(refusalFor('autoclaude note 7 "Fix `gh pr merge 1`"', cfg)).toMatch(C5_GH);
      expect(refusalFor('git commit -m "Fix $(node -e x)"', cfg)).toMatch(/node -e/);
      // And unquoted, `&` ends the segment, so what follows it is a command of its own.
      expect(refusalFor("autoclaude note 7 Fix login & git push origin HEAD", cfg)).toMatch(C5_GIT);
    });
  });

  describe("its config", () => {
    it("is required", () => {
      expect(() => refusalFor("npm test", null as unknown as GuardConfig)).toThrow(
        /needs the guard config/,
      );
    });

    // A missing field must not read as an empty fence: an absent `forbiddenPaths` that
    // became `[]` would let `git rm` on the engine's own files through.
    it.each([
      [{ fenceAllow: [], worktree: "/w", platform: "linux" }, /missing forbiddenPaths/],
      [{ forbiddenPaths: [], worktree: "/w", platform: "linux" }, /missing fenceAllow/],
      [{ forbiddenPaths: [], fenceAllow: [], platform: "linux" }, /missing worktree/],
      [
        { forbiddenPaths: "tools/**", fenceAllow: [], worktree: "/w", platform: "linux" },
        /missing forbiddenPaths/,
      ],
      [
        { forbiddenPaths: [1], fenceAllow: [], worktree: "/w", platform: "linux" },
        /missing forbiddenPaths/,
      ],
      [
        { forbiddenPaths: [], fenceAllow: [null], worktree: "/w", platform: "linux" },
        /missing fenceAllow/,
      ],
      // Every path is placed against the worktree, so it has to be one the guard can place.
      [
        { forbiddenPaths: [], fenceAllow: [], worktree: "work/tree", platform: "linux" },
        /missing worktree \(an absolute path\)/,
      ],
      [
        { forbiddenPaths: [], fenceAllow: [], worktree: "/work/tree", platform: "win32" },
        /missing worktree \(an absolute path\)/,
      ],
      [{ forbiddenPaths: [], fenceAllow: [], worktree: "/w", platform: 7 }, /missing platform/],
    ])("refuses a git command when it is malformed: %j", (bad, why) => {
      expect(() => refusalFor("git rm tools/engine/x.ts", bad as unknown as GuardConfig)).toThrow(
        why,
      );
    });

    it("is read only where a decision needs it", () => {
      const bad = {} as unknown as GuardConfig;
      expect(refusalFor("npm test", bad)).toBeNull();
      expect(refusalFor("autoclaude note 5 x", bad)).toBeNull();
      expect(() => refusalFor("echo x > out.txt", bad)).toThrow(/missing .*forbiddenPaths/);
      expect(() => refusalFor("node tools/gen.mjs", bad)).toThrow(/missing .*fenceAllow/);
    });

    it("is not kept between calls", () => {
      expect(refusalFor("git rm tools/engine/x.ts", cfg)).toMatch(/forbidden path/);
      expect(refusalFor("git rm tools/engine/x.ts", { ...cfg, forbiddenPaths: [] })).toBeNull();
      expect(() => refusalFor("git rm tools/engine/x.ts", {} as unknown as GuardConfig)).toThrow();
    });
  });
});

/**
 * Hardening beyond the four changes (ruling R37; design § 7.5, "the hook fails closed",
 * and the anti-goal of a model holding write power over the forge). Each block is one of
 * the ruling's items; every refusal above is still made.
 */
describe("hardening (ruling R37)", () => {
  const SHELL_DECIDES = /decided by the shell/;
  const DANGER = /hands the command to a split string, a shell or another directory/;
  const LEAVES = /leaves the worktree/;
  const UNPLACED = /goes where the shell decides/;
  const FORBIDDEN = /forbidden path/;
  const MOVE = /stay inside the worktree/;
  const RESET = /resets the branch it names/;
  const no = (c: string, why: RegExp, c2 = cfg) => expect(refusalFor(c, c2), c).toMatch(why);
  const yes = (c: string, c2 = cfg) => expect(refusalFor(c, c2), c).toBeNull();

  it("(a) refuses a program the shell decides: an expansion, a substitution or a glob", () => {
    for (const c of [
      "$(echo git) push origin HEAD",
      "g=git; $g push origin HEAD",
      "`printf gh` pr merge 1",
      "$'git' push origin HEAD",
      "/usr/bin/g?t push origin HEAD",
      "/usr/bin/nod[e] -e x",
      "/usr/bin/gi* push origin HEAD",
      '"$GIT" push origin HEAD',
      "~/bin/git push origin HEAD",
      "{git,x} push origin HEAD",
      "timeout 30 $CMD",
      // Read as typed, these would be a wrapper or an assignment; the shell makes them a
      // command line of its own: `env bash -c evil`, `git push origin HEAD x=1`.
      "env$(printf ' bash -c evil')",
      "time$(printf ' git push origin HEAD')",
      "$(printf 'git push origin HEAD ')x=1",
    ])
      no(c, SHELL_DECIDES);
    // An assignment's value may be anything; a lone `[` is the test command, and a glob
    // in an argument is the argument's business.
    yes("dir=$(pwd)");
    yes("x=$(git rev-parse HEAD); echo $x");
    yes("[ -f x ] && echo y");
    yes("test -f x && echo '*'");
    yes("echo *.ts");
    yes("{ git status; }");
  });

  it("(b) refuses wrapper flags that hand the command on: env -S, env -C, sudo -s and their kin", () => {
    for (const c of [
      "env -S 'bash -c evil' git status",
      "env --split-string='bash -c evil' git status",
      "env --split='bash -c evil' git status",
      "env -iS 'bash -c evil' git status",
      "env -u X -S 'bash -c evil' git status",
      "timeout 5 env -S 'bash -c evil' git status",
      "env -C /elsewhere git rm x",
      "env --chdir=/elsewhere git status",
      "sudo -s git log '$(evil)'",
      "sudo -i git status",
      "sudo --shell git status",
      "sudo -D /elsewhere git status",
      "doas -s git status",
    ])
      no(c, DANGER);
    yes("env -u PATH git status");
    yes("env -uSOMEVAR git status");
    yes("sudo -u me git status");
  });

  describe("(c) redirections land inside the worktree", () => {
    it("refuses a write outside it, into a forbidden path, or where the shell decides", () => {
      for (const c of [
        "echo x > /tmp/x",
        "echo x > /work/tree/../x",
        "echo x > /work/treehouse/x",
        "echo x &>> /tmp/log",
        "true && > /tmp/x",
        "exec 3<> /tmp/x",
        "echo x 2> /tmp/err",
        "npm test >& /tmp/out",
        "echo x >| /tmp/x",
      ])
        no(c, LEAVES);
      for (const c of [
        "echo x > /work/tree/tools/engine/x.ts",
        // `&>` was read as the operator `&`, and its write fell into an empty segment.
        "echo x &> tools/engine/x.ts",
        // A redirection with no command still truncates the file.
        "> tools/engine/x.ts",
        "true && > tools/engine/x.ts",
      ])
        no(c, FORBIDDEN);
      for (const c of [
        "echo x > ~/.bashrc",
        'echo x > "$HOME/.bashrc"',
        "echo x > $(echo f)",
        "echo x > `echo f`",
        "echo x > tools/eng*/x.ts",
        "echo x > tools/{e..e}ngine/x.ts",
      ])
        no(c, UNPLACED);
    });

    it("allows a write inside it, the null device and descriptor duplications", () => {
      for (const c of [
        "echo x > /work/tree/notes.txt",
        "echo x > ./notes.txt",
        "echo x >> sub/notes.txt",
        "npm test >&2",
        "npm test 2>&1 | tee out.txt",
        "npm test >&-",
        "npm test >& out.txt",
        "npm test &> /dev/null",
        "npm test > /dev/null 2> /dev/stderr",
        "cat < /etc/hosts",
      ])
        yes(c);
    });

    // Review Focus 1: a path with a space and a non-ASCII character.
    it("places Windows paths in every spelling Git Bash accepts, with case folded", () => {
      const win: GuardConfig = {
        ...cfg,
        worktree: "C:\\Users\\Jürgen Müller\\My Projects\\app",
        platform: "win32",
      };
      for (const c of [
        'echo x > "C:/Users/Jürgen Müller/My Projects/app/notes.txt"',
        'echo x > "c:\\users\\jürgen müller\\my projects\\APP\\notes.txt"',
        'echo x > "/c/Users/Jürgen Müller/My Projects/app/notes.txt"',
        "echo x > notes.txt",
      ])
        yes(c, win);
      no('echo x > "C:/Users/Jürgen Müller/My Projects/app/TOOLS/Engine/x.ts"', FORBIDDEN, win);
      no("echo x > TOOLS/ENGINE/x.ts", FORBIDDEN, win);
      for (const c of [
        'echo x > "D:/elsewhere/x"',
        "echo x > /tmp/x",
        'echo x > "C:x"',
        'echo x > "//server/share/x"',
        'echo x > "C:/Users/Jürgen Müller/My Projects/app2/x"',
      ])
        no(c, LEAVES, win);
      // The worktree itself may come in the Git Bash spelling.
      yes('echo x > "C:/Users/Jürgen Müller/My Projects/app/a"', {
        ...win,
        worktree: "/c/Users/Jürgen Müller/My Projects/app",
      });
    });

    it("folds case on macOS, and not on Linux, whose file systems tell the cases apart", () => {
      const mac: GuardConfig = {
        ...cfg,
        worktree: "/Users/jürgen/My Projects/app",
        platform: "darwin",
      };
      yes('echo x > "/users/JÜRGEN/my projects/app/x"', mac);
      no("echo x > TOOLS/ENGINE/x.ts", FORBIDDEN, mac);
      yes("echo x > TOOLS/ENGINE/x.ts");
      no('echo x > "/Work/Tree/x"', LEAVES);
    });
  });

  describe("(d) cd and pushd stay inside the worktree", () => {
    it("refuses a move outside it, or one the guard cannot follow", () => {
      for (const c of [
        "cd /tmp",
        "cd ..",
        "cd -- /tmp",
        "cd -P /tmp",
        "cd /work/tree/../other",
        "cd /work/treehouse",
        "cd sub && cd ../..",
        "cd",
        "cd ~",
        "cd ~/x",
        "cd -",
        'cd "$HOME"',
        "cd $(git rev-parse --show-toplevel)",
        "pushd /tmp",
        "pushd",
        "pushd +1",
        "popd",
        "pushd sub && popd && popd",
        // A relative move that may run more than once lands somewhere new each time.
        "for d in a b; do cd sub; done",
        "while true; do cd sub; done",
        "f() { cd sub; }; f; f",
      ])
        no(c, MOVE);
    });

    it("allows a move inside it", () => {
      for (const c of [
        "cd sub && npm test",
        "cd /work/tree/sub && npm test",
        "cd /work/tree",
        "cd .",
        "cd -P sub",
        "pushd sub && npm test && popd",
        "for f in a b; do echo $f; done && cd /work/tree/sub",
        "cd sub && echo x > notes.txt",
      ])
        yes(c);
    });

    it("places every later path from each directory the shell may stand in", () => {
      no("cd tools && echo x > engine/x.ts", FORBIDDEN);
      no("cd tools && git rm engine/guard.mjs", FORBIDDEN);
      no("cd tools; git checkout abc1234 -- engine", /covers a forbidden path/);
      // The subshell's `cd` does not move the shell, and the guard keeps both places.
      no("(cd sub); echo x > tools/engine/x.ts", FORBIDDEN);
      no("(cd tools); echo x > engine/x.ts", FORBIDDEN);
    });

    it("places git's own pathspecs: absolute ones, and magic ones for every verb", () => {
      no("git rm /work/tree/tools/engine/guard.mjs", FORBIDDEN);
      no("git rm /elsewhere/x", /outside the worktree/);
      no("git add ':/tools/engine/guard.mjs'", /magic pathspec/);
      no("git add ':(top)tools/engine/guard.mjs'", /magic pathspec/);
      yes("git rm /work/tree/src/x.ts");
      yes("git add src/x.ts");
    });

    it("starts where the caller says the shell stands", () => {
      const inTools = "/work/tree/tools";
      expect(refusalFor("echo x > engine/x.ts", cfg, inTools)).toMatch(FORBIDDEN);
      expect(refusalFor("git rm engine/guard.mjs", cfg, inTools)).toMatch(FORBIDDEN);
      expect(refusalFor("git status", cfg, inTools)).toBeNull();
      expect(refusalFor("echo x > engine/x.ts", cfg)).toBeNull();
      // Outside the worktree: git would work on another checkout, and a relative write
      // lands outside; a command with no path in it is not the guard's to place.
      const outside = "/elsewhere";
      expect(refusalFor("git status", cfg, outside)).toMatch(/outside the worktree/);
      expect(refusalFor("echo x > a.txt", cfg, outside)).toMatch(LEAVES);
      expect(refusalFor("cd sub", cfg, outside)).toMatch(MOVE);
      expect(refusalFor("echo x > /work/tree/a.txt", cfg, outside)).toBeNull();
      expect(refusalFor("npm test", cfg, outside)).toBeNull();
      expect(() => refusalFor("npm test", cfg, 7 as unknown as string)).toThrow(/as a string/);
    });
  });

  it("(e) refuses checkout -B, switch -C and worktree add -B, as branch -f is", () => {
    for (const c of [
      "git checkout -B trunk origin/trunk",
      "git checkout -qB trunk",
      "git switch -C trunk",
      "git switch --force-create trunk",
      "git switch --force-c trunk",
      "git switch --force-create=trunk",
      "git worktree add -B trunk /tmp/x origin/trunk",
    ])
      no(c, RESET);
    yes("git switch -c agent/2-y");
    yes("git switch agent/2-y");
    yes("git checkout -b agent/2-y");
    // After `--` the word is a path, whatever it looks like.
    yes("git checkout -- -Bfile");
    yes("git worktree add /tmp/x origin/trunk");
  });
});
