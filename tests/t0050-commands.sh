# shellcheck shell=bash
#
# Which command runs, and what each one is allowed to do.
#
# Reporting is the default and `release` has to be asked for by name, so running the
# tool with no command — the easiest thing to do by accident — can never write anything.

# A repo with one unreleased pull request, i.e. one that a release run would act on.
setup_releasable() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"
}

test_the_default_command_only_reports() {
    setup_releasable
    local before
    before="$(git -C "$TEST_TMP/foo" rev-parse HEAD)"

    qr foo

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'it ran check' "$QR_OUT" 'CHECK — reporting what needs a release'
    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
    assert_eq 'HEAD is untouched' "$(git -C "$TEST_TMP/foo" rev-parse HEAD)" "$before"
    assert_eq 'still on the default branch' "$(git -C "$TEST_TMP/foo" rev-parse --abbrev-ref HEAD)" main
    if has_pushed_release "$TEST_TMP/foo"; then _fail 'the default command must not push'; fi
}

test_the_default_command_never_prompts() {
    setup_releasable

    # No scripted answers at all: a single prompt would exit 70 (input exhausted).
    qr foo

    assert_eq 'exit status' "$QR_RC" 0
}

test_the_check_command_is_still_accepted_by_name() {
    setup_releasable

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
}

test_the_check_flag_is_still_accepted() {
    setup_releasable

    qr --check foo

    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
}

test_the_release_command_is_what_writes() {
    setup_releasable

    qr_release foo 'Bug fix: fixed a thing.' ''

    assert_eq 'commit subject' "$(pushed_release_subject "$TEST_TMP/foo")" 'bumping version to 1.0.1'
}

test_check_points_at_the_release_command() {
    setup_releasable

    qr check foo

    assert_contains 'the suggested command names the release command' "$QR_OUT" "release foo' to make the release commits"
}

test_a_folder_named_release_can_still_be_reached() {
    new_matomo_plugin release 1.0.0
    pr_commit "$TEST_TMP/release" 11 'fix a thing'
    push_repo "$TEST_TMP/release"

    # Bare `release` would be the command; ./release is unambiguously the folder.
    qr ./release

    assert_contains 'the folder was processed' "$QR_OUT" 'Repo: release'
    assert_contains 'as a check, not a release' "$QR_OUT" 'release needed: 1 pull request(s)'
    if has_pushed_release "$TEST_TMP/release"; then _fail 'nothing should have been pushed'; fi
}

test_the_command_word_is_only_a_command_in_first_position() {
    new_matomo_plugin check 1.0.0
    pr_commit "$TEST_TMP/check" 11 'fix a thing'
    push_repo "$TEST_TMP/check"

    # `release check` — the command, then a folder that shares the other command's name.
    qr_release check 'Bug fix: fixed a thing.' ''

    assert_eq 'the release ran on the folder' "$(pushed_release_subject "$TEST_TMP/check")" 'bumping version to 1.0.1'
}

test_help_documents_both_commands() {
    qr --help

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'usage' "$QR_OUT" 'check|release'
    assert_contains 'usage' "$QR_OUT" '(default)'
}
