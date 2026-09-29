#!/usr/bin/env bash
#
# Specs index gate.
#
# `docs/specs-index.md` is meant to be "every feature ever shipped in this
# repository". In the Sowel core the same table drifted 42 rows short, because
# nothing failed when a spec folder was merged without its row (core issue
# #872). One line typed at pull-request time is cheaper than reconstructing a
# year of history, so this check fails the pull request rather than the release.
#
# The core keeps the same table (`docs/specs-index.md` in mchacher/sowel);
# a plugin spec that needs a core change links to the core issue or spec from
# its own row, never the other way round.
#
# Runs in CI and locally: `bash scripts/check-specs-index.sh`.
# Portable to bash 3.2 (macOS) — no mapfile, no associative arrays.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

INDEX="docs/specs-index.md"
# A row is "| NNN |" at the start of a line, optionally with a letter suffix
# (the core has specs like 111b).
ROW='^\| [0-9]{3}[a-z]? \|'

if [ ! -f "${INDEX}" ]; then
  echo "❌ ${INDEX} not found — run this from the repository root."
  exit 1
fi

failed=0

# ── One row per spec folder ───────────────────────────────────────────
# Pure shell. The core's copy of this script called `basename` and a `grep` per
# spec folder, which is two processes each and took ~13 s at 175 folders — long
# enough to blow the timeout of the test that ran it, so `npm run validate` and
# the pre-push hook were red for a reason unrelated to the change being pushed
# (mchacher/sowel#917). The work is a set membership test; it does not need a
# process per element. Fixed here before this repository grows enough specs to
# feel it.
# `|| true`: grep exits 1 on an index with no rows at all, and pipefail would
# then kill the script mid-check without printing anything.
listed="$( { grep -oE "${ROW}" "${INDEX}" || true; } | tr -d '| ')"
listed_flat=" $(echo "${listed}" | tr '\n' ' ') "

missing=""
for dir in specs/*/; do
  [ -d "${dir}" ] || continue
  slug="${dir%/}"
  slug="${slug##*/}"
  num="${slug%%-*}"
  case "${num}" in
    # 048a / 048b exist in the core, hence the optional letter.
    [0-9][0-9][0-9] | [0-9][0-9][0-9][a-z]) ;;
    # Not a spec folder (no NNN- prefix): nothing to look up, and inviting
    # someone to paste `| archive | ... |` would be worse than staying quiet.
    *) continue ;;
  esac
  case "${listed_flat}" in
    *" ${num} "*) ;;
    *) missing="${missing} ${slug}" ;;
  esac
done

if [ -n "${missing}" ]; then
  echo "❌ ${INDEX} has no row for:"
  for slug in ${missing}; do
    num="${slug%%-*}"
    echo "   | ${num} | <title> | ✅ | Shipped. See \`specs/${slug}/\`. |"
  done
  failed=1
fi

# ── No spec listed twice ──────────────────────────────────────────────
# A row pasted twice is invisible to the grep above, and it is how the core's
# French index grew a second copy of eleven specs.
# `|| true`: grep exits 1 on an index with no rows at all, and pipefail would
# then kill the script mid-check without printing anything.
duplicated="$(echo "${listed}" | sort | uniq -d | tr '\n' ' ')"
if [ -n "${duplicated}" ]; then
  echo "❌ ${INDEX} lists the same spec more than once: ${duplicated}"
  failed=1
fi

if [ "${failed}" -ne 0 ]; then
  echo
  echo "Add the missing rows to ${INDEX}. The row is one line; the alternative"
  echo "is an index nobody trusts six months from now."
  exit 1
fi

echo "Every spec folder has a row in ${INDEX} ✓"
