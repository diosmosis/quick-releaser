# shellcheck shell=bash
#
# The `check` command: what it reports, and its promise to change nothing.

test_check_says_nothing_is_needed_when_the_tag_matches_the_version() {
    new_matomo_plugin foo 1.0.0

    qr check foo

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'check output' "$QR_OUT" 'no release needed'
    assert_contains 'check output' "$QR_OUT" 'nothing needs a release'
}

test_check_reports_pull_requests_merged_since_the_release() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    pr_commit "$TEST_TMP/foo" 12 'fix another thing'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'release needed: 2 pull request(s)'
    assert_contains 'check output' "$QR_OUT" '#11'
    assert_contains 'check output' "$QR_OUT" 'fix another thing'
    assert_contains 'summary' "$QR_OUT" 'foo: 1.0.0 -> 1.0.1 (patch)'
}

test_check_recognises_pull_requests_that_arrived_as_merge_commits() {
    new_matomo_plugin foo 1.0.0
    pr_merge "$TEST_TMP/foo" 42 'a merged, not squashed, pull request'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
    assert_contains 'check output' "$QR_OUT" '#42'
    assert_contains 'pr title comes from the merge body' "$QR_OUT" 'a merged, not squashed, pull request'
}

test_check_lists_commits_without_a_pull_request_separately() {
    new_matomo_plugin foo 1.0.0
    plain_commit "$TEST_TMP/foo" 'direct push, no pull request'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'no release needed'
    assert_contains 'check output' "$QR_OUT" '1 non-PR commit(s)'
}

test_check_reads_the_remote_not_the_working_tree() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'released work'
    push_repo "$TEST_TMP/foo"

    # Everything a release run would refuse to work with: a dirty tree, on a
    # branch of its own, with a version the remote has never seen.
    git -C "$TEST_TMP/foo" checkout -q -b side
    set_version "$TEST_TMP/foo" 1.0.0 9.9.9
    printf 'scratch\n' > "$TEST_TMP/foo/notes.txt"

    local before after
    before="$(git -C "$TEST_TMP/foo" rev-parse HEAD)"
    qr check foo
    after="$(git -C "$TEST_TMP/foo" rev-parse HEAD)"

    assert_contains 'reports the version on origin' "$QR_OUT" 'current version 1.0.0'
    assert_not_contains 'not the dirty working tree version' "$QR_OUT" '9.9.9'
    assert_eq 'HEAD is untouched' "$after" "$before"
    assert_eq 'still on the side branch' "$(git -C "$TEST_TMP/foo" rev-parse --abbrev-ref HEAD)" side
    assert_file_contains "$TEST_TMP/foo/plugin.json" '9.9.9'
}

test_check_handles_wordpress_plugins() {
    new_wordpress_plugin wpfoo 1.0.0
    pr_commit "$TEST_TMP/wpfoo" 7 'a wordpress fix'
    push_repo "$TEST_TMP/wpfoo"

    qr check wpfoo

    assert_contains 'project type' "$QR_OUT" 'wordpress plugin, current version 1.0.0'
    assert_contains 'version file' "$QR_OUT" 'from wpfoo.php'
    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
}

test_check_skips_folders_that_are_not_plugins() {
    git init -q -b main "$TEST_TMP/plain"
    git -C "$TEST_TMP/plain" commit -q --allow-empty -m 'initial'
    git init -q --bare -b main "$TEST_TMP/plain.git"
    git -C "$TEST_TMP/plain" remote add origin "$TEST_TMP/plain.git"
    git -C "$TEST_TMP/plain" push -q -u origin main

    qr check plain

    assert_contains 'check output' "$QR_OUT" 'not a WordPress or Matomo plugin'
    assert_eq 'a skipped repo is not a failure' "$QR_RC" 0
}

test_check_ignores_earlier_release_commits() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    plain_commit "$TEST_TMP/foo" 'bumping version to 1.0.1'
    plain_commit "$TEST_TMP/foo" 'updating changelog for 1.0.1'
    push_repo "$TEST_TMP/foo"

    qr check foo

    # The two release commits are release bookkeeping, not unreleased work.
    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
    assert_not_contains 'release commits are not reported as loose commits' "$QR_OUT" 'not associated with a pull request'
}
