# shellcheck shell=bash
#
# Shared harness for the quick-releaser test suite.
#
# Sourced by run-tests.sh inside a fresh subshell for every single test, so
# nothing a test does — cwd, environment, git config — can reach the next one.
#
# $QR       absolute path to the quick-releaser.js under test (set by the runner)
# $TEST_TMP this test's private sandbox directory (set by the runner)

# --------------------------------------------------------------------------
# Sandbox
# --------------------------------------------------------------------------

# Put git in a hermetic state: no system/global config from the machine running
# the suite, and a fixed identity so commit subjects are all the tests depend on.
setup_sandbox() {
    export HOME="$TEST_TMP/home"
    mkdir -p "$HOME"

    # The default folder list must come from the test, never from the config the
    # machine running the suite happens to have — and `config edit` must never
    # open the real editor of whoever is running it.
    unset XDG_CONFIG_HOME QUICK_RELEASER_CONFIG VISUAL EDITOR

    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
    : > "$GIT_CONFIG_GLOBAL"

    export GIT_AUTHOR_NAME='Test Author'    GIT_AUTHOR_EMAIL='author@test.invalid'
    export GIT_COMMITTER_NAME='Test Author' GIT_COMMITTER_EMAIL='author@test.invalid'
    export NO_COLOR=1

    # No test may reach the network. The tests that do cover the wordpress.org
    # lookup point it at a stub server instead (see with_wporg_stub).
    export QUICK_RELEASER_NO_WPORG=1

    git config --global init.defaultBranch main
    git config --global user.name 'Test Author'
    git config --global user.email 'author@test.invalid'
    git config --global gc.auto 0
    git config --global advice.detachedHead false

    cd "$TEST_TMP"
}

# --------------------------------------------------------------------------
# Assertions
#
# Every failure aborts the test with exit 1; the runner turns that into a FAIL
# and keeps the sandbox around for inspection.
# --------------------------------------------------------------------------

_fail() {
    local line func file
    read -r line func file < <(caller 1)
    printf '%s\n' "$1" >&2
    shift
    while [ $# -gt 0 ]; do printf '    %s\n' "$1" >&2; shift; done
    printf '    at %s:%s\n' "${file##*/}" "$line" >&2
    exit 1
}

assert_eq() {   # <what> <got> <want>
    [ "$2" = "$3" ] || _fail "$1" "want: [$3]" "got:  [$2]"
}

assert_contains() {     # <what> <haystack> <needle>
    case "$2" in
        *"$3"*) ;;
        *) _fail "$1" "expected to contain: [$3]" "actual output:" "$2" ;;
    esac
}

assert_not_contains() { # <what> <haystack> <needle>
    case "$2" in
        *"$3"*) _fail "$1" "expected NOT to contain: [$3]" "actual output:" "$2" ;;
    esac
}

assert_file_contains() {    # <file> <needle>
    [ -r "$1" ] || _fail "no such file: $1"
    assert_contains "$1" "$(cat "$1")" "$2"
}

assert_file_not_contains() { # <file> <needle>
    [ -r "$1" ] || _fail "no such file: $1"
    assert_not_contains "$1" "$(cat "$1")" "$2"
}

# How many times <needle> appears in <file> — the duplicate-changelog-heading check.
count_in_file() {   # <file> <needle>
    grep -c -F -- "$2" "$1" || true
}

# --------------------------------------------------------------------------
# Running the tool
#
# quick-releaser reports on stdout and works on folders in the current
# directory, so every run happens from $TEST_TMP with the repo named as an
# argument. Both streams land in $QR_OUT and the status in $QR_RC; the helpers
# always return 0 so an expected non-zero exit doesn't trip the runner's set -e.
# --------------------------------------------------------------------------

qr() {  # qr <args...>
    set +e
    QR_OUT="$(cd "$TEST_TMP" && node "$QR" "$@" 2>&1)"
    QR_RC=$?
    set -e
    return 0
}

# Point the wordpress.org lookup at a local stub for the rest of this test.
# The map is slug => published version, e.g. with_wporg_stub '{"wpfoo":"1.0.3"}'.
# The stub dies with the test, including when an assertion aborts it.
with_wporg_stub() { # <slug-to-version-json>
    local port_file="$TEST_TMP/.wporg-port"
    rm -f "$port_file" "$port_file.requests"
    : > "$port_file.requests"

    node "$TESTS_DIR/wporg-stub.js" "$1" "$port_file" &
    WPORG_PID=$!
    # shellcheck disable=SC2064
    trap "kill $WPORG_PID 2>/dev/null" EXIT

    local waited=0
    while [ ! -s "$port_file" ]; do
        sleep 0.05
        waited=$((waited + 1))
        [ "$waited" -lt 100 ] || _fail 'the wordpress.org stub never started listening'
    done

    export QUICK_RELEASER_WPORG_API
    QUICK_RELEASER_WPORG_API="$(cat "$port_file")"
    unset QUICK_RELEASER_NO_WPORG
}

