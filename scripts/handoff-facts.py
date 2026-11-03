#!/usr/bin/env python3
"""Emit the mechanically derivable parts of a handoff.

Everything here is a fact about the repo, the session, or the filesystem.
Nothing here requires judgement, so nothing here should be reconstructed by a
model from a transcript: that is both slower and the place where SHAs, paths
and file lists get subtly wrong.

Usage:
  handoff-facts.py [--session-id UUID] [--json]

--session-id is the UUID from the scratchpad directory path in the agent's
environment. When given it wins over filesystem detection, because another
session in the same project may have written more recently.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

# Commands whose successful invocation makes them a verification candidate.
# Extensions we accept as real files. Without this, the redirection pattern
# below matches shell comparison operators inside heredoc'd code, turning
# `values[n] > t.usage.cache_read_input_tokens` into a "file touched".
FILE_EXT = (
    "py ts tsx js jsx json md sh bash zsh txt yml yaml toml ini cfg sql html "
    "css scss go rs rb java kt swift c h cpp hpp xml csv jsonl lock env"
).split()
EXT_RE = "|".join(FILE_EXT)

# Files a Bash command wrote. Edits do not always come from the Edit tool:
# heredocs, `sed -i`, `tee` and plain redirection are all common, and a
# tool-call-only view of "files touched" misses every one of them.
BASH_WRITE = [
    re.compile(r">>?\s*['\"]?([\w./~$-]+\.(?:" + EXT_RE + r"))\b"),
    re.compile(r"\bsed\s+-i\b[^|;&]*?['\"]?([\w./~$-]+\.(?:" + EXT_RE + r"))\b"),
    re.compile(r"\btee\s+(?:-a\s+)?['\"]?([\w./~$-]+\.(?:" + EXT_RE + r"))\b"),
]

# Files a Bash command read. `cat`, `sed -n`, `head` and `less` are how a file
# gets read when the Read tool is not the tool in use.
BASH_READ = re.compile(
    r"\b(?:cat|less|head|tail|bat)\s+(?:-\S+\s+)*['\"]?([\w./~$-]+\.(?:"
    + EXT_RE + r"))\b"
)

# Commands whose successful invocation makes them a verification candidate.
TEST_HINT = re.compile(
    r"\b(pytest|vitest|jest|npm (run )?(test|lint|build)|pnpm (run )?(test|lint|build)"
    r"|yarn (test|lint|build)|go test|cargo test|make test|tox|rspec)\b"
)
# The runner must open the segment. A commit message or PR body split on
# newlines yields prose like "694 tests pass (`npx vitest run`)", which an
# unanchored search took for a command.
RUNNER_PREFIX = re.compile(
    r"^(?:\w+=\S+\s+)*(?:npx\s+|uv run\s+|ap-heavy\s+|python3? -m\s+|\S*/bin/)?"
)


def sh(*args, cwd=None):
    """Run a command, returning stripped stdout or '' on any failure."""
    try:
        out = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=15
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def sh_raw(*args, cwd=None):
    """As sh(), but preserves leading whitespace (git status status columns)."""
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=15)
        return out.stdout.rstrip("\n") if out.returncode == 0 else ""
    except Exception:
        return ""


def git(*args, cwd=None):
    return sh("git", *args, cwd=cwd)


def resolve(path):
    """Absolute, symlink-resolved path, or '' if it does not resolve."""
    try:
        return str(Path(path).resolve()) if path else ""
    except Exception:
        return ""


def find_transcript(cwd, session_id):
    """Locate this session's transcript.

    Claude Code keys its transcript directory on the working directory, so a
    linked worktree has its own directory distinct from the main checkout's,
    and a session that has changed directory mid-run may have written its
    transcript under a different project slug entirely. So: look in this
    project first, then across every project, and only then fall back.

    Never returns a session id paired with another session's transcript. An
    inconsistent pair is worse than a missing one, because it looks correct.
    """
    projects = Path.home() / ".claude" / "projects"
    slug = re.sub(r"[^a-zA-Z0-9]", "-", str(cwd))

    if session_id:
        here = projects / slug / f"{session_id}.jsonl"
        if here.exists():
            return session_id, str(here)
        elsewhere = sorted(projects.glob(f"*/{session_id}.jsonl"))
        if elsewhere:
            return session_id, str(elsewhere[0])
        # The id was given and is authoritative, but we cannot find its
        # transcript. Report the id alone rather than attaching a stranger's.
        return session_id, None

    d = projects / slug
    if not d.is_dir():
        return None, None
    files = sorted(d.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return None, None
    return files[0].stem, str(files[0])


def read_transcript(path):
    """Yield each assistant tool_use block as (tool_name, input_dict)."""
    if not path:
        return
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                msg = rec.get("message") or {}
                if rec.get("type") != "assistant":
                    continue
                for block in msg.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        yield block.get("name") or "", block.get("input") or {}
    except OSError:
        return


def collect_from_transcript(path):
    """Files written, files read, and test commands actually run this session."""
    written, read, commands = Counter(), Counter(), []
    ranges = {}
    for name, params in read_transcript(path):
        if name in ("Edit", "Write", "NotebookEdit"):
            fp = params.get("file_path") or params.get("notebook_path")
            if fp:
                written[fp] += 1
        elif name == "Read":
            fp = params.get("file_path")
            if fp:
                read[fp] += 1
                off, lim = params.get("offset"), params.get("limit")
                if off or lim:
                    start = int(off or 1)
                    ranges.setdefault(fp, set()).add(f"{start}-{start + int(lim or 2000) - 1}")
                else:
                    ranges.setdefault(fp, set()).add("all")
        elif name == "Bash":
            cmd = (params.get("command") or "").strip()
            if not cmd:
                continue
            # Scan the command, never a heredoc's payload. The body of a
            # `<<EOF` block is data - often source code - and matching inside
            # it turns the file being written into a dozen phantom "files
            # touched" and its own text into "verification commands".
            cmd = cmd.split("<<")[0]
            # Split compound commands: the useful artefact is `pnpm test`, not
            # the 200-character pipeline it happened to be chained into.
            for seg in re.split(r"&&|\|\||;|\n", cmd):
                seg = seg.strip()
                head = RUNNER_PREFIX.match(seg).end()
                if seg and TEST_HINT.match(seg, head) and len(seg) <= 120:
                    commands.append(seg)
            for m in BASH_READ.finditer(cmd):
                read[m.group(1)] += 1
            for pat in BASH_WRITE:
                for m in pat.finditer(cmd):
                    hit = m.groups()[-1]
                    if hit and not hit.startswith("/dev/") and "$" not in hit:
                        written[hit] += 1
    return written, read, commands, ranges


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    cwd = os.getcwd()
    toplevel = git("rev-parse", "--show-toplevel") or cwd
    in_git = bool(git("rev-parse", "--is-inside-work-tree"))

    facts = {
        "created": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "timestamp": datetime.now().strftime("%Y%m%d-%H%M"),
        "repo": toplevel,
        "in_git": in_git,
    }

    if in_git:
        facts["branch"] = git("rev-parse", "--abbrev-ref", "HEAD")
        facts["commit"] = git("rev-parse", "--short", "HEAD")
        # Do not strip: the leading two characters are the status column.
        facts["dirty"] = [
            l for l in sh_raw("git", "status", "--short").splitlines() if l.strip()
        ]
        facts["recent_commits"] = git("log", "--oneline", "-20").splitlines()

        base = ""
        for b in ("main", "master", "develop"):
            base = git("merge-base", "HEAD", b)
            if base:
                facts["base_branch"] = b
                break
        facts["diffstat"] = (
            git("diff", "--stat", f"{base}...HEAD").splitlines() if base else []
        )

        # Compare resolved paths: --git-common-dir is often relative ('../.git')
        # while --git-dir is absolute, so a raw string compare lies.
        gitdir = resolve(git("rev-parse", "--git-dir"))
        common = resolve(git("rev-parse", "--git-common-dir"))
        facts["linked_worktree"] = bool(gitdir and common and gitdir != common)
        if facts["linked_worktree"]:
            facts["main_repo"] = str(Path(common).parent)
            facts["worktrees"] = git("worktree", "list").splitlines()

    sid, transcript = find_transcript(cwd, args.session_id)
    facts["session"] = sid
    facts["transcript"] = transcript

    written, read, commands, ranges = collect_from_transcript(transcript)

    # Git is the authority on what actually changed, whatever wrote it. Tool
    # calls only supplement it: they catch edits outside the repo, and files
    # that were changed and then reverted.
    changed = []
    if in_git:
        base = facts.get("base_branch")
        if base:
            changed = git("diff", "--name-only", f"{base}...HEAD").splitlines()
        mine = {p.replace(str(Path(toplevel)) + "/", "") for p in written}
        facts["dirty_mine"] = [l for l in facts.get("dirty", []) if l[3:].strip() in mine]
        changed += [l[3:].strip() for l in facts["dirty_mine"]]
    seen = set()
    files_written = []
    for path in changed:
        if path and path not in seen:
            seen.add(path)
            files_written.append({"path": path, "source": "git"})
    for path, n in written.most_common():
        norm = path.replace(str(Path(toplevel)) + "/", "")
        if norm not in seen and path not in seen:
            seen.add(norm)
            files_written.append({"path": path, "source": "session", "edits": n})
    facts["files_written"] = files_written
    # Read often and not written: the files that were load-bearing to understand.
    facts["read_candidates"] = [
        {"path": p, "reads": n, "lines": ", ".join(sorted(ranges.get(p, ())))}
        for p, n in read.most_common(12) if p not in written
    ]
    # Last one wins: the command the session settled on.
    facts["verification_candidates"] = list(dict.fromkeys(reversed(commands)))[:5]

    if args.json:
        print(json.dumps(facts, indent=2))
        return

    out = []
    out.append(f"**Created**: {facts['created']}")
    if in_git:
        out.append(f"**Branch**: {facts['branch']}")
        out.append(f"**Commit**: {facts['commit']}")
    out.append(f"**Repo**: {facts['repo']}")
    if facts["session"]:
        out.append(f"**Session**: {facts['session']}")
    if facts["transcript"]:
        out.append(f"**Transcript**: {facts['transcript']}")
    if in_git and facts.get("linked_worktree"):
        out.append(
            f"**Worktree**: linked worktree; main repo at {facts['main_repo']}"
        )
    if not in_git:
        out.append("**Git**: not a git repository")

    out.append("")
    out.append("## Files touched")
    if facts["files_written"]:
        for f in facts["files_written"][:30]:
            n = f.get("edits", 1)
            suffix = f" ({n} edits)" if n > 1 else ""
            out.append(f"- `{f['path']}`{suffix}")
        if len(facts["files_written"]) > 30:
            out.append(f"- ...and {len(facts['files_written']) - 30} more")
    else:
        out.append("- none recorded this session")
    if in_git and facts["dirty"]:
        out.append("")
        mine = facts["dirty_mine"]
        others = len(facts["dirty"]) - len(mine)
        out.append(f"Uncommitted at handoff time, written this session ({len(mine)}):")
        for l in mine[:15]:
            out.append(f"- `{l}`")
        if others:
            out.append(f"- plus {others} other uncommitted entries this session did not write (`git status --short`)")

    out.append("")
    out.append("## Required reading -- CANDIDATES, ranked by reads this session")
    out.append("<!-- Pick the few that matter and say WHY each is needed. -->")
    if facts["read_candidates"]:
        for f in facts["read_candidates"][:8]:
            lines = f" lines {f['lines']}" if f.get("lines") and f["lines"] != "all" else ""
            out.append(f"- `{f['path']}`{lines} ({f['reads']} reads)")
    else:
        out.append("- none recorded this session")

    out.append("")
    out.append("## Verification command -- CANDIDATES, most recent first")
    out.append("<!-- Pick the one that proves the work, and state expected output. -->")
    if facts["verification_candidates"]:
        for c in facts["verification_candidates"]:
            out.append(f"- `{c}`")
    else:
        out.append("- none detected; fall back to the repo's documented test command")

    print("\n".join(out))


if __name__ == "__main__":
    main()
