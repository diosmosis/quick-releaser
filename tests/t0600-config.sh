# shellcheck shell=bash
#
# The configured default set of folders: where the config is found, how its paths
# are resolved, and that anything named on the command line still wins.

# Two releasable repos, so a config that names one of them proves the list is
# actually being used rather than the current directory being scanned.
setup_two_repos() {
    new_matomo_plugin foo 1.0.0
    pr_commit "$TEST_TMP/foo" 11 'fix a thing'
    push_repo "$TEST_TMP/foo"

    new_matomo_plugin bar 2.0.0
    pr_commit "$TEST_TMP/bar" 22 'fix another thing'
    push_repo "$TEST_TMP/bar"
}

write_config() {    # <path> <json>
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" > "$1"
}

test_a_config_in_the_current_directory_supplies_the_default_list() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '{"repos": ["foo"]}'

    qr

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'it said where the list came from' "$QR_OUT" '.quick-releaser.json'
    assert_contains 'the configured repo was processed' "$QR_OUT" 'Repo: foo'
    assert_not_contains 'the unconfigured one was not' "$QR_OUT" 'Repo: bar'
}

test_a_bare_array_is_accepted_too() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["bar"]'

    qr

    assert_contains 'the configured repo was processed' "$QR_OUT" 'Repo: bar'
    assert_not_contains 'the other one was not' "$QR_OUT" 'Repo: foo'
}

test_command_line_folders_beat_the_config() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'

    qr bar

    assert_contains 'the folder given on the command line was processed' "$QR_OUT" 'Repo: bar'
    assert_not_contains 'the configured one was not' "$QR_OUT" 'Repo: foo'
}

test_no_config_goes_back_to_scanning_the_current_directory() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'

    qr --no-config

    assert_contains 'it scanned' "$QR_OUT" 'Scanning'
    assert_contains 'first repo' "$QR_OUT" 'Repo: bar'
    assert_contains 'second repo' "$QR_OUT" 'Repo: foo'
}

test_the_config_applies_to_the_release_command_as_well() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'

    # No repo argument at all: the folder list comes from the config.
    set +e
    QR_OUT="$(cd "$TEST_TMP" && QUICK_RELEASER_INPUT=$'Bug fix: fixed a thing.\n' node "$QR" release 2>&1)"
    QR_RC=$?
    set -e

    assert_eq 'the configured repo was released' "$(pushed_release_subject "$TEST_TMP/foo")" 'bumping version to 1.0.1'
    if has_pushed_release "$TEST_TMP/bar"; then _fail 'the unconfigured repo must not have been released'; fi
}

test_relative_paths_are_resolved_against_the_config_file() {
    setup_two_repos
    mkdir -p "$TEST_TMP/elsewhere"
    # `../foo` means "next to the config", not "next to wherever we were run from".
    write_config "$TEST_TMP/elsewhere/config.json" '{"repos": ["../foo"]}'

    qr --config elsewhere/config.json

    assert_contains 'the repo was found via the config-relative path' "$QR_OUT" 'Repo: foo'
    assert_contains 'and checked' "$QR_OUT" 'release needed: 1 pull request(s)'
}

test_a_tilde_in_a_configured_path_is_expanded() {
    setup_two_repos
    # $HOME is the sandbox's own home, so put a repo under it and name it with ~.
    mv "$TEST_TMP/foo" "$HOME/foo"
    write_config "$TEST_TMP/.quick-releaser.json" '{"repos": ["~/foo"]}'

    qr

    assert_contains 'the repo under ~ was processed' "$QR_OUT" 'Repo: foo'
}

test_the_config_home_file_is_used_when_there_is_no_local_one() {
    setup_two_repos
    write_config "$HOME/.config/quick-releaser/config.json" "{\"repos\": [\"$TEST_TMP/bar\"]}"

    qr

    assert_contains 'the config home file was used' "$QR_OUT" 'quick-releaser/config.json'
    assert_contains 'the configured repo was processed' "$QR_OUT" 'Repo: bar'
    assert_not_contains 'the other one was not' "$QR_OUT" 'Repo: foo'
}

test_a_local_config_wins_over_the_config_home_one() {
    setup_two_repos
    write_config "$HOME/.config/quick-releaser/config.json" "{\"repos\": [\"$TEST_TMP/bar\"]}"
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'

    qr

    assert_contains 'the local config was used' "$QR_OUT" 'Repo: foo'
    assert_not_contains 'the config home one was not' "$QR_OUT" 'Repo: bar'
}

