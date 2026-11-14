#!/usr/bin/env bash
# Refuse a commit that would add a secret or licensed data. Installed as .git/hooks/pre-commit:
#   ln -sf ../../scripts/check_secrets.sh .git/hooks/pre-commit
set -euo pipefail

staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0

fail=0
# 1. Files that must never be committed.
if echo "$staged" | grep -E '(^|/)\.env($|\.)' | grep -v -E '\.env\.example$|\.env\.local\.example$' >/dev/null; then
  echo "BLOCKED: an .env file is staged"; fail=1
fi
if echo "$staged" | grep -E '^fixtures/(costar|vexcel|matterport)/' | grep -v -E 'TEST-[A-Za-z0-9_-]+\.json$|\.gitkeep$' >/dev/null; then
  echo "BLOCKED: real CoStar/Vexcel/Matterport data is staged (only synthetic TEST-* fixtures may be committed)"; fail=1
fi
# 2. Secret-looking strings in the staged diff.
patterns='lsv2_(pt|sk)_[A-Za-z0-9]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|AQ\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|(TOKEN_SECRET|API_KEY|_TOKEN)=[^[:space:]$]{8,}'
if git diff --cached -U0 | grep -E '^\+' | grep -v -E '^\+\+\+' | grep -E "$patterns" >/dev/null; then
  echo "BLOCKED: the staged diff contains something that looks like a key:"
  git diff --cached -U0 | grep -E '^\+' | grep -E -o "$patterns" | sed -E 's/(.{6}).*/  \1…/' | sort -u
  fail=1
fi
exit $fail
