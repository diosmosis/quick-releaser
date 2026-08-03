# shellcheck shell=bash
#
# A version that has been bumped on the default branch but never tagged.
#
# These plugins bump the version inside an ordinary pull request and tag the
# release later, so the declared version is not proof that it went out. Reading
# the "current release" out of the version file instead of the tags used to hide
# every pull request that shipped with, or before, the bump — and proposed a
# release one patch too high, stranding the bumped version for good.

# 1.0.0 released; pull request #1 then bumps the version to 1.0.1 without a tag.
setup_pending_bump() {  # [extra-pr-title]
    new_matomo_plugin foo 1.0.0

    set_version "$TEST_TMP/foo" 1.0.0 1.0.1
    printf '// #1\n' >> "$TEST_TMP/foo/src.php"
    git -C "$TEST_TMP/foo" add -A
    git -C "$TEST_TMP/foo" commit -qm 'add a feature and bump the version (#1)'

    [ $# -eq 0 ] || pr_commit "$TEST_TMP/foo" 2 "$1"
    push_repo "$TEST_TMP/foo"
}

test_check_reports_a_bumped_but_unreleased_version() {
    setup_pending_bump

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'version 1.0.1 is set in plugin.json but was never released'
    assert_contains 'check output' "$QR_OUT" 'last release: 1.0.0 (tag 1.0.0'
    assert_contains 'summary' "$QR_OUT" 'foo: 1.0.1 is bumped but unreleased (last release 1.0.0)'
    assert_not_contains 'must not propose a further bump' "$QR_OUT" '1.0.2'
}

test_check_counts_pull_requests_from_the_tag_not_the_version_bump() {
    setup_pending_bump 'a second change'

    qr check foo

    # The regression: measuring from the bump commit saw only #2.
    assert_contains 'check output' "$QR_OUT" 'release needed: 2 pull request(s) merged since the 1.0.0 release'
    assert_contains 'the bump pull request is unreleased work too' "$QR_OUT" '#1'
    assert_contains 'check output' "$QR_OUT" '#2'
}

test_check_marks_pull_requests_that_wrote_their_own_changelog() {
    new_matomo_plugin foo 1.0.0

    set_version "$TEST_TMP/foo" 1.0.0 1.0.1
    add_changelog_entry "$TEST_TMP/foo" 1.0.1 'A documented change'
    git -C "$TEST_TMP/foo" add -A
    git -C "$TEST_TMP/foo" commit -qm 'a documented change (#1)'
    pr_commit "$TEST_TMP/foo" 2 'an undocumented change'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'documented pull request is marked' "$QR_OUT" 'an undocumented change'
    assert_contains 'check output' "$QR_OUT" '[changelog done]'
    assert_contains 'check output' "$QR_OUT" '1 of them already updated the changelog themselves'
}

test_check_reports_a_finished_release_as_needing_only_a_tag() {
    new_matomo_plugin foo 1.0.0

    # The one unreleased pull request bumped the version AND documented itself:
    # there is nothing left for a release commit to do.
    set_version "$TEST_TMP/foo" 1.0.0 1.0.1
    add_changelog_entry "$TEST_TMP/foo" 1.0.1 'A documented change'
    git -C "$TEST_TMP/foo" add -A
    git -C "$TEST_TMP/foo" commit -qm 'a documented change (#1)'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'needs tagging/releasing, not a release commit'
    assert_contains 'summary' "$QR_OUT" 'foo: 1.0.1 is bumped but unreleased (last release 1.0.0) — needs tagging only'
    assert_contains 'summary' "$QR_OUT" 'only need a tag and a github release'
    assert_not_contains 'no release commit to make' "$QR_OUT" 'to make the release commits'
}

test_release_of_an_unreleased_version_does_not_bump_it_again() {
    setup_pending_bump 'a second change'

    # One changelog line for #1, one for #2, then Enter to accept the version.
    qr_release foo 'documented the first change' 'documented the second change' ''

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'run output' "$QR_OUT" 'releasing 1.0.1 as it stands (no version bump needed)'
    assert_eq 'version is left alone' "$(declared_version "$TEST_TMP/foo")" 1.0.1
    assert_eq 'commit subject' "$(pushed_release_subject "$TEST_TMP/foo")" 'updating changelog for 1.0.1'
}

test_release_appends_to_the_existing_changelog_entry() {
    new_matomo_plugin foo 1.0.0

    set_version "$TEST_TMP/foo" 1.0.0 1.0.1
    add_changelog_entry "$TEST_TMP/foo" 1.0.1 'The first change'
    git -C "$TEST_TMP/foo" add -A
    git -C "$TEST_TMP/foo" commit -qm 'the first change (#1)'
    pr_commit "$TEST_TMP/foo" 2 'the second change'
    push_repo "$TEST_TMP/foo"

    # #1 documented itself, so only #2 is asked about.
    qr_release foo 'The second change' ''

    local changelog="$TEST_TMP/foo/CHANGELOG.md"
    assert_eq 'exactly one heading for the version' "$(count_in_file "$changelog" '1.0.1 - ')" 1
    assert_file_contains "$changelog" '- The first change'
    assert_file_contains "$changelog" '- The second change'
    assert_contains 'the documented pull request is not asked about' "$QR_OUT" '1 pull request(s) already updated the changelog'
}

test_release_can_still_bump_past_an_unreleased_version() {
    setup_pending_bump 'a second change'

    qr_release foo 'documented the first change' 'documented the second change' '1.0.2'

    assert_contains 'run output' "$QR_OUT" 'bumping 1.0.1 -> 1.0.2'
    assert_eq 'version was bumped' "$(declared_version "$TEST_TMP/foo")" 1.0.2
    assert_eq 'commit subject' "$(pushed_release_subject "$TEST_TMP/foo")" 'bumping version to 1.0.2'
    # The stranded 1.0.1 entry stays where it is; 1.0.2 gets its own heading.
    assert_file_contains "$TEST_TMP/foo/CHANGELOG.md" '1.0.2 - '
}

test_release_makes_no_commit_when_the_unreleased_version_is_ready() {
    new_matomo_plugin foo 1.0.0

    set_version "$TEST_TMP/foo" 1.0.0 1.0.1
    add_changelog_entry "$TEST_TMP/foo" 1.0.1 'A documented change'
    git -C "$TEST_TMP/foo" add -A
    git -C "$TEST_TMP/foo" commit -qm 'a documented change (#1)'
    push_repo "$TEST_TMP/foo"

    qr_release foo

    assert_contains 'run output' "$QR_OUT" 'its changelog is already complete — nothing to commit'
    assert_contains 'follow-up' "$QR_OUT" 'it needs a tag and a GitHub release'
    if has_pushed_release "$TEST_TMP/foo"; then _fail 'nothing should have been pushed'; fi
}

test_a_repo_with_no_tags_falls_back_to_the_version_bump_commit() {
    new_matomo_plugin foo 1.0.0
    git -C "$TEST_TMP/foo" tag -d 1.0.0 >/dev/null
    git -C "$TEST_TMP/foo" push -q origin :refs/tags/1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'no version tags found'
    assert_contains 'check output' "$QR_OUT" 'release needed: 1 pull request(s) merged since 1.0.0'
    assert_contains 'summary' "$QR_OUT" 'foo: 1.0.0 -> 1.0.1 (patch)'
}

test_a_version_older_than_the_newest_tag_is_flagged() {
    new_matomo_plugin foo 1.0.0
    tag_release "$TEST_TMP/foo" 2.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    qr check foo

    assert_contains 'check output' "$QR_OUT" 'version 1.0.0 is BEHIND the newest tag 2.0.0'
}

test_v_prefixed_tags_count_as_releases() {
    new_wordpress_plugin wpfoo 1.0.0
    git -C "$TEST_TMP/wpfoo" tag -d 1.0.0 >/dev/null
    git -C "$TEST_TMP/wpfoo" push -q origin :refs/tags/1.0.0
    tag_release "$TEST_TMP/wpfoo" v1.0.0

    set_version "$TEST_TMP/wpfoo" 1.0.0 1.0.1
    git -C "$TEST_TMP/wpfoo" commit -qam 'bump the version (#1)'
    push_repo "$TEST_TMP/wpfoo"

    qr check wpfoo

    assert_contains 'check output' "$QR_OUT" 'last release: 1.0.0 (tag v1.0.0'
    assert_contains 'check output' "$QR_OUT" 'version 1.0.1 is set in wpfoo.php but was never released'
}