test_a_configured_folder_that_is_not_a_repo_is_reported() {
    setup_two_repos
    mkdir -p "$TEST_TMP/not-a-repo"
    write_config "$TEST_TMP/.quick-releaser.json" '["foo", "not-a-repo"]'

    qr

    assert_contains 'the missing repo was reported' "$QR_OUT" 'not a git repository'
    assert_contains 'the real one was still processed' "$QR_OUT" 'Repo: foo'
}

test_an_unreadable_config_is_fatal_rather_than_ignored() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '{"repos": ['

    qr

    assert_eq 'exit status' "$QR_RC" 65
    assert_contains 'it said why' "$QR_OUT" 'not valid JSON'
    assert_not_contains 'and processed nothing' "$QR_OUT" 'Repo: foo'
}

test_a_config_of_the_wrong_shape_is_fatal_too() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '{"projects": ["foo"]}'

    qr

    assert_eq 'exit status' "$QR_RC" 65
    assert_contains 'it said what it wanted' "$QR_OUT" '"repos" array'
}

test_a_config_file_that_does_not_exist_is_an_error_only_when_asked_for_by_name() {
    setup_two_repos

    qr --config nope.json
    assert_eq 'exit status' "$QR_RC" 66
    assert_contains 'it said which file' "$QR_OUT" 'nope.json'

    # No config anywhere and none asked for: scanning is the documented fallback.
    qr
    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'it scanned instead' "$QR_OUT" 'Scanning'
}

test_the_check_summary_suggests_a_usable_release_command() {
    setup_two_repos
    mkdir -p "$TEST_TMP/elsewhere"
    write_config "$TEST_TMP/elsewhere/config.json" '{"repos": ["../foo"]}'

    qr --config elsewhere/config.json

    # `foo` is where it is relative to the current directory, not `../foo`.
    assert_contains 'the suggested command names the folder' "$QR_OUT" "release foo' to make the release commits"
}

# --------------------------------------------------------------------------
# `config` and `config edit`
# --------------------------------------------------------------------------

# A stand-in for the user's editor: it records the file it was handed and writes
# <content> into it, which is what an editing session amounts to.
fake_editor() {     # <content>
    cat > "$TEST_TMP/fake-editor" <<EOF
#!/bin/sh
printf '%s\n' "\$@" >> "$TEST_TMP/editor.log"
cat > "\$1" <<'CONTENT'
$1
CONTENT
EOF
    chmod +x "$TEST_TMP/fake-editor"
    export EDITOR="$TEST_TMP/fake-editor"
    unset VISUAL
}

# An editor that changes nothing, i.e. one that was quit straight away.
quitting_editor() { # [exit-status]
    printf '#!/bin/sh\nexit %s\n' "${1:-0}" > "$TEST_TMP/fake-editor"
    chmod +x "$TEST_TMP/fake-editor"
    export EDITOR="$TEST_TMP/fake-editor"
    unset VISUAL
}

edited_file() {
    head -n1 "$TEST_TMP/editor.log"
}

test_config_shows_the_file_and_its_folders() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '{"repos": ["foo", "bar"]}'

    qr config

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'it named the file' "$QR_OUT" "$TEST_TMP/.quick-releaser.json"
    assert_contains 'it counted the folders' "$QR_OUT" '2 folder(s)'
    assert_contains 'first folder' "$QR_OUT" 'foo'
    assert_contains 'second folder' "$QR_OUT" 'bar'
    assert_contains 'it said how the list is overridden' "$QR_OUT" '--no-config'
}

test_config_reports_folders_that_are_missing_or_not_repos() {
    setup_two_repos
    mkdir -p "$TEST_TMP/plain"
    write_config "$TEST_TMP/.quick-releaser.json" '["foo", "plain", "gone"]'

    qr config

    assert_contains 'the non-repo was flagged' "$QR_OUT" 'not a git repository'
    assert_contains 'the missing folder was flagged' "$QR_OUT" 'gone'
    assert_contains 'and said to be missing' "$QR_OUT" '— missing'
}

test_config_shows_both_the_entry_and_what_it_resolves_to() {
    setup_two_repos
    mkdir -p "$TEST_TMP/elsewhere"
    write_config "$TEST_TMP/elsewhere/config.json" '{"repos": ["../foo"]}'

    qr config --config elsewhere/config.json

    # A surprising resolution should be visible rather than something to work out.
    assert_contains 'the entry as written' "$QR_OUT" '../foo'
    assert_contains 'the folder it resolves to' "$QR_OUT" "($TEST_TMP/foo)"
}

