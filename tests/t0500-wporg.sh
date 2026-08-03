# shellcheck shell=bash
#
# WordPress plugins published in the wordpress.org plugin directory.
#
# Those releases are pushed over SVN, which git knows nothing about, so a plugin can be
# several versions past its newest git tag — wp-matomo is. The directory is therefore
# the authority on what actually shipped, and the newest of (tag, published version)
# wins. These tests point the lookup at a local stub rather than the real API.

# 1.0.0 tagged, then four pull requests: bumps to 1.0.1 and 1.0.2, a plain change, and
# a bump to 1.0.3. Only the caller's chosen version has actually been published.
setup_published_history() {
    new_wordpress_plugin wpfoo 1.0.0
    bump_pr "$TEST_TMP/wpfoo" 1 1.0.0 1.0.1
    bump_pr "$TEST_TMP/wpfoo" 2 1.0.1 1.0.2
    pr_commit "$TEST_TMP/wpfoo" 3 'work after the 1.0.2 release'
    bump_pr "$TEST_TMP/wpfoo" 4 1.0.2 1.0.3
    push_repo "$TEST_TMP/wpfoo"
}

test_the_published_version_beats_an_older_tag() {
    setup_published_history
    with_wporg_stub '{"wpfoo":"1.0.2"}'

    qr check wpfoo

    assert_contains 'the published version is the last release' "$QR_OUT" \
        'last release: 1.0.2 (published on wordpress.org as "wpfoo")'
    assert_contains 'unreleased work is measured from it' "$QR_OUT" \
        'release needed: 2 pull request(s) merged since the 1.0.2 release'
    assert_contains 'check output' "$QR_OUT" '#3'
    assert_contains 'check output' "$QR_OUT" '#4'
    # Going by the 1.0.0 tag alone would have dragged the two released bumps in.
    assert_not_contains 'released work is not reported' "$QR_OUT" '#1 '
    assert_not_contains 'released work is not reported' "$QR_OUT" '#2 '
}

test_the_declared_version_is_pending_against_the_published_one() {
    setup_published_history
    with_wporg_stub '{"wpfoo":"1.0.2"}'

    qr check wpfoo

    assert_contains 'check output' "$QR_OUT" 'version 1.0.3 is set in wpfoo.php but was never released'
    assert_contains 'summary' "$QR_OUT" 'wpfoo: 1.0.3 is bumped but unreleased (last release 1.0.2)'
}

test_a_newer_tag_beats_the_published_version() {
    setup_published_history
    # The 1.0.3 release was tagged but has not reached the directory yet.
    tag_release "$TEST_TMP/wpfoo" 1.0.3
    with_wporg_stub '{"wpfoo":"1.0.2"}'

    qr check wpfoo

    assert_contains 'the newer tag wins' "$QR_OUT" 'no release needed'
    assert_not_contains 'not the published version' "$QR_OUT" 'wordpress.org'
}

test_a_release_run_uses_the_published_version_too() {
    setup_published_history
    with_wporg_stub '{"wpfoo":"1.0.2"}'

    # #3 and #4 are the unreleased ones; then accept 1.0.3 as the version.
    qr_release wpfoo 'Work after the release.' 'Version bump.' ''

    assert_contains 'run output' "$QR_OUT" 'last release: 1.0.2 (published on wordpress.org as "wpfoo")'
    assert_contains 'run output' "$QR_OUT" 'releasing 1.0.3 as it stands (no version bump needed)'
    assert_eq 'commit subject' "$(pushed_release_subject "$TEST_TMP/wpfoo")" 'updating changelog for 1.0.3'
    assert_file_contains "$TEST_TMP/wpfoo/readme.txt" '* Work after the release.'
}

