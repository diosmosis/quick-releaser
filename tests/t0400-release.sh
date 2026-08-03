# shellcheck shell=bash
#
# The release run: what it writes, what it commits, and what it pushes.

test_release_bumps_the_version_and_writes_the_changelog() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    qr_release foo 'Bug fix: fixed a thing.' ''

    assert_eq 'exit status' "$QR_RC" 0
    assert_eq 'version bumped' "$(declared_version "$TEST_TMP/foo")" 1.0.1
    assert_file_contains "$TEST_TMP/foo/foo.php" "const VERSION = '1.0.1';"
    assert_file_contains "$TEST_TMP/foo/CHANGELOG.md" '- Bug fix: fixed a thing.'
    assert_eq 'commit subject' "$(pushed_release_subject "$TEST_TMP/foo")" 'bumping version to 1.0.1'
    assert_contains 'summary' "$QR_OUT" 'new-release pushed'
}

test_the_new_changelog_entry_goes_above_the_previous_one() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    qr_release foo 'The newest change.' ''

    # The newest entry has to come first, above the 1.0.0 one already there.
    local first
    first="$(grep -nE '^[0-9]+\.[0-9]+\.[0-9]+' "$TEST_TMP/foo/CHANGELOG.md" | head -n1)"
    assert_contains 'first changelog entry' "$first" '1.0.1'
}

test_release_updates_every_place_a_wordpress_plugin_declares_its_version() {
    new_wordpress_plugin wpfoo 1.0.0
    pr_commit "$TEST_TMP/wpfoo" 7 'a wordpress fix'
    push_repo "$TEST_TMP/wpfoo"

    qr_release wpfoo 'Fixed something in WordPress.' ''

    assert_file_contains "$TEST_TMP/wpfoo/wpfoo.php" ' * Version: 1.0.1'
    assert_file_contains "$TEST_TMP/wpfoo/wpfoo.php" "define('WPFOO_VERSION', '1.0.1');"
    assert_file_contains "$TEST_TMP/wpfoo/readme.txt" 'Stable tag: 1.0.1'
    # readme.txt keeps its own changelog in the WordPress `= 1.0.1 =` style.
    assert_file_contains "$TEST_TMP/wpfoo/readme.txt" '= 1.0.1 ='
    assert_file_contains "$TEST_TMP/wpfoo/readme.txt" '* Fixed something in WordPress.'
    # …and the old heading still names the old version.
    assert_file_contains "$TEST_TMP/wpfoo/readme.txt" '= 1.0.0 ='
}

test_the_version_question_accepts_minor_and_major() {
    new_matomo_plugin foo 1.2.3
    pr_commit "$TEST_TMP/foo" 11 'a new feature'
    push_repo "$TEST_TMP/foo"

    qr_release foo 'New feature.' 'minor'

    assert_eq 'minor bump' "$(declared_version "$TEST_TMP/foo")" 1.3.0
    assert_eq 'commit subject' "$(pushed_release_subject "$TEST_TMP/foo")" 'bumping version to 1.3.0'
}

test_an_emptied_changelog_line_excludes_the_pull_request() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'internal refactor'
    pr_commit "$TEST_TMP/foo" 12 'a real fix'
    push_repo "$TEST_TMP/foo"

    # Clear the first line and confirm the exclusion, keep the second, then Enter.
    qr_release foo '<empty>' 'y' 'A real fix.' ''

    assert_file_contains "$TEST_TMP/foo/CHANGELOG.md" '- A real fix.'
    assert_file_not_contains "$TEST_TMP/foo/CHANGELOG.md" 'internal refactor'
    assert_eq 'still released' "$(declared_version "$TEST_TMP/foo")" 1.0.1
}

test_dry_run_commits_nothing_and_pushes_nothing() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    local before
    before="$(git -C "$TEST_TMP/foo" rev-parse origin/main)"

    qr_release foo 'Bug fix: fixed a thing.' '' -- --dry-run

    assert_contains 'run output' "$QR_OUT" 'NOT committed or pushed'
    assert_contains 'run output' "$QR_OUT" 'would commit as: bumping version to 1.0.1'
    if has_pushed_release "$TEST_TMP/foo"; then _fail 'dry run must not push'; fi
    assert_eq 'no commit was made' "$(git -C "$TEST_TMP/foo" rev-parse HEAD)" "$before"
    # The prepared changes are left in the working tree for inspection.
    assert_file_contains "$TEST_TMP/foo/plugin.json" '1.0.1'
}

test_a_repo_with_nothing_merged_is_left_alone() {
    new_matomo_plugin foo 1.0.0

    local before
    before="$(git -C "$TEST_TMP/foo" rev-parse HEAD)"

    qr_release foo

    assert_contains 'run output' "$QR_OUT" 'no release needed'
    assert_eq 'HEAD is untouched' "$(git -C "$TEST_TMP/foo" rev-parse HEAD)" "$before"
    if has_pushed_release "$TEST_TMP/foo"; then _fail 'nothing should have been pushed'; fi
}

test_a_second_run_replaces_the_release_branch() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    qr_release foo 'First wording.' ''
    local first
    first="$(git -C "$TEST_TMP/foo" rev-parse origin/new-release)"

    # Rerunning rebuilds the branch from the default branch rather than stacking
    # a second release on top of the first.
    qr_release foo 'Better wording.' ''

    assert_eq 'branch was rebuilt' "$(declared_version "$TEST_TMP/foo")" 1.0.1
    assert_file_contains "$TEST_TMP/foo/CHANGELOG.md" '- Better wording.'
    assert_file_not_contains "$TEST_TMP/foo/CHANGELOG.md" '- First wording.'
    if [ "$(git -C "$TEST_TMP/foo" rev-parse origin/new-release)" = "$first" ]; then
        _fail 'the release branch should have been replaced'
    fi
}

test_unrelated_local_changes_stop_the_run() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"
    printf '// scratch\n' >> "$TEST_TMP/foo/foo.php"

    qr_release foo

    assert_contains 'run output' "$QR_OUT" 'unrelated changes present'
    if has_pushed_release "$TEST_TMP/foo"; then _fail 'nothing should have been pushed'; fi
}