test_config_says_where_it_looked_when_there_is_none() {
    setup_two_repos

    qr config

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'it said there is no config' "$QR_OUT" 'no config file'
    assert_contains 'it listed the local path' "$QR_OUT" '.quick-releaser.json'
    assert_contains 'and the config home one' "$QR_OUT" 'quick-releaser/config.json'
    assert_contains 'it pointed at the edit command' "$QR_OUT" 'config edit'
}

test_config_reports_a_broken_file_rather_than_printing_nothing() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" 'nonsense'

    qr config

    assert_eq 'exit status' "$QR_RC" 65
    assert_contains 'it said what is wrong' "$QR_OUT" 'not valid JSON'
}

test_config_takes_no_folders() {
    setup_two_repos

    qr config foo

    assert_eq 'exit status' "$QR_RC" 64
    assert_contains 'it said why' "$QR_OUT" 'takes no folders'
}

test_config_edit_opens_the_existing_file() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'
    fake_editor '["bar"]'

    qr config edit

    assert_eq 'exit status' "$QR_RC" 0
    assert_eq 'the editor got the config file' "$(edited_file)" "$TEST_TMP/.quick-releaser.json"
    assert_file_contains "$TEST_TMP/.quick-releaser.json" '["bar"]'
    assert_contains 'it printed the result' "$QR_OUT" '1 folder(s)'
    assert_contains 'the new folder' "$QR_OUT" 'bar'
}

test_config_edit_creates_a_config_when_there_is_none() {
    setup_two_repos
    fake_editor "{\"repos\": [\"$TEST_TMP/foo\"]}"

    qr config edit

    assert_eq 'exit status' "$QR_RC" 0
    # With no config anywhere the config home copy is the one to make: it is the
    # one that works from any directory.
    local created="$HOME/.config/quick-releaser/config.json"
    assert_eq 'the editor got the new file' "$(edited_file)" "$created"
    assert_contains 'it said it created it' "$QR_OUT" 'created'
    assert_file_contains "$created" "$TEST_TMP/foo"

    # And the next ordinary run picks it up.
    qr
    assert_contains 'the configured repo was processed' "$QR_OUT" 'Repo: foo'
}

test_the_created_config_is_usable_as_it_stands() {
    setup_two_repos
    quitting_editor

    qr config edit

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'an empty list is called out' "$QR_OUT" 'lists no folders'

    # The template has to be valid JSON, or the next run would abort on it.
    qr
    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'and it falls back to scanning' "$QR_OUT" 'Scanning'
}

test_config_edit_reports_a_file_the_editor_broke() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'
    fake_editor '{"repos": ['

    qr config edit

    assert_eq 'exit status' "$QR_RC" 65
    assert_contains 'it said what is wrong' "$QR_OUT" 'not valid JSON'
}

test_config_edit_reports_an_editor_that_failed() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'
    quitting_editor 3

    qr config edit

    assert_contains 'the editor status was reported' "$QR_OUT" 'exited with status 3'
    if [ "$QR_RC" -eq 0 ]; then _fail 'a failed editor must not look like success'; fi
}

test_visual_wins_over_editor() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'
    fake_editor '["foo"]'
    export VISUAL="$EDITOR"
    export EDITOR=/bin/false

    qr config edit

    assert_eq 'exit status' "$QR_RC" 0
    assert_eq 'VISUAL was the editor that ran' "$(edited_file)" "$TEST_TMP/.quick-releaser.json"
}

test_config_edit_warns_when_the_edited_file_is_shadowed() {
    setup_two_repos
    write_config "$TEST_TMP/.quick-releaser.json" '["foo"]'
    write_config "$HOME/.config/quick-releaser/config.json" '["bar"]'
    fake_editor '["bar"]'

    qr config edit --config "$HOME/.config/quick-releaser/config.json"

    assert_eq 'the named file was the one edited' "$(edited_file)" "$HOME/.config/quick-releaser/config.json"
    assert_contains 'the shadowing was pointed out' "$QR_OUT" 'is found first'
}

test_help_documents_the_config() {
    qr --help

    assert_eq 'exit status' "$QR_RC" 0
    assert_contains 'usage' "$QR_OUT" '--config'
    assert_contains 'usage' "$QR_OUT" '--no-config'
    assert_contains 'usage' "$QR_OUT" '.quick-releaser.json'
    assert_contains 'usage' "$QR_OUT" 'config edit'
}