test_the_slug_comes_from_the_plugin_uri_header() {
    new_wordpress_plugin wpfoo 1.0.0
    set_plugin_uri "$TEST_TMP/wpfoo" wpfoo.php 'https://wordpress.org/extend/plugins/a-different-slug/'
    bump_pr "$TEST_TMP/wpfoo" 1 1.0.0 1.0.1
    bump_pr "$TEST_TMP/wpfoo" 2 1.0.1 1.0.2
    push_repo "$TEST_TMP/wpfoo"
    # Answering from the wrong slug would say 9.9.9 has shipped, which shows up
    # loudly — the two slugs cannot be confused for one another.
    with_wporg_stub '{"a-different-slug":"1.0.1","wpfoo":"9.9.9"}'

    qr check wpfoo

    assert_eq 'the header slug is asked about first, and answers' "$(wporg_requests)" 'a-different-slug'
    assert_contains 'check output' "$QR_OUT" 'last release: 1.0.1 (published on wordpress.org as "a-different-slug")'
}

test_the_slug_falls_back_to_the_main_file_name() {
    new_wordpress_plugin wpfoo 1.0.0
    bump_pr "$TEST_TMP/wpfoo" 1 1.0.0 1.0.1
    bump_pr "$TEST_TMP/wpfoo" 2 1.0.1 1.0.2
    push_repo "$TEST_TMP/wpfoo"
    with_wporg_stub '{"wpfoo":"1.0.1"}'

    # No Plugin URI header, so the main file's name is the guess. The folder name is
    # the last resort and is the same string here, so one request settles it.
    qr check wpfoo

    assert_eq 'requested slugs' "$(wporg_requests)" 'wpfoo'
    assert_contains 'check output' "$QR_OUT" 'last release: 1.0.1 (published on wordpress.org as "wpfoo")'
}

test_a_plugin_that_is_not_in_the_directory_falls_back_to_tags() {
    new_wordpress_plugin wpfoo 1.0.0
    set_plugin_uri "$TEST_TMP/wpfoo" wpfoo.php 'https://example.com/wpfoo/'
    pr_commit "$TEST_TMP/wpfoo" 1 'a fix'
    push_repo "$TEST_TMP/wpfoo"
    with_wporg_stub '{}'

    qr check wpfoo

    # A non-wordpress.org Plugin URI yields no slug, so it tries the main file name and
    # then the folder name, gets a 404 for both, and goes by the tag.
    assert_eq 'requested slugs' "$(wporg_requests)" 'wpfoo'
    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s) merged since 1.0.0'
    assert_contains 'summary' "$QR_OUT" 'wpfoo: 1.0.0 -> 1.0.1 (patch)'
}

test_a_published_version_this_branch_never_declared_is_reported() {
    new_wordpress_plugin wpfoo 1.0.0
    pr_commit "$TEST_TMP/wpfoo" 1 'a fix'
    push_repo "$TEST_TMP/wpfoo"
    # Released from some other branch: 2.5.0 appears nowhere in this history.
    with_wporg_stub '{"wpfoo":"2.5.0"}'

    qr check wpfoo

    assert_contains 'check output' "$QR_OUT" 'wordpress.org serves 2.5.0 of "wpfoo", which this branch never declared'
    assert_contains 'it still reports against the tag' "$QR_OUT" 'release needed: 1 pull request(s) merged since 1.0.0'
}

test_no_wporg_skips_the_lookup_entirely() {
    setup_published_history
    with_wporg_stub '{"wpfoo":"1.0.2"}'

    qr check --no-wporg wpfoo

    assert_eq 'nothing was asked' "$(wporg_requests)" ''
    assert_contains 'goes by the tag instead' "$QR_OUT" 'merged since the 1.0.0 release'
}

test_matomo_plugins_are_never_looked_up() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 1 'a fix'
    push_repo "$TEST_TMP/foo"
    with_wporg_stub '{"foo":"9.9.9"}'

    qr check foo

    assert_eq 'the directory has nothing to say about Matomo plugins' "$(wporg_requests)" ''
    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s)'
}

test_an_unreachable_directory_does_not_stop_the_run() {
    setup_published_history
    # A port with nothing listening on it: connection refused, not a 404.
    export QUICK_RELEASER_WPORG_API='http://127.0.0.1:1'
    unset QUICK_RELEASER_NO_WPORG

    qr check wpfoo

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'falls back to the tag' "$QR_OUT" 'merged since the 1.0.0 release'
}
