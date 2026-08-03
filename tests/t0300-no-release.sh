# shellcheck shell=bash
#
# Pull requests marked `[no_release]` (or `[ignore_release]`): test fixes,
# screenshot updates and CI chores. They ship with whatever release follows
# them, but they are not a reason to cut one and they get no changelog line.

test_a_no_release_pull_request_does_not_need_a_release() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'Fix failing tests on 5.x-dev [no_release]'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'no release needed'
    assert_contains 'check output' "$QR_OUT" '1 pull request(s) marked [no_release] were ignored'
    assert_contains 'the ignored pull request is still named' "$QR_OUT" '#11'
    assert_contains 'summary' "$QR_OUT" 'nothing needs a release'
}

test_the_ignore_release_spelling_is_recognised() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'PG-4656 test with matomo5_[max|min]_php [ignore_release]'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'no release needed'
    assert_contains 'check output' "$QR_OUT" '1 pull request(s) marked [no_release] were ignored'
}

test_the_marker_is_recognised_on_merged_pull_requests_too() {
    new_matomo_plugin foo 1.0.0
    pr_merge "$TEST_TMP/foo" 42 'Updated screenshots for CI [no_release]'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'no release needed'
    assert_contains 'check output' "$QR_OUT" '1 pull request(s) marked [no_release] were ignored'
}

test_a_real_pull_request_still_triggers_a_release() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'Fix failing tests [no_release]'
    pr_commit "$TEST_TMP/foo" 12 'a real fix'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'only the real pull request counts' "$QR_OUT" 'release needed: 1 pull request(s)'
    assert_contains 'the chore is reported' "$QR_OUT" '1 more pull request(s) are marked [no_release]'
    assert_contains 'summary' "$QR_OUT" '1 unreleased pull request(s) (+1 [no_release])'
}

test_the_release_run_never_asks_about_no_release_pull_requests() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'Fix failing tests [no_release]'
    pr_commit "$TEST_TMP/foo" 12 'a real fix'
    push_repo "$TEST_TMP/foo"

    # Exactly two answers: one changelog line, one version. A third prompt would
    # exhaust the scripted input and exit non-zero.
    qr_release foo 'A real fix.' ''

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'run output' "$QR_OUT" '1 pull request(s) are marked [no_release] and will not be asked about'
    assert_file_contains "$TEST_TMP/foo/CHANGELOG.md" '- A real fix.'
    assert_file_not_contains "$TEST_TMP/foo/CHANGELOG.md" 'Fix failing tests'
    assert_contains 'follow-up' "$QR_OUT" '[no_release] pull request(s) ship with this release without a changelog line'
}

test_a_no_release_pull_request_does_not_release_an_unreleased_version() {
    new_matomo_plugin foo 1.0.0

    set_version "$TEST_TMP/foo" 1.0.0 1.0.1
    add_changelog_entry "$TEST_TMP/foo" 1.0.1 'A documented change'
    git -C "$TEST_TMP/foo" add -A
    git -C "$TEST_TMP/foo" commit -qm 'a documented change (#1)'
    pr_commit "$TEST_TMP/foo" 2 'Fix failing tests [no_release]'
    push_repo "$TEST_TMP/foo"

    qr check foo

    # 1.0.1 still has to go out, but the chore adds nothing to write.
    assert_contains 'check output' "$QR_OUT" 'needs tagging/releasing, not a release commit'
    assert_contains 'summary' "$QR_OUT" 'needs tagging only'
}
