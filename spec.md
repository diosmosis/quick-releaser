# quick-releaser

## Description

A script that helps quickly create release commits/branches for multiple repos from the current directory.

## Commands

The script has these commands:

- `check`, the default, which only reports what would be released, as described in [Check Execution](#check-execution).
- `release`, which makes the release commits/branches as described in [Release Execution](#release-execution).
- `config` and `config edit`, which show and change the default set of projects, as described in
  [The Projects To Run On](#the-projects-to-run-on).

Reporting is the default and `release` has to be asked for by name, so running the script with no command — the
easiest thing to do by accident — can never write, commit or push anything.

## The Projects To Run On

Which folders a run works on is decided in this order, first one that applies:

1. the folders given as command line arguments.
2. the folders listed in a config file — see below.
3. every folder in the current directory that is a git repository.

So the config only ever supplies a *default*: naming folders on the command line ignores it entirely, and
`--no-config` ignores it too, going straight back to scanning the current directory.

The config file is looked for in this order, and the first one that exists is used:

1. `$QUICK_RELEASER_CONFIG`, or the file given with `--config <file>`. Naming a file that does not exist is an error.
2. `.quick-releaser.json` in the current directory — the natural place for a config that describes one folder of
   repos.
3. `$XDG_CONFIG_HOME/quick-releaser/config.json` (`~/.config/quick-releaser/config.json` by default) — the one that
   lets the tool be run from anywhere.

It is JSON, either a bare array of folders or an object with a `repos` array, so it has room to grow:

```json
{ "repos": ["~/src/my-plugin", "~/src/other-plugin"] }
```

1. a leading `~` is expanded, and relative paths are resolved against the directory the config file is in — not
   against wherever the tool was run from, which is the whole point of having one.
2. a config that exists but cannot be understood (bad JSON, not a list of folders) is a fatal error rather than
   something to ignore: quietly falling back to "every folder in the current directory" would run over a much larger
   set of repos than was asked for.
3. a configured folder that has gone missing or is not a git repository is reported, exactly as a folder named on the
   command line would be. Only scanned folders are skipped silently.
4. the `check` summary suggests a `release` command line with folder paths that work from the current directory, so it
   is still copy-pasteable when the configured repos live somewhere else.

### Inspecting And Editing It

Two commands work on the config file itself and never touch a repository:

1. `config` prints which file supplies the default list (or, when there is none, where it looked) and every folder the
   file names — as written and as resolved — saying for each whether it exists and is a git repository. A file that
   cannot be understood is reported the same way it is during a run, and exits non-zero.
2. `config edit` opens that file in `$VISUAL`, then `$EDITOR`, falling back to `vi` with a note. When there is no
   config anywhere it creates one first, from a template, at the config home path — the copy that works from any
   directory. Afterwards it re-reads the file and prints it exactly as `config` does, so a mistake is caught straight
   away rather than on the next run. If the file it edited is shadowed by one found earlier in the search order, it
   says so.

Both take no folder arguments, and `--config <file>` picks which file they work on.

## Release Execution

The `release` command should do the following for every repo it finds:

1. switch to the default branch for the repo, pull from origin and fast forward.
2. work out the last version that was actually released — see [Unreleased Version Bumps](#unreleased-version-bumps).
3. check if the current project needs a new release (a project needs a new release if there have been github pull requests merged
   since the last released version). if there are no changes, we skip this repo.
4. create and reset (if needed) a new branch named `new-release`.
5. for every pull request that was merged into the default branch since the last released version, ask the user for a changelog description.
   - this changelog description should be created interactively. the default value should be the pull request title (extracted from the merge commit).
   - if the user specifies empty text for the description, assume the item should not appear in the changelog. confirm with the user first however.
6. confirm the version to release with the user. by default it should be a patch version increase (but see below for when the version has
   already been bumped), and the user may want to specify a minor or major version bump instead.
7. add the changelog items to the changelog (wherever that may be for the project), and bump the version.
   - check both relevant release files for the project type, and source files for places the version needs to be bumped. in some projects it will be in multiple places.
8. commit the changes with the commit message `bumping version to {new_version}` (replacing `{new_version}` with the version to bump to).
9. push the `new-release` branch to origin

## Pull Requests That Must Not Cause A Release

A pull request whose title carries a `[no_release]` marker (`[ignore_release]` and `[skip_release]`, with spaces or
hyphens in place of the underscore, are the same thing) is test fixes, screenshot updates or CI chores. It:

1. does not make a release necessary on its own. a repo whose only unreleased pull requests are marked this way is
   reported as not needing a release.
2. is never asked about during a release run and gets no changelog line.
3. is still reported, in both commands, since it does ship with whatever release follows it.

## Unreleased Version Bumps

The version declared in a project's source is not proof that the version was released. These plugins often bump the
version inside an ordinary pull request and only tag (and publish a github release) later, so a project can sit at
5.3.9 while 5.3.8 is still its last real release.

The last *released* version is therefore worked out from evidence that a release actually happened, not from the
version file. Two things count, and the newest of them wins:

1. the newest version tag reachable from the default branch. tags named `v1.2.3` count the same as `1.2.3`; anything
   that is not a version is not a release.
2. for a WordPress plugin published in the [wordpress.org plugin directory](https://wordpress.org/plugins/), the
   version the directory is serving — see [wordpress.org](#wordpressorg) below.

When the declared version is ahead of the last released version:

1. the unreleased work is everything merged since the last release, not since the commit that set the declared version
   (which would hide every pull request that shipped with, or before, the bump).
2. the release to make is the declared version itself — nothing is bumped. it is offered as the default answer to the
   version question, and a higher version can still be entered to bump on top of it.
3. pull requests in that range that already edited the project's own (root level) changelog are assumed to have written
   their entry already. they are not asked about again, and they are reported so the assumption can be checked.
4. new changelog lines are appended to the existing entry for that version rather than starting a second entry for it.
5. since no version is bumped, the commit message is `updating changelog for {version}` instead. both messages are
   recognised as release commits when working out what is unreleased.
6. if there is nothing left to write — the version is bumped and its changelog is already complete — no commit is made.
   the repo only needs tagging/releasing, which is reported.

A project with no evidence of any release at all — never tagged, not in the plugin directory — falls back to the
original behaviour: measure from the commit that set the current version. A declared version *older* than the last
release is reported, since it usually means the release came from a different branch.

## wordpress.org

Plugins in the WordPress plugin directory are released by pushing to their SVN repo, which git knows nothing about, so
the git tags can lag badly: wp-matomo has shipped three versions past its newest tag. For a WordPress plugin, the
version `https://api.wordpress.org/plugins/info/1.0/{slug}.json` reports is therefore taken as a release like a tag is,
and whichever is newer decides what counts as released.

1. the slug is guessed in this order, and the first one the directory answers for is used: the slug named by the
   plugin's `Plugin URI` header when it points at wordpress.org (the old `/extend/plugins/` form included), the main
   plugin file's name, then the folder's name. Plugins are conventionally named after their slug, so the second guess
   covers the ones with no such header.
2. the directory reports a version but no commit, so the baseline is the commit that set that version in the version
   file. work merged after that point cannot have been in the release.
3. a published version that this branch never declared is reported and otherwise ignored — it means releases go out
   from somewhere else — and the tags decide instead.
4. a plugin the directory does not know is not an error; it just has no published version, so the tags decide.
5. it must never be able to break a run: any connection failure is reported once and the whole run falls back to tags.
   `--no-wporg` skips the lookups altogether, and Matomo plugins are never looked up at all.

## Check Execution

The `check` command (the default, also available as `--check`) only detects whether a new release is needed; it never
creates a release. For every repo it finds it should:

1. fetch from origin (tags included), then work out the last released version and the pull requests merged since it,
   using the same logic as the release command (steps 2, 3 and 5 above).
2. if no pull requests have been merged since the last release, report that no release is needed and move on — unless
   the declared version is itself unreleased, which still needs reporting (it needs tagging).
3. otherwise report that a release is needed and print every pull request that has been merged but not released yet,
   showing the PR number, the commit, the merge date and the pull request title.
   - a pull request that already wrote its own changelog entry is marked as such.
   - commits since the last release that are not associated with a pull request are listed separately, since they
     would not appear in the changelog.
4. finish with a summary listing each repo that needs a release, the version it would be released as (a patch bump, or
   the already-bumped-but-unreleased version), and its unreleased pull requests.

Requirements specific to this command:

1. it must be read-only. it fetches (so it reports on what is actually on origin), but it must not check out, pull,
   write, commit or push anything. the project's version is therefore read out of `origin/{default_branch}` rather than
   the working tree, so the command is safe to run against repos that are dirty or on another branch.
2. it must never prompt. where the release command would ask a question (for example when the commit that set the
   current version cannot be found), it reports the problem and skips the repo instead. this means it can run without
   an interactive terminal, e.g. from a script or cron job.
3. `--dry-run` is meaningless here and is ignored (with a note).

## Notes

1. The script is meant to run on WordPress plugins and Matomo plugins. So when looking for the current release or updating the release and changelog, it should follow the conventions of those types of projects. Other types of projects are not supported at present.
2. By default it should look at all folders in the current repo, but specific folders can be specified via command line arguments, or configured as a default set — see [The Projects To Run On](#the-projects-to-run-on).
3. mimic relevant parts of the implementation of another script located in ../dependency-update/update-dependencies.sh.
4. pull requests will normally be squashed then merged, but sometimes there will be a merge commit.
5. `--dry-run` prepares the release branch but does not commit or push. it applies to `release` only; `check` ignores it with a note.
6. the script can use bash, node.js or php, whichever claude thinks is most suited for this script.
7. the folder arguments apply to every command, e.g. `quick-releaser.js my-plugin` checks one repo only. a command
   word is only recognised as the first argument, so a folder actually named `check` or `release` can still be passed
   as `./check` or `./release`. the configured default list likewise applies to every command.

## Tests

`tests/run-tests.sh` runs the suite (`tests/run-tests.sh -h` for the options). Every test builds real git
repositories in a throwaway directory — a bare repo standing in for github plus a working clone — so fetching,
pulling and pushing the release branch are all exercised without the network, and no test can touch the machine it
runs on.

The release run is interactive, so the suite drives it through `QUICK_RELEASER_INPUT`: one answer per line, in the
order the questions are asked, where an empty line accepts the pre-filled default and `<empty>` submits an empty
answer. That is the only concession the script makes to being tested — every other code path is the real one.
