#!/usr/bin/env bash
#
# quick-releaser test runner.
#
#   tests/run-tests.sh                 run everything
#   tests/run-tests.sh unreleased      run tests whose file or name matches
#   tests/run-tests.sh -v              show output from passing tests too
#   tests/run-tests.sh -k              keep every sandbox, not just failures
#
# Each test function runs in its own process with its own throwaway HOME and
# git config, so tests cannot influence one another or touch the real machine.
# Everything is local: the fixtures build real git repositories in a temp dir
# and the "remote" is a bare repo on disk, so no test needs the network.
#
# Requires bash 4+, git 2.32+ (for GIT_CONFIG_GLOBAL) and node.

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export QR="${QR:-$(cd "$TESTS_DIR/.." && pwd)/quick-releaser.js}"

[ -r "$QR" ] || { printf 'no quick-releaser.js at %s\n' "$QR" >&2; exit 1; }
command -v node >/dev/null || { printf 'node is required to run these tests\n' >&2; exit 1; }

VERBOSE=0
KEEP=0
FILTER=''

while [ $# -gt 0 ]; do
    case "$1" in
        -v|--verbose) VERBOSE=1 ;;
        -k|--keep)    KEEP=1 ;;
        -h|--help)    sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*)           printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
        *)            FILTER="$1" ;;
    esac
    shift
done

if [ -t 1 ]; then
    C_PASS=$'\033[32m'; C_FAIL=$'\033[1;31m'; C_HEAD=$'\033[1;36m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_PASS=''; C_FAIL=''; C_HEAD=''; C_DIM=''; C_OFF=''
fi

passed=0
failed=0
failures=()

run_one() {  # <file> <test-name>
    local file="$1" name="$2" dir rc
    dir="$(mktemp -d "${TMPDIR:-/tmp}/quick-releaser-test.XXXXXXXX")"

    (
        set -e
        export TEST_TMP="$dir"
        # shellcheck source=/dev/null
        source "$TESTS_DIR/lib.sh"
        setup_sandbox
        # shellcheck source=/dev/null
        source "$file"
        "$name"
    ) >"$dir/.output" 2>&1
    rc=$?

    if [ "$rc" -eq 0 ]; then
        passed=$((passed + 1))
        printf '  %sPASS%s  %s\n' "$C_PASS" "$C_OFF" "$name"
        [ "$VERBOSE" -eq 0 ] || sed 's/^/        /' "$dir/.output"
        [ "$KEEP" -eq 1 ] || rm -rf "$dir"
    else
        failed=$((failed + 1))
        failures+=("${file##*/}: $name")
        printf '  %sFAIL%s  %s\n' "$C_FAIL" "$C_OFF" "$name"
        sed 's/^/        /' "$dir/.output"
        printf '        %ssandbox kept: %s%s\n' "$C_DIM" "$dir" "$C_OFF"
    fi
}

shopt -s nullglob
files=("$TESTS_DIR"/t[0-9]*.sh)
shopt -u nullglob
[ "${#files[@]}" -gt 0 ] || { printf 'no test files found in %s\n' "$TESTS_DIR" >&2; exit 1; }

start=$SECONDS
for file in "${files[@]}"; do
    base="${file##*/}"

    # Test functions are discovered by name so a file never has to maintain a
    # registration list that can drift from what it actually defines.
    mapfile -t names < <(grep -oE '^test_[A-Za-z0-9_]+' "$file")

    selected=()
    for n in "${names[@]}"; do
        if [ -z "$FILTER" ] || [[ "$base" == *"$FILTER"* ]] || [[ "$n" == *"$FILTER"* ]]; then
            selected+=("$n")
        fi
    done
    [ "${#selected[@]}" -gt 0 ] || continue

    printf '\n%s%s%s\n' "$C_HEAD" "$base" "$C_OFF"
    for n in "${selected[@]}"; do run_one "$file" "$n"; done
done

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf '%s%d passed%s in %ds\n' "$C_PASS" "$passed" "$C_OFF" "$((SECONDS - start))"
    exit 0
fi

printf '%s%d failed%s, %d passed in %ds\n' "$C_FAIL" "$failed" "$C_OFF" "$passed" "$((SECONDS - start))"
printf '  %s\n' "${failures[@]}"
exit 1