# The slugs the run asked the stub about, in order, space separated.
wporg_requests() {
    tr '\n' ' ' < "$TEST_TMP/.wporg-port.requests" | sed 's/ $//'
}

# The `release` command, which is interactive. QUICK_RELEASER_INPUT feeds it one
# answer per line in the order the questions are asked, so the tests drive the
# real code path rather than a testing-only variant of it:
#
#   ''         accept the pre-filled default (what pressing Enter does)
#   '<empty>'  submit an empty answer        (what clearing the line does)
#
# Answers are passed as separate arguments and joined with newlines, which reads
# better at the call site than an embedded here-doc.
qr_release() {  # qr_release <repo> <answer>... -- <args>...
    local repo="$1"; shift
    local answers=() args=()
    while [ $# -gt 0 ]; do
        [ "$1" = '--' ] && { shift; args=("$@"); break; }
        answers+=("$1")
        shift
    done

    local input=''
    if [ "${#answers[@]}" -gt 0 ]; then
        printf -v input '%s\n' "${answers[@]}"
        input="${input%$'\n'}"
    fi

    set +e
    QR_OUT="$(cd "$TEST_TMP" && QUICK_RELEASER_INPUT="$input" node "$QR" release "${args[@]}" "$repo" 2>&1)"
    QR_RC=$?
    set -e
    return 0
}

# --------------------------------------------------------------------------
# Repository fixtures
#
# Each fixture builds a bare repo standing in for github plus a working clone,
# so `git fetch origin`, `git pull --ff-only` and the push of the release branch
# all exercise a real remote without touching the network.
#
#   $TEST_TMP/<name>.git   the "remote"
#   $TEST_TMP/<name>       the clone quick-releaser is pointed at
# --------------------------------------------------------------------------

# A Matomo plugin: version in plugin.json, plus a source constant, and a
# CHANGELOG.md in the plain `1.0.0 - 2020-01-01` style these plugins use.
new_matomo_plugin() {   # <name> [version]
    # Declared one per line on purpose: bash expands every word of a `local`
    # statement before any of its assignments happen, so `local a=$1 b=$a` would
    # quietly pick up whatever `a` the caller had.
    local name="$1"
    local v="${2:-1.0.0}"
    local r="$TEST_TMP/$name"

    git init -q --bare -b main "$TEST_TMP/$name.git"
    git init -q -b main "$r"

    cat > "$r/plugin.json" <<EOF
{
  "name": "$name",
  "version": "$v",
  "description": "a test plugin"
}
EOF
    cat > "$r/$name.php" <<EOF
<?php

namespace Piwik\\Plugins\\$name;

class $name
{
    const VERSION = '$v';
}
EOF
    cat > "$r/CHANGELOG.md" <<EOF
## Changelog

$v - 2020-01-01
- Initial release
EOF

    _publish_fixture "$r" "$name"
}

# A WordPress plugin: version in the plugin header, in a define(), in
# readme.txt's stable tag, and a changelog inside readme.txt's own section.
new_wordpress_plugin() {    # <name> [version]
    local name="$1"
    local v="${2:-1.0.0}"
    local r="$TEST_TMP/$name"

    git init -q --bare -b main "$TEST_TMP/$name.git"
    git init -q -b main "$r"

    cat > "$r/$name.php" <<EOF
<?php
/**
 * Plugin Name: $name
 * Description: a test plugin
 * Version: $v
 */

define('${name^^}_VERSION', '$v');
EOF
    cat > "$r/readme.txt" <<EOF
=== $name ===
Contributors: tester
Requires at least: 6.0
Stable tag: $v

== Description ==

A test plugin.

== Changelog ==

= $v =
* Initial release
EOF

    _publish_fixture "$r" "$name"
}

# First commit, first release tag, and an origin that knows its default branch.
_publish_fixture() {    # <repo> <name>
    local r="$1" name="$2" v
    v="$(declared_version "$r")"

    git -C "$r" add -A
    git -C "$r" commit -qm "initial commit"
    git -C "$r" tag "$v"
    git -C "$r" remote add origin "$TEST_TMP/$name.git"
    git -C "$r" push -q --tags -u origin main
    git -C "$r" remote set-head origin --auto >/dev/null
}

# --------------------------------------------------------------------------
# Fixture actions
# --------------------------------------------------------------------------

# A squash-merged pull request: one commit whose subject ends in `(#N)`.
pr_commit() {   # <repo> <number> <title>
    local r="$1" n="$2" t="$3"
    printf '// %s\n' "$t" >> "$r/src.php"
    git -C "$r" add -A
    git -C "$r" commit -qm "$t (#$n)"
}

# The other shape a merged pull request arrives in: a real merge commit, with
# the pull request title in the body rather than the subject.
pr_merge() {    # <repo> <number> <title>
    local r="$1" n="$2" t="$3"
    git -C "$r" checkout -q -b "pr-$n"
    printf '// %s\n' "$t" >> "$r/src.php"
    git -C "$r" add -A
    git -C "$r" commit -qm "work for #$n"
    git -C "$r" checkout -q main
    git -C "$r" merge -q --no-ff -m "Merge pull request #$n from tester/pr-$n

$t" "pr-$n"
    git -C "$r" branch -q -D "pr-$n"
}

# A pull request that bumps the version, which is how these plugins usually get
# bumped: inside ordinary work, well before the release goes out.
bump_pr() { # <repo> <number> <old> <new> [title]
    local r="$1" n="$2" o="$3" v="$4"
    local t="${5:-bump version to $v}"
    set_version "$r" "$o" "$v"
    printf '// %s\n' "$t" >> "$r/src.php"
    git -C "$r" add -A
    git -C "$r" commit -qm "$t (#$n)"
}

# Give a WordPress plugin a Plugin URI header naming its directory slug.
set_plugin_uri() {  # <repo> <main-file> <url>
    sed -i "s|^ \* Plugin Name:| * Plugin URI: $3\n * Plugin Name:|" "$1/$2"
    git -C "$1" commit -qam 'add the plugin uri header'
}

# A commit that is not a pull request at all.
plain_commit() {    # <repo> <subject>
    local r="$1" s="$2"
    printf '// %s\n' "$s" >> "$r/src.php"
    git -C "$r" add -A
    git -C "$r" commit -qm "$s"
}

# Rewrite the version everywhere it is *declared*, leaving old changelog
# headings alone — exactly the edit a "bump version" pull request makes.
set_version() { # <repo> <old> <new>
    local r="$1" o="$2" n="$3"
    [ -f "$r/plugin.json" ] && sed -i "s/\"version\": \"$o\"/\"version\": \"$n\"/" "$r/plugin.json"
    [ -f "$r/readme.txt" ] && sed -i "s/^Stable tag: $o\$/Stable tag: $n/" "$r/readme.txt"
    for f in "$r"/*.php; do
        [ -e "$f" ] || continue
        sed -i -e "s/ \* Version: $o\$/ * Version: $n/" \
               -e "s/VERSION = '$o'/VERSION = '$n'/" \
               -e "s/_VERSION', '$o'/_VERSION', '$n'/" "$f"
    done
    return 0
}

# Add a changelog entry for <version>, in whichever file this project keeps its
# changelog in — what a pull request that documents itself does.
add_changelog_entry() { # <repo> <version> <line>
    local r="$1" v="$2" line="$3"
    if [ -f "$r/CHANGELOG.md" ]; then
        awk -v v="$v" -v l="$line" '
            !done && /^[0-9]+\.[0-9]+/ { print v " - 2020-06-01"; print "- " l; print ""; done = 1 }
            { print }
        ' "$r/CHANGELOG.md" > "$r/CHANGELOG.md.new" && mv "$r/CHANGELOG.md.new" "$r/CHANGELOG.md"
    fi
    if [ -f "$r/readme.txt" ]; then
        awk -v v="$v" -v l="$line" '
            !done && /^= [0-9]+\.[0-9]+/ { print "= " v " ="; print "* " l; print ""; done = 1 }
            { print }
        ' "$r/readme.txt" > "$r/readme.txt.new" && mv "$r/readme.txt.new" "$r/readme.txt"
    fi
}

# Release a version for real: tag it and push the tag, which is the only signal
# quick-releaser accepts as proof that a version actually went out.
tag_release() { # <repo> <version>
    local r="$1" v="$2"
    git -C "$r" tag "$v"
    git -C "$r" push -q origin "refs/tags/$v"
}

push_repo() {   # <repo>
    git -C "$1" push -q origin main
}

# --------------------------------------------------------------------------
# Inspecting the result
# --------------------------------------------------------------------------

declared_version() {    # <repo>
    local r="$1"
    if [ -f "$r/plugin.json" ]; then
        sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$r/plugin.json" | head -n1
    else
        sed -n 's/^ \* Version: //p' "$r"/*.php | head -n1
    fi
}

subject_of() {  # <repo> <rev>
    git -C "$1" log -1 --format=%s "$2"
}

# The release branch as it landed on the "remote", which is what a reviewer
# would actually see.
pushed_release_subject() {  # <repo>
    git -C "$1" log -1 --format=%s origin/new-release 2>/dev/null
}

has_pushed_release() {  # <repo>
    git -C "$1" show-ref --verify --quiet refs/remotes/origin/new-release
}
