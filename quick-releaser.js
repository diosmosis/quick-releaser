#!/usr/bin/env node
/**
 * quick-releaser.js
 *
 * Iterates over every git repository in the current directory (or over the folders
 * given on the command line) and, for each one that needs a release:
 *
 *   1. Switches to the repo's default branch and pulls with fast-forward only
 *   2. Works out the last version that was actually RELEASED — the newest version tag
 *      reachable from the default branch, or, for a plugin in the WordPress plugin
 *      directory, the version wordpress.org is serving, whichever is newer — and
 *      compares it with the version the source declares. Those differ when a version
 *      bump has been merged but never released.
 *   3. Collects every pull request merged into the default branch since that release.
 *      Pull requests marked `[no_release]` are reported but do not count: they get no
 *      changelog line and never make a release necessary on their own.
 *      No merged PRs => no release needed => the repo is skipped
 *   4. Creates (or resets) a branch named `new-release`
 *   5. Asks interactively for a changelog line per pull request (the PR title is
 *      pre-filled as the default; an empty answer excludes the PR, after a confirm)
 *   6. Asks which version to release. The default is a patch bump, unless the declared
 *      version is already ahead of the last release, in which case that unreleased
 *      version is the default and nothing is bumped
 *   7. Writes the changelog entry and bumps the version everywhere it is declared
 *   8. Commits as `bumping version to {new_version}` (or `updating changelog for
 *      {version}` when no bump was needed) and pushes `new-release` to origin
 *
 * Supported project types (detected per repo):
 *   - WordPress plugins : `Version:` header in the main plugin file, `Stable tag:` in
 *                         readme.txt, version constants in source, changelog in
 *                         readme.txt's `== Changelog ==` section and/or CHANGELOG.md
 *   - Matomo plugins    : `version` in plugin.json, version constants in source,
 *                         changelog in CHANGELOG.md
 * Anything else is reported and skipped.
 *
 * The changelog format is not hardcoded: the existing entries in each file are
 * inspected and the new entry mimics their heading and bullet style.
 *
 * Commands:
 *   check       (default) Only report which repos need a release, listing the pull
 *               requests merged since the last release. Read-only: it fetches, but
 *               never checks out, pulls, writes, commits or pushes, and never prompts,
 *               so it is safe to run over dirty working trees and from scripts.
 *   release     Run the interactive release described above, which is the only thing
 *               that writes anything: nothing is created or pushed unless this command
 *               is asked for by name.
 *   config      Show the config file in use and the folders it lists.
 *   config edit Open that file in $VISUAL/$EDITOR, creating it if it does not exist
 *               yet, and report what it lists once the editor is done.
 *
 * Options:
 *   --check     Same as the `check` command.
 *   --dry-run   With `release`, do everything EXCEPT commit and push. The `new-release`
 *               branch is left in place with the changes so you can inspect the diff.
 *   --no-wporg  Skip the wordpress.org lookup and go by version tags alone.
 *   --config F  Read the default folder list from F instead of the usual places.
 *   --no-config Ignore any config file and go back to scanning the current directory.
 *   -h, --help  Show usage.
 *
 * Arguments:
 *   [repo ...]  One or more folders to process. If none are given, the folders named
 *               by the config file are processed; with no config either, every folder
 *               in the current directory that is a git repo is.
 *
 * A failure in one repo is reported and skipped; it does not abort the whole run.
 *
 * Tests live in tests/; run them with tests/run-tests.sh.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const BRANCH = 'new-release';

// --- argument parsing --------------------------------------------------------
let DRY_RUN = false;
// Reporting is the default; making and pushing release commits has to be asked for by
// name. Running the tool with no command can then never change anything.
let CHECK_ONLY = true;
// WordPress plugins are released to wordpress.org, which is authoritative about what
// actually shipped. QUICK_RELEASER_NO_WPORG exists for the test suite, which must not
// depend on the network.
let USE_WPORG = !process.env.QUICK_RELEASER_NO_WPORG;
// An explicit --config wins over the usual search; --no-config turns the whole
// mechanism off for this run.
let CONFIG_PATH = process.env.QUICK_RELEASER_CONFIG || null;
let NO_CONFIG = false;
// 'repos' — the usual run over the repositories; 'config' / 'config-edit' — look at
// the config file itself instead, and touch no repository at all.
let COMMAND = 'repos';
const REPOS = []; // explicit repo list from positional args; empty => config, else scan

// The config file that supplies the default folder list. A copy in the folder the
// repos live in is the common case; the one under the config home is for running
// from anywhere.
const CONFIG_BASENAME = '.quick-releaser.json';

function configHome() {
	return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function usage() {
	const me = path.basename(process.argv[1]);
	console.log(`Usage: ${me} [check|release|config [edit]] [--dry-run] [--no-wporg]
       [--config <file>] [--no-config] [-h|--help] [repo ...]

  check         (default) Only report which repos need a release and which pull
                requests are not in a release yet. Never modifies anything and
                never asks anything. \`--check\` does the same.
  release       Make the release commits: create the \`${BRANCH}\` branch, ask for a
                changelog line per pull request and for the version, then commit
                and push. Nothing is written unless this command is given.
  config        Show which config file is in use and which folders it lists.
  config edit   Open that file in \$VISUAL/\$EDITOR, creating it from a template if
                it does not exist yet, then show what it ended up listing.
  --dry-run     With \`release\`, prepare the branch but do NOT commit or push.
  --no-wporg    Do not ask wordpress.org which version of a WordPress plugin is
                published; go by the repo's version tags alone. Useful offline.
  --config F    Take the default folder list from F rather than from the usual
                places (below). It is an error if F does not exist.
  --no-config   Ignore any config file; scan the current directory instead.
  -h, --help    Show this help.

  repo ...      Optional list of folders to process. When omitted, the folders
                named by the config file are processed; with no config either,
                every folder in the current directory that is a git repository
                is. (A folder actually named "check", "release" or "config" has
                to be given as ./check, ./release or ./config.)

Config file, searched for in this order and used only when no folder is given
on the command line:

  \$QUICK_RELEASER_CONFIG
  ./${CONFIG_BASENAME}
  ${path.join(configHome(), 'quick-releaser', 'config.json')}

It is JSON: either a bare array of folders, or an object with a "repos" array.
Relative paths are taken relative to the config file itself, and a leading ~ is
expanded, so a config anywhere can name the folders plainly:

  { "repos": ["~/src/my-plugin", "~/src/other-plugin"] }

Examples:
  ${me}                             # report on the configured repos (or this dir)
  ${me} my-plugin ../other          # …on these two only, config ignored
  ${me} --no-config                 # …on every git repo in the current dir
  ${me} release                     # make the release commits for the configured repos
  ${me} release --dry-run my-plugin # prepare them without committing or pushing
  ${me} config                      # show the configured folders
  ${me} config edit                 # change them in your editor`);
}

{
	const argv = process.argv.slice(2);
	// Commands are only recognised in the first position; that keeps a folder that
	// happens to be named "check" or "release" reachable as ./check or ./release.
	if (argv[0] === 'check' || argv[0] === 'release') {
		CHECK_ONLY = argv[0] === 'check';
		argv.shift();
	} else if (argv[0] === 'config') {
		argv.shift();
		// `config` on its own shows the file; `show` says the same thing out loud.
		COMMAND = 'config';
		if (argv[0] === 'edit' || argv[0] === 'show') {
			COMMAND = argv[0] === 'edit' ? 'config-edit' : 'config';
			argv.shift();
		}
	}
	while (argv.length) {
		const arg = argv.shift();
		if (arg === '--dry-run') {
			DRY_RUN = true;
		} else if (arg === '--check') {
			CHECK_ONLY = true;
		} else if (arg === '--no-wporg') {
			USE_WPORG = false;
		} else if (arg === '--no-config') {
			NO_CONFIG = true;
		} else if (arg === '--config' || arg.startsWith('--config=')) {
			CONFIG_PATH = arg.startsWith('--config=') ? arg.slice('--config='.length) : argv.shift();
			if (!CONFIG_PATH) {
				console.error('--config needs a file');
				process.exit(64);
			}
		} else if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		} else if (arg === '--') {
			REPOS.push(...argv);
			break;
		} else if (arg.startsWith('-')) {
			console.error(`Unknown option: ${arg}`);
			usage();
			process.exit(64);
		} else {
			REPOS.push(arg);
		}
	}
}

// --- colored logging helpers -------------------------------------------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const info = (...a) => console.log(`${c('1;34', '==>')} ${a.join(' ')}`);
const ok = (...a) => console.log(`${c('1;32', '  ✓')} ${a.join(' ')}`);
const warn = (...a) => console.log(`${c('1;33', '  !')} ${a.join(' ')}`);
const err = (...a) => console.log(`${c('1;31', '  ✗')} ${a.join(' ')}`);
const note = (...a) => console.log(`    ${a.join(' ')}`);

// --- the configured default folder list --------------------------------------
/**
 * The folders to work on when none are named on the command line. Without a config
 * that is "every git repo in the current directory", which is only useful from the
 * one directory the repos happen to live in; a config lets the tool be run from
 * anywhere, and lets a directory holding more repos than you release name just the
 * ones you do.
 *
 * Command line arguments always win: the config supplies a default, never a filter.
 */
function defaultConfigPaths() {
	return [
		path.resolve(process.cwd(), CONFIG_BASENAME),
		path.join(configHome(), 'quick-releaser', 'config.json'),
	];
}

function configCandidatePaths() {
	return CONFIG_PATH ? [path.resolve(expandHome(CONFIG_PATH))] : defaultConfigPaths();
}

function expandHome(p) {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** The first config file that exists, or null. */
function findConfigFile() {
	return configCandidatePaths().find((f) => fs.existsSync(f)) || null;
}

/**
 * Read one config file. Returns { entries, repos } — the folders as they are written
 * in the file, and the same folders resolved to absolute paths — or { error } when
 * the file is not something we can act on.
 */
function parseConfigFile(file) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return { error: `not valid JSON (${e.message})` };
	}
	const listed = Array.isArray(parsed)
		? parsed
		: (parsed && typeof parsed === 'object' && Array.isArray(parsed.repos) ? parsed.repos : null);
	if (!listed) {
		return { error: 'expected an array of folders, or an object with a "repos" array' };
	}
	if (listed.some((r) => typeof r !== 'string' || !r.trim())) {
		return { error: 'every entry must be a non-empty folder name' };
	}

	// Relative entries are relative to the config file, not to wherever the tool
	// happens to be run from — that is the whole point of having one.
	const base = path.dirname(file);
	const entries = [];
	const repos = [];
	for (const raw of listed) {
		const entry = raw.trim().replace(/\/+$/, '');
		const resolved = path.resolve(base, expandHome(entry));
		if (repos.includes(resolved)) continue;
		entries.push(entry);
		repos.push(resolved);
	}
	return { entries, repos };
}

/**
 * Read the first config file that exists. Returns { file, repos } with the folders
 * resolved to absolute paths, or null when there is no config to use.
 *
 * A config that exists but cannot be understood is fatal rather than ignored:
 * silently falling back to "every folder in the current directory" would run the
 * tool over a much larger set of repos than the one that was asked for.
 */
function loadConfig() {
	if (NO_CONFIG) return null;

	const file = findConfigFile();
	if (!file) {
		if (CONFIG_PATH) {
			console.error(`no such config file: ${CONFIG_PATH}`);
			process.exit(66);
		}
		return null;
	}

	const parsed = parseConfigFile(file);
	if (parsed.error) {
		console.error(`${file}: ${parsed.error}`);
		process.exit(65);
	}
	if (!parsed.repos.length) {
		warn(`${file} lists no folders — ignoring it`);
		return null;
	}
	return { file, repos: parsed.repos };
}

/** A folder as it is worth printing back at the user: relative when it is nearby. */
function shortPath(dir) {
	const rel = path.relative(process.cwd(), dir);
	return rel && !rel.startsWith('..') ? rel : dir;
}

// --- the `config` command ----------------------------------------------------
// What a brand new config file is seeded with. JSON has no comments, so the note
// about how the file is read has to live in a field of its own — anything that is
// not "repos" is ignored, so it costs nothing to keep it there.
const CONFIG_TEMPLATE = {
	_comment: 'Folders quick-releaser works on when none are given on the command line. '
		+ 'Relative paths are relative to this file, and a leading ~ is expanded.',
	repos: [],
};

/** Print a config file and the state of every folder it names. */
function printConfig(file, parsed) {
	info(`config: ${file}`);
	if (!parsed.repos.length) {
		warn('it lists no folders, so it is ignored — every git repo in the current directory is processed');
		return;
	}
	info(`${parsed.repos.length} folder(s):`);
	for (let i = 0; i < parsed.repos.length; i++) {
		const dir = parsed.repos[i];
		const entry = parsed.entries[i];
		// A relative or ~-prefixed entry is worth showing both ways: as it is written
		// in the file, and as the folder it actually resolves to.
		const shown = entry === dir ? entry : `${entry}  ${c('0;90', `(${dir})`)}`;
		if (!fs.existsSync(dir)) {
			err(`${shown} — missing`);
		} else if (!fs.existsSync(path.join(dir, '.git'))) {
			warn(`${shown} — not a git repository`);
		} else {
			ok(shown);
		}
	}
}

/** `config` — say which file supplies the default folder list, and what is in it. */
function showConfig() {
	const me = path.basename(process.argv[1]);
	const file = findConfigFile();

	if (!file) {
		if (CONFIG_PATH) {
			err(`no such config file: ${CONFIG_PATH}`);
			return 66;
		}
		warn('no config file — every git repository in the current directory is processed');
		note('looked for:');
		for (const f of configCandidatePaths()) note(`  ${f}`);
		note(`run '${me} config edit' to make one.`);
		return 0;
	}

	const parsed = parseConfigFile(file);
	if (parsed.error) {
		err(`${file}: ${parsed.error}`);
		note(`fix it with '${me} config edit'.`);
		return 65;
	}

	printConfig(file, parsed);
	note('folders named on the command line are used instead of these; --no-config ignores them.');
	if (NO_CONFIG) warn('--no-config was given, so a run right now would ignore this file');
	return 0;
}

/** The editor to open the config in, and whether we had to guess it. */
function editorCommand() {
	const configured = process.env.VISUAL || process.env.EDITOR;
	return configured ? { command: configured, guessed: false } : { command: 'vi', guessed: true };
}

/**
 * `config edit` — open the config file in the user's editor, creating it from the
 * template first if there is none yet, and report what it lists afterwards.
 */
function editConfig() {
	const me = path.basename(process.argv[1]);
	// Where a config would be read from, or — when there is none anywhere — the one
	// under the config home, since that is the copy that works from any directory.
	const file = CONFIG_PATH
		? path.resolve(expandHome(CONFIG_PATH))
		: (findConfigFile() || path.join(configHome(), 'quick-releaser', 'config.json'));

	if (!fs.existsSync(file)) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`);
		} catch (e) {
			err(`could not create ${file}: ${e.message}`);
			return 73;
		}
		ok(`created ${file}`);
	}

	const editor = editorCommand();
	if (editor.guessed) warn(`neither $VISUAL nor $EDITOR is set — using ${editor.command}`);
	info(`opening ${file} in ${editor.command}`);

	// The file goes in as an argument rather than inside the command string, so a
	// path with spaces in it survives, and $EDITOR can carry its own options.
	const res = spawnSync('sh', ['-c', `${editor.command} "$@"`, 'sh', file], { stdio: 'inherit' });
	if (res.error) {
		err(`could not run ${editor.command}: ${res.error.message}`);
		return 73;
	}
	if (res.status !== 0) {
		err(`${editor.command} exited with status ${res.status} — leaving ${file} alone`);
		return 73;
	}

	const parsed = parseConfigFile(file);
	if (parsed.error) {
		err(`${file}: ${parsed.error}`);
		note(`the file was saved as it is; run '${me} config edit' again to fix it.`);
		return 65;
	}
	printConfig(file, parsed);

	// Editing a file that something else shadows would otherwise look like it took
	// effect when it did not. Only `--config` can get us here: without it we always
	// edit the file the search finds.
	const inUse = defaultConfigPaths().find((f) => fs.existsSync(f));
	if (inUse && path.resolve(inUse) !== path.resolve(file)) {
		warn(`${inUse} is found first, so runs without --config will use that one instead`);
	}
	return 0;
}

// --- summary state -----------------------------------------------------------
let processed = 0;
let released = 0;
let skipped = 0;
let failed = 0;
// Set by the commands that have something more specific to say than "a repo failed".
let exitCode = null;
const releaseReport = []; // { repo, version, entries, pushed }
const checkReport = []; // { repo, version, suggested, prs, others } — check mode only
const followUps = []; // { repo, detail } — version strings we deliberately did not touch

// --- git helpers -------------------------------------------------------------
function git(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run git, returning trimmed stdout, or null when the command fails. */
function gitOut(cwd, args) {
	try {
		return git(cwd, args).trim();
	} catch (e) {
		return null;
	}
}

/** Run git for its side effect. Returns true on success. */
function gitOk(cwd, args) {
	try {
		git(cwd, args);
		return true;
	} catch (e) {
		return false;
	}
}

/** The stderr of a failed git command, for error reporting. */
function gitError(e) {
	const out = (e && (e.stderr || e.stdout) || '').toString().trim();
	return out.split('\n').slice(0, 3).join(' / ') || (e && e.message) || 'unknown error';
}

/**
 * Determine the default branch for a repo (via origin/HEAD, with fallbacks).
 *
 * The local origin/HEAD can be STALE — e.g. still pointing at origin/master after
 * the remote renamed its default to main. Trust it only if the branch it names
 * still exists; otherwise refresh the pointer from the remote.
 */
function detectDefaultBranch(cwd) {
	const read = () => {
		const ref = gitOut(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
		return ref ? ref.replace(/^refs\/remotes\/origin\//, '') : '';
	};
	const exists = (b) => b && gitOk(cwd, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]);

	let b = read();
	if (!exists(b)) {
		gitOk(cwd, ['remote', 'set-head', 'origin', '--auto']);
		b = read();
	}
	// Last-resort guess if the remote still didn't give us a usable default.
	if (!exists(b)) {
		b = ['main', 'master', 'develop'].find(exists) || '';
	}
	return b;
}

// --- interactive prompt helpers ----------------------------------------------
/**
 * The test suite drives the release run through this: QUICK_RELEASER_INPUT holds one
 * answer per line, in the order the questions are asked. Everything else behaves
 * exactly as it does interactively, so the tests exercise the real code path.
 *
 *   an empty line   accept the pre-filled default (what pressing Enter does)
 *   <empty>         submit an empty answer (what clearing the line does)
 */
const SCRIPTED_ANSWERS = process.env.QUICK_RELEASER_INPUT === undefined
	? null
	: process.env.QUICK_RELEASER_INPUT.split('\n');

let rlInstance = null;
function rl() {
	if (!rlInstance) {
		rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
		rlInstance.on('SIGINT', () => {
			console.log('\naborted.');
			process.exit(130);
		});
	}
	return rlInstance;
}
function closeRl() {
	if (rlInstance) {
		rlInstance.close();
		rlInstance = null;
	}
}

/**
 * Ask a question with `defaultValue` pre-typed into the prompt, so the user can
 * accept it with Enter, edit it, or clear it entirely.
 */
function ask(question, defaultValue = '') {
	if (SCRIPTED_ANSWERS) {
		if (!SCRIPTED_ANSWERS.length) {
			console.error(`\nscripted input exhausted at: ${question}`);
			process.exit(70);
		}
		const line = SCRIPTED_ANSWERS.shift();
		const answer = line === '' ? defaultValue : (line === '<empty>' ? '' : line);
		console.log(`${question}${answer}`);
		return Promise.resolve(answer.trim());
	}
	return new Promise((resolve) => {
		const r = rl();
		r.question(question, (answer) => resolve(answer.trim()));
		if (defaultValue) {
			r.write(defaultValue);
		}
	});
}

async function askYesNo(question, defaultYes = true) {
	const suffix = defaultYes ? '[Y/n]' : '[y/N]';
	for (;;) {
		const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
		if (answer === '') return defaultYes;
		if (['y', 'yes'].includes(answer)) return true;
		if (['n', 'no'].includes(answer)) return false;
	}
}

// --- project detection -------------------------------------------------------
const JSON_VERSION_RE = /("version"\s*:\s*")([^"]+)(")/;
const PHP_HEADER_VERSION_RE = /^(\s*(?:\*\s*)?Version\s*:\s*)([0-9][^\s*]*)\s*$/im;
const STABLE_TAG_RE = /^(\s*Stable tag\s*:\s*)([0-9][^\s]*)\s*$/im;
// `Plugin URI: https://wordpress.org/plugins/wp-piwik/` names the directory slug
// outright. The old /extend/ form is still in plenty of headers.
const PLUGIN_URI_SLUG_RE = /Plugin URI\s*:\s*\S*wordpress\.org\/(?:extend\/)?plugins\/([A-Za-z0-9][A-Za-z0-9._-]*)/i;

/**
 * Detection reads a handful of files at the top of the repo. It is fed through a
 * reader so the same code can look either at the checked-out working tree (the
 * release run, which has just pulled the default branch) or straight at a git ref
 * (the `check` command, which must not touch the working tree at all).
 *
 * `listRoot()` yields the names of the files in the repo root; `read(rel)` yields
 * a file's contents, or null when it does not exist.
 */
function worktreeReader(cwd) {
	return {
		listRoot: () => fs.readdirSync(cwd).filter((f) => fs.statSync(path.join(cwd, f)).isFile()),
		read: (rel) => {
			const abs = path.join(cwd, rel);
			return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
		},
	};
}

function refReader(cwd, ref) {
	return {
		listRoot: () => {
			const out = gitOut(cwd, ['ls-tree', ref]); // "<mode> <type> <sha>\t<name>"
			if (!out) return [];
			return out.split('\n')
				.filter((l) => / blob /.test(l))
				.map((l) => l.slice(l.indexOf('\t') + 1))
				.filter(Boolean);
		},
		read: (rel) => gitOut(cwd, ['show', `${ref}:${rel}`]),
	};
}

/**
 * Identify the project type and where its "current release" version lives.
 * Returns null when the repo is not a supported project type.
 */
function detectProject(reader) {
	// --- WordPress plugin: a root php file carrying the plugin header ---------
	const phpFiles = reader.listRoot().filter((f) => f.endsWith('.php'));
	for (const file of phpFiles) {
		const content = reader.read(file);
		if (content === null) continue;
		const head = content.slice(0, 8192);
		if (!/^\s*(?:\*\s*)?Plugin Name\s*:/im.test(head)) continue;
		const slugMatch = head.match(PLUGIN_URI_SLUG_RE);
		const wporgSlug = slugMatch ? slugMatch[1].toLowerCase() : null;
		const m = head.match(PHP_HEADER_VERSION_RE);
		if (m) {
			return { type: 'wordpress', versionFile: file, version: m[2].trim(), mainFile: file, wporgSlug };
		}
		// Header present but no Version: line — fall back to readme.txt's stable tag.
		const readme = reader.read('readme.txt');
		if (readme !== null) {
			const tag = readme.match(STABLE_TAG_RE);
			if (tag) {
				return { type: 'wordpress', versionFile: 'readme.txt', version: tag[2].trim(), mainFile: file, wporgSlug };
			}
		}
	}

	// --- Matomo plugin: plugin.json with a version ---------------------------
	const pluginJson = reader.read('plugin.json');
	if (pluginJson !== null) {
		let parsed = null;
		try {
			parsed = JSON.parse(pluginJson);
		} catch (e) {
			/* handled below */
		}
		if (parsed && parsed.version) {
			return { type: 'matomo', versionFile: 'plugin.json', version: String(parsed.version), mainFile: `${parsed.name || ''}.php` };
		}
	}

	return null;
}

/** Read the project's version out of a specific commit, or null if unavailable. */
function versionAtCommit(cwd, project, sha) {
	const content = gitOut(cwd, ['show', `${sha}:${project.versionFile}`]);
	if (content === null) return null;
	if (project.versionFile === 'plugin.json') {
		const m = content.match(JSON_VERSION_RE);
		return m ? m[2] : null;
	}
	if (project.versionFile === 'readme.txt') {
		const m = content.match(STABLE_TAG_RE);
		return m ? m[2].trim() : null;
	}
	const m = content.match(PHP_HEADER_VERSION_RE);
	return m ? m[2].trim() : null;
}

/**
 * Find the commit that set the version to `version`: walk the commits touching the
 * version file newest-first, skip past the newer versions, then keep going while they
 * still carry the one we want. The oldest of those is the commit that set it.
 */
function findVersionSetCommit(cwd, project, branchRef, version) {
	const log = gitOut(cwd, ['log', '--first-parent', '--format=%H', branchRef, '--', project.versionFile]);
	if (!log) return null;
	let bump = null;
	for (const sha of log.split('\n').filter(Boolean)) {
		if (versionAtCommit(cwd, project, sha) === version) {
			bump = sha;
		} else if (bump) {
			break;
		}
	}
	return bump;
}

/** The commit that bumped the version to the value the source declares today. */
function findVersionBumpCommit(cwd, project, branchRef) {
	return findVersionSetCommit(cwd, project, branchRef, project.version);
}

// --- pull request collection -------------------------------------------------
const US = '\x1f'; // field separator
const RS = '\x1e'; // record separator

// The convention across these plugins for work that must not cause a release: test
// fixes, screenshot updates, CI chores. Written into the pull request title, so it
// arrives in the squash subject or in the merge commit body.
const NO_RELEASE_RE = /\[\s*(?:no|ignore|skip)[ _-]?release\s*\]/i;

/**
 * Collect the pull requests merged into the default branch since `sinceSha`.
 *
 * PRs are normally squashed (a single commit whose subject ends in `(#123)`) but
 * can also arrive as a merge commit (`Merge pull request #123 from …`), so both
 * shapes are recognised. Commits that belong to neither shape are returned
 * separately so the run can tell the user what it did not put in the changelog.
 *
 * Each pull request carries a `noRelease` flag for the `[no_release]` marker. They are
 * returned like any other so callers can report them, but they do not justify a release
 * on their own and get no changelog line.
 */
function collectPullRequests(cwd, branchRef, sinceSha) {
	const range = sinceSha ? `${sinceSha}..${branchRef}` : branchRef;
	// The body comes last: it is the only field that can contain newlines.
	const raw = gitOut(cwd, ['log', '--first-parent', '--date=short', `--format=%H${US}%P${US}%ad${US}%s${US}%b${RS}`, range]);
	const prs = [];
	const others = [];
	if (!raw) return { prs, others };

	for (const record of raw.split(RS)) {
		const trimmed = record.replace(/^\n+/, '');
		if (!trimmed.trim()) continue;
		const [sha, parents, date, subject, body = ''] = trimmed.split(US);
		const isMerge = parents.trim().split(/\s+/).filter(Boolean).length > 1;

		// A previous release commit, e.g. left behind by a partially-completed run.
		if (/^(bumping version to|updating changelog for) /i.test(subject)) continue;

		const noRelease = (t) => NO_RELEASE_RE.test(t) || NO_RELEASE_RE.test(subject);

		const mergeMatch = subject.match(/^Merge pull request #(\d+)\b/);
		if (isMerge && mergeMatch) {
			// The PR title is the first non-empty line of the merge commit body.
			const title = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
			prs.push({ sha, date, number: mergeMatch[1], title: title || subject, noRelease: noRelease(title || '') });
			continue;
		}

		const squashMatch = subject.match(/\(#(\d+)\)\s*$/);
		if (squashMatch) {
			const title = subject.replace(/\s*\(#\d+\)\s*$/, '').trim();
			prs.push({ sha, date, number: squashMatch[1], title, noRelease: noRelease(title) });
			continue;
		}

		others.push({ sha, date, subject: subject.trim() });
	}

	// git log is newest-first; changelog entries read better oldest-first.
	prs.reverse();
	others.reverse();
	return { prs, others };
}

// --- version arithmetic ------------------------------------------------------
function parseVersion(v) {
	const m = String(v).match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: m[3] === undefined ? 0 : +m[3] };
}

function bumpVersion(version, kind) {
	const p = parseVersion(version);
	if (!p) return null;
	if (kind === 'major') return `${p.major + 1}.0.0`;
	if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
	return `${p.major}.${p.minor}.${p.patch + 1}`;
}

const VALID_VERSION_RE = /^\d+\.\d+(\.\d+)?([-.+][0-9A-Za-z.-]+)?$/;

/** <0 / 0 / >0, comparing major.minor.patch only. Unparseable versions compare equal. */
function compareVersions(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return 0;
	return (pa.major - pb.major) || (pa.minor - pb.minor) || (pa.patch - pb.patch);
}

// --- wordpress.org -----------------------------------------------------------
// A plugin published in the WordPress plugin directory is released by pushing to its
// SVN repo, which git knows nothing about: wp-matomo, for instance, has shipped three
// versions past its newest git tag. For those plugins the directory is the authority on
// what is actually out there.
const WPORG_API = process.env.QUICK_RELEASER_WPORG_API || 'https://api.wordpress.org/plugins/info/1.0';
const WPORG_TIMEOUT_MS = 6000;
// One connection failure is enough to conclude we are offline; the rest of the run then
// goes by tags alone rather than stalling on every WordPress plugin it meets.
let wporgReachable = true;

/** GET a JSON document. Resolves to { status, body }; never rejects. */
function fetchJson(url) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const client = url.startsWith('http://') ? http : https;
		const req = client.get(url, { timeout: WPORG_TIMEOUT_MS, headers: { 'user-agent': 'quick-releaser' } }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				done({ status: res.statusCode, body: null });
				return;
			}
			let raw = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { raw += chunk; });
			res.on('end', () => {
				try {
					done({ status: 200, body: JSON.parse(raw) });
				} catch (e) {
					done({ status: 200, body: null });
				}
			});
		});
		req.on('timeout', () => req.destroy(new Error('timed out')));
		req.on('error', () => done({ status: 0, body: null }));
	});
}

/**
 * The slugs this plugin might be published under, best guess first: the one its
 * `Plugin URI` header names, then the main file's name, then the folder's. WordPress
 * plugins are conventionally named after their slug, so the second guess is usually
 * right when the header is missing — matomo-for-wordpress ships `matomo.php`.
 */
function wporgSlugCandidates(project, repoName) {
	const candidates = [
		project.wporgSlug,
		path.basename(project.mainFile || '', '.php'),
		repoName,
	];
	const seen = new Set();
	return candidates
		.map((s) => (s || '').toLowerCase())
		.filter((s) => /^[a-z0-9][a-z0-9._-]*$/.test(s) && !seen.has(s) && seen.add(s));
}

/** The version wordpress.org is serving for this plugin, or null if it is not there. */
async function findWporgRelease(project, repoName) {
	if (!USE_WPORG || project.type !== 'wordpress' || !wporgReachable) return null;

	for (const slug of wporgSlugCandidates(project, repoName)) {
		const res = await fetchJson(`${WPORG_API}/${encodeURIComponent(slug)}.json`);
		if (res.status === 0) {
			// Could not connect at all, as opposed to "no such plugin".
			wporgReachable = false;
			return null;
		}
		if (res.status !== 200 || !res.body || res.body.error || !res.body.version) continue;
		return { slug, version: String(res.body.version) };
	}
	return null;
}

// --- what was actually released ----------------------------------------------
// Tag names that name a version. Anything else (`latest`, `dev`, …) is not a release.
const TAG_VERSION_RE = /^v?\d+\.\d+(\.\d+)?$/;

/**
 * The newest version tag reachable from `branchRef` — i.e. the last version that was
 * really released, as opposed to the version the source happens to declare.
 *
 * `--merged` matters: a tag cut on some other branch says nothing about what has been
 * released from the branch we are about to cut a release from.
 */
function findLatestReleaseTag(cwd, branchRef) {
	const out = gitOut(cwd, ['tag', '--merged', branchRef]);
	if (!out) return null;

	let best = null;
	for (const tag of out.split('\n').map((t) => t.trim()).filter(Boolean)) {
		if (!TAG_VERSION_RE.test(tag)) continue;
		const version = tag.replace(/^v/, '');
		if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
	}
	if (!best) return null;

	// Annotated tags point at a tag object, so resolve through to the commit.
	best.sha = gitOut(cwd, ['rev-list', '-n', '1', `refs/tags/${best.tag}`]);
	best.date = gitOut(cwd, ['log', '-1', '--format=%ad', '--date=short', `refs/tags/${best.tag}`]);
	return best.sha ? best : null;
}

/**
 * Work out what the next release is measured against, and what version it should be.
 *
 * The version declared in the source is NOT proof that the version was released. These
 * plugins routinely bump the version inside an ordinary pull request and only tag (and
 * publish) the release later, so a repo can sit at 5.3.9 while 5.3.8 is still its last
 * real release. When that happens:
 *   - the unreleased work is everything merged since the 5.3.8 RELEASE, not since the
 *     commit that set 5.3.9 (which would hide every PR that went out with, or before,
 *     the bump);
 *   - the release to make is 5.3.9 itself, so nothing needs bumping — only the changelog
 *     may need topping up before it goes out.
 *
 * Two things count as evidence that a version really shipped, and the newest of them
 * wins: a version tag reachable from this branch, and — for a plugin in the WordPress
 * plugin directory — the version wordpress.org is serving. They disagree in both
 * directions: a tag can be cut before the deploy, and a wordpress.org release is pushed
 * over SVN, which can happen without a tag ever being made (wp-matomo has shipped three
 * versions past its newest tag).
 *
 * With no evidence at all — never tagged, not on wordpress.org — we fall back to the
 * original behaviour and measure from the commit that set the current version.
 */
async function resolveBaseline(cwd, project, branchRef, repoName) {
	let tag = findLatestReleaseTag(cwd, branchRef);
	if (!tag) {
		// A plain fetch auto-follows tags that point into the history it fetched, so the
		// release tags on this branch are normally here already. Finding none is the one
		// case worth spending a second round trip on — the remote may be configured not
		// to send tags at all.
		if (gitOk(cwd, ['fetch', '--tags', 'origin'])) tag = findLatestReleaseTag(cwd, branchRef);
	}

	let released = tag ? { version: tag.version, sha: tag.sha, label: `tag ${tag.tag}, ${tag.date}` } : null;

	const wporg = await findWporgRelease(project, repoName);
	if (wporg && (!released || compareVersions(wporg.version, released.version) > 0)) {
		// wordpress.org names a version but no commit, so find where that version was
		// set: nothing merged after that point can have been part of the release.
		const sha = findVersionSetCommit(cwd, project, branchRef, wporg.version);
		released = sha
			? { version: wporg.version, sha, label: `published on wordpress.org as "${wporg.slug}"` }
			// Published, but this branch never declared that version — released from
			// somewhere else. Keep the tag as the baseline and let the caller say so.
			: { ...(released || {}), unplaced: wporg };
	}

	if (released && released.sha && compareVersions(project.version, released.version) > 0) {
		return { pending: true, released, sinceSha: released.sha, target: project.version };
	}

	const bumpCommit = findVersionBumpCommit(cwd, project, branchRef);
	return {
		pending: false,
		released: released && released.version ? released : null,
		unplaced: released && released.unplaced,
		// The declared version is BEHIND what shipped — released from another branch, or
		// the version file was reverted. Worth saying out loud before releasing again.
		behind: !!(released && released.version) && compareVersions(project.version, released.version) < 0,
		bumpCommit,
		sinceSha: bumpCommit,
		target: bumpVersion(project.version, 'patch'),
	};
}

/**
 * Did this commit write the project's own changelog? A pull request that already wrote
 * its changelog line must not be asked about again when we catch up on an unreleased
 * version.
 *
 * Only the changelog files at the repo root count. Plugins here embed copies of other
 * projects (a WordPress plugin, a vendored library), and those bring changelogs of their
 * own that say nothing about whether this release is documented.
 *
 * `--first-parent -m` is needed to see through merge commits, which otherwise report no
 * changed files at all.
 */
function commitTouchedChangelog(cwd, sha, project) {
	const ours = projectChangelogFiles(project);
	const out = gitOut(cwd, ['diff-tree', '-r', '-m', '--first-parent', '--no-commit-id', '--name-only', sha]);
	if (!out) return false;
	return out.split('\n').map((f) => f.trim()).some((f) => ours.has(f.toLowerCase()));
}

// --- version bumping across the repo ----------------------------------------
// Third-party code and generated files. A version string in there belongs to some
// dependency that merely happens to share our version number, so it is skipped
// without a word — reporting it would bury the interesting cases in noise.
const VENDORED_DIRS = new Set([
	'node_modules', 'vendor', 'dist', 'build', 'third_party', 'coverage', 'artifacts', 'node',
]);
const VENDORED_FILES = new Set([
	'package-lock.json', 'composer.lock', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
]);
// Our own directories that a release should not normally touch — embedded copies
// of other projects, fixtures, translations, and so on. Skipped, but reported, so
// a version declaration that genuinely does belong to the release can be spotted.
const NON_RELEASE_DIRS = new Set([
	'app', 'libs', 'lib', 'plugins', 'tests', 'test', 'assets', 'languages',
	'screenshots', 'patches', 'misc',
]);

function isChangelogPath(rel) {
	return /(^|\/)(changelog|changes|history)(\.[a-z]+)?$/i.test(rel);
}

// Root-level changelog file names, newest-convention first. `writeChangelogs` picks the
// first one that exists; `commitTouchedChangelog` asks whether a commit wrote any of them.
const CHANGELOG_CANDIDATES = ['CHANGELOG.md', 'changelog.md', 'CHANGELOG.txt', 'CHANGELOG'];

/** The changelog files at the repo root that a release for this project would write. */
function projectChangelogFiles(project) {
	const files = CHANGELOG_CANDIDATES.slice();
	if (project.type === 'wordpress') files.push('readme.txt');
	return new Set(files.map((f) => f.toLowerCase()));
}

/** 'ok' => bump it, 'silent' => skip quietly, 'reported' => skip but mention it. */
function classifyPath(rel) {
	const parts = rel.split('/');
	const dirs = parts.slice(0, -1);
	const file = parts[parts.length - 1];
	if (dirs.some((d) => VENDORED_DIRS.has(d))) return 'silent';
	if (VENDORED_FILES.has(file)) return 'silent';
	if (/\.(min\.js|min\.css|map|mo|po|pot|lock|svg|png|jpe?g|gif)$/i.test(file)) return 'silent';
	if (isChangelogPath(rel)) return 'silent'; // handled by the changelog step instead
	if (dirs.some((d) => NON_RELEASE_DIRS.has(d))) return 'reported';
	return 'ok';
}

/**
 * Patterns that identify a line as *declaring* the version, as opposed to merely
 * mentioning the number. Built per-run with the current version escaped in, so a
 * line only matches when it declares exactly the version we are replacing.
 */
function versionDeclarationPatterns(version) {
	const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return [
		new RegExp(`(Version\\s*:\\s*)(${v})(?![\\w.])`, 'i'), // plugin header
		new RegExp(`(Stable tag\\s*:\\s*)(${v})(?![\\w.])`, 'i'), // readme.txt
		new RegExp(`(const\\s+VERSION\\s*=\\s*['"])(${v})(?=['"])`, 'i'),
		new RegExp(`(define\\s*\\(\\s*['"][A-Za-z0-9_]*VERSION['"]\\s*,\\s*['"])(${v})(?=['"])`, 'i'),
		new RegExp(`(["']version["']\\s*:\\s*["'])(${v})(?=["'])`, 'i'), // json
		new RegExp(`(\\$[A-Za-z_]*version[A-Za-z_]*\\s*=\\s*['"])(${v})(?=['"])`, 'i'), // php var
		new RegExp(`([A-Za-z_]*VERSION[A-Za-z_]*\\s*[:=]\\s*['"])(${v})(?=['"])`, 'i'), // js/ts const
		new RegExp(`(@version\\s+)(${v})(?![\\w.])`, 'i'), // docblock
	];
}

/**
 * Replace the current version with the new one everywhere it is *declared*.
 * Returns { changes: [{file, line, text}], skipped: [{file, line, text}] }.
 */
function applyVersionBump(cwd, project, oldVersion, newVersion) {
	const patterns = versionDeclarationPatterns(oldVersion);
	const changes = [];
	const skipped = [];

	// git grep only searches tracked files, which keeps build output and local
	// scratch files out of the release commit.
	const grep = gitOut(cwd, ['grep', '-n', '-I', '--no-color', '--fixed-strings', '--', oldVersion]);
	const hits = new Map(); // relative path => Set of line numbers
	for (const line of (grep || '').split('\n')) {
		if (!line) continue;
		const m = line.match(/^(.*?):(\d+):/);
		if (!m) continue;
		if (!hits.has(m[1])) hits.set(m[1], new Set());
		hits.get(m[1]).add(+m[2]);
	}
	// The primary version source is always in play, even if the grep missed it.
	if (!hits.has(project.versionFile)) hits.set(project.versionFile, new Set());

	for (const [rel, lineNumbers] of hits) {
		const isPrimary = rel === project.versionFile;
		const abs = path.join(cwd, rel);
		if (!fs.existsSync(abs)) continue;

		if (!isPrimary) {
			const kind = classifyPath(rel);
			if (kind === 'silent') continue;
			if (kind === 'reported') {
				for (const ln of lineNumbers) skipped.push({ file: rel, line: ln, text: '' });
				continue;
			}
		}

		const original = fs.readFileSync(abs, 'utf8');
		const lines = original.split('\n');
		let touched = false;

		const candidates = lineNumbers.size ? [...lineNumbers] : lines.map((_, i) => i + 1);
		for (const ln of candidates) {
			const idx = ln - 1;
			if (idx < 0 || idx >= lines.length) continue;
			const before = lines[idx];
			if (!before.includes(oldVersion)) continue;

			let after = before;
			for (const re of patterns) {
				if (re.test(after)) {
					after = after.replace(re, (...args) => `${args[1]}${newVersion}`);
				}
			}
			if (after !== before) {
				lines[idx] = after;
				touched = true;
				changes.push({ file: rel, line: ln, text: after.trim() });
			} else if (!detectEntryStyle(before)) {
				// An old changelog/upgrade-notice heading (`= 1.2.3 =`) is supposed to
				// keep naming the old version, so it is not worth reporting.
				skipped.push({ file: rel, line: ln, text: before.trim() });
			}
		}

		if (touched) fs.writeFileSync(abs, lines.join('\n'));
	}

	return { changes, skipped };
}

// --- changelog handling ------------------------------------------------------
// Recognised shapes for an existing changelog entry heading. `fmt` reproduces the
// same shape for the new version, so each project keeps its own conventions.
const ENTRY_STYLES = [
	{
		name: 'wp-equals', // = 5.12.0 =
		re: /^=\s*v?\d+\.\d+[^\s=]*\s*(?:-\s*\d{4}-\d{2}-\d{2}\s*)?=\s*$/,
		dated: (line) => /\d{4}-\d{2}-\d{2}/.test(line),
		fmt: (v, date) => (date ? `= ${v} - ${date} =` : `= ${v} =`),
	},
	{
		name: 'md-h3', // ### 5.12.0
		re: /^###\s+v?\d+\.\d+\S*\s*(?:[-–]\s*\d{4}-\d{2}-\d{2})?\s*$/,
		dated: (line) => /\d{4}-\d{2}-\d{2}/.test(line),
		fmt: (v, date) => (date ? `### ${v} - ${date}` : `### ${v}`),
	},
	{
		name: 'md-h2', // ## 5.12.0
		re: /^##\s+v?\d+\.\d+\S*\s*(?:[-–]\s*\d{4}-\d{2}-\d{2})?\s*$/,
		dated: (line) => /\d{4}-\d{2}-\d{2}/.test(line),
		fmt: (v, date) => (date ? `## ${v} - ${date}` : `## ${v}`),
	},
	{
		name: 'plain', // 5.1.1 - 2025-01-28  /  1.2.1
		re: /^v?\d+\.\d+[\w.+-]*\s*(?:[-–]\s*\d{4}-\d{2}-\d{2}\s*)?$/,
		dated: (line) => /\d{4}-\d{2}-\d{2}/.test(line),
		fmt: (v, date) => (date ? `${v} - ${date}` : `${v}`),
	},
];

function detectEntryStyle(line) {
	return ENTRY_STYLES.find((s) => s.re.test(line.trim())) || null;
}

/** The version an entry heading names, e.g. `= 5.3.9 - 2026-07-30 =` => `5.3.9`. */
function entryHeadingVersion(line) {
	const m = line.match(/v?(\d+\.\d+(?:\.\d+)?)/);
	return m ? m[1] : null;
}

/** Index of the `== Changelog ==` / `## Changelog` heading, or -1. */
function findChangelogHeading(lines) {
	return lines.findIndex((l) => /^\s*(=+\s*change\s*log\s*=+|#{1,6}\s*change\s*log\b.*)$/i.test(l.trim()));
}

/**
 * Work out where a new entry goes in a changelog file and what it should look like.
 * Returns null when the file holds no changelog section we can safely write into.
 */
function planChangelogInsert(cwd, rel, opts = {}) {
	const abs = path.join(cwd, rel);
	if (!fs.existsSync(abs)) return null;
	const content = fs.readFileSync(abs, 'utf8');
	const lines = content.split('\n');

	const headingIdx = findChangelogHeading(lines);
	// In readme.txt the changelog is one section among several (Description,
	// Upgrade Notice, …), so scope the search to that section only.
	let start = headingIdx >= 0 ? headingIdx + 1 : 0;
	let end = lines.length;
	if (headingIdx >= 0 && /\.txt$/i.test(rel)) {
		const next = lines.slice(headingIdx + 1).findIndex((l) => /^==[^=]/.test(l.trim()));
		if (next >= 0) end = headingIdx + 1 + next;
	}

	let entryIdx = -1;
	let style = null;
	// `mergeVersion` is set when the version being released already has a heading here,
	// because its bump was merged earlier and never released. Its bullets then belong
	// under that heading rather than under a second one for the same version.
	let mergeIdx = -1;
	for (let i = start; i < end; i++) {
		const found = detectEntryStyle(lines[i]);
		if (!found) continue;
		if (entryIdx < 0) {
			entryIdx = i;
			style = found;
		}
		if (opts.mergeVersion && entryHeadingVersion(lines[i]) === opts.mergeVersion) {
			mergeIdx = i;
			style = found;
			break;
		}
		if (!opts.mergeVersion) break;
	}

	if (!style) {
		// readme.txt often just links to CHANGELOG.md; don't turn that into a log.
		if (opts.requireExistingEntries) return null;
		style = opts.defaultStyle;
	}

	// Mimic the bullet character used by the entry we are writing next to.
	const anchorIdx = mergeIdx >= 0 ? mergeIdx : entryIdx;
	let bullet = opts.defaultBullet || '-';
	if (anchorIdx >= 0) {
		for (let i = anchorIdx + 1; i < Math.min(anchorIdx + 12, end); i++) {
			const m = lines[i].match(/^\s*([*-])\s+\S/);
			if (m) {
				bullet = m[1];
				break;
			}
			if (detectEntryStyle(lines[i])) break;
		}
	}

	const dated = anchorIdx >= 0 ? style.dated(lines[anchorIdx]) : !!opts.defaultDated;

	if (mergeIdx >= 0) {
		// Append to the existing entry, after its last non-empty line.
		let lastContent = mergeIdx;
		for (let i = mergeIdx + 1; i < end; i++) {
			if (detectEntryStyle(lines[i])) break;
			if (lines[i].trim() !== '') lastContent = i;
		}
		return { rel, abs, lines, insertAt: lastContent + 1, style, bullet, dated, merge: true };
	}

	// Insert directly above the newest existing entry, otherwise just below the
	// changelog heading (keeping any blank line that follows it).
	let insertAt = entryIdx;
	if (insertAt < 0) {
		insertAt = headingIdx >= 0 ? headingIdx + 1 : 0;
		while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
	}

	return { rel, abs, lines, insertAt, style, bullet, dated, merge: false };
}

function todayIso() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderChangelogEntry(plan, version, entries) {
	const heading = plan.style.fmt(version, plan.dated ? todayIso() : null);
	return [heading, ...entries.map((e) => `${plan.bullet} ${e}`)];
}

/**
 * Decide which changelog files to write for this project, and write them.
 * Returns the list of relative paths that were modified or created.
 *
 * `opts.merge` asks for the entries to be appended to `version`'s existing heading
 * where there already is one — used when releasing a version that was bumped (and
 * partly documented) in an earlier commit but never released.
 */
function writeChangelogs(cwd, project, version, entries, opts = {}) {
	const written = [];
	const plans = [];
	const mergeVersion = opts.merge ? version : null;

	const mdFile = CHANGELOG_CANDIDATES.find((f) => fs.existsSync(path.join(cwd, f)));

	if (project.type === 'wordpress') {
		// readme.txt is only updated when it already carries real entries — the
		// section frequently holds nothing but a link to CHANGELOG.md.
		const readmePlan = planChangelogInsert(cwd, 'readme.txt', { requireExistingEntries: true, mergeVersion });
		if (readmePlan) plans.push(readmePlan);
		if (mdFile) {
			plans.push(planChangelogInsert(cwd, mdFile, {
				defaultStyle: ENTRY_STYLES.find((s) => s.name === 'wp-equals'),
				defaultBullet: '*',
				mergeVersion,
			}));
		}
	} else {
		if (mdFile) {
			plans.push(planChangelogInsert(cwd, mdFile, {
				defaultStyle: ENTRY_STYLES.find((s) => s.name === 'plain'),
				defaultBullet: '-',
				defaultDated: true,
				mergeVersion,
			}));
		}
	}

	for (const plan of plans.filter(Boolean)) {
		// A merged-in entry needs no heading, and no blank line after it either: it is
		// being slotted into a block that already has one.
		const block = plan.merge
			? entries.map((e) => `${plan.bullet} ${e}`)
			: [...renderChangelogEntry(plan, version, entries), ''];
		const lines = plan.lines.slice();
		lines.splice(plan.insertAt, 0, ...block);
		fs.writeFileSync(plan.abs, lines.join('\n'));
		written.push(plan.rel);
	}

	if (!written.length) {
		// Nothing to update: start a CHANGELOG.md in the project's conventional style.
		const style = project.type === 'wordpress'
			? ENTRY_STYLES.find((s) => s.name === 'wp-equals')
			: ENTRY_STYLES.find((s) => s.name === 'plain');
		const bullet = project.type === 'wordpress' ? '*' : '-';
		const dated = project.type !== 'wordpress';
		const heading = style.fmt(version, dated ? todayIso() : null);
		const body = ['## Changelog', '', heading, ...entries.map((e) => `${bullet} ${e}`), ''].join('\n');
		fs.writeFileSync(path.join(cwd, 'CHANGELOG.md'), body);
		written.push('CHANGELOG.md');
	}

	return written;
}

// --- per-repo processing -----------------------------------------------------
const SKIP = 'skip';
const FAIL = 'fail';
const DONE = 'done';
const DRY = 'dry';
const NEEDED = 'needed'; // check mode: this repo has unreleased pull requests

/**
 * `check` command: report whether the repo needs a release and, if so, which pull
 * requests have been merged since the current version was set.
 *
 * Deliberately read-only. It fetches (so the answer is about what is actually on
 * origin) but does not check out, pull or write anything, and reads the project's
 * files out of `origin/<default branch>` rather than the working tree. That means
 * it is safe to run over repos with uncommitted work or on another branch, and it
 * never asks a question, so it can run unattended.
 */
async function checkRepo(dir) {
	const name = path.basename(path.resolve(dir));
	info(`Repo: ${name}`);
	processed++;

	const cwd = path.resolve(dir);

	if (!gitOk(cwd, ['remote', 'get-url', 'origin'])) {
		warn("no 'origin' remote — skipping");
		return SKIP;
	}
	if (!gitOk(cwd, ['fetch', '--prune', 'origin'])) {
		err('git fetch failed');
		return FAIL;
	}

	const defaultBranch = detectDefaultBranch(cwd);
	if (!defaultBranch) {
		err('could not determine default branch');
		return FAIL;
	}
	const branchRef = `origin/${defaultBranch}`;

	const project = detectProject(refReader(cwd, branchRef));
	if (!project) {
		warn('not a WordPress or Matomo plugin (no plugin header / plugin.json) — skipping');
		return SKIP;
	}
	if (!parseVersion(project.version)) {
		err(`could not parse the current version '${project.version}' from ${project.versionFile} — skipping`);
		return SKIP;
	}
	info(`${project.type} plugin, current version ${project.version} (from ${project.versionFile} on ${branchRef})`);

	const baseline = await resolveBaseline(cwd, project, branchRef, name);
	if (baseline.pending) {
		warn(`version ${project.version} is set in ${project.versionFile} but was never released`);
		note(`last release: ${baseline.released.version} (${baseline.released.label})`);
	} else if (!baseline.released) {
		note('no released version found — measuring from the commit that set the current version');
	} else if (baseline.behind) {
		warn(`version ${project.version} is BEHIND the last release ${baseline.released.version} (${baseline.released.label}) — check where that was released from`);
	}
	if (baseline.unplaced) {
		warn(`wordpress.org serves ${baseline.unplaced.version} of "${baseline.unplaced.slug}", which this branch never declared — going by tags instead`);
	}
	if (!baseline.sinceSha) {
		// The release run offers to fall back to the whole history here, but that is a
		// question, and check mode does not ask any — so report and move on.
		warn(`could not find the commit that set version ${project.version} — cannot tell what is unreleased`);
		return SKIP;
	}
	const since = baseline.pending
		? `the ${baseline.released.version} release`
		: project.version;
	if (!baseline.pending) {
		const when = gitOut(cwd, ['log', '-1', '--format=%h %ad', '--date=short', baseline.sinceSha]);
		info(`version ${project.version} was set in ${when}`);
	}

	const { prs: allPrs, others } = collectPullRequests(cwd, branchRef, baseline.sinceSha);
	// `[no_release]` work — test fixes, screenshot updates — is not a reason to release.
	const chores = allPrs.filter((pr) => pr.noRelease);
	const prs = allPrs.filter((pr) => !pr.noRelease);
	// A pull request that already wrote its own changelog line needs no new one; it is
	// only listed here so the count of unreleased work stays honest.
	const documented = new Set(baseline.pending ? prs.filter((pr) => commitTouchedChangelog(cwd, pr.sha, project)).map((pr) => pr.sha) : []);

	if (!prs.length) {
		if (baseline.pending) {
			// Nothing to write, but the version still has not gone out.
			warn(`${project.version} is unreleased and there is nothing to add to its changelog — it needs tagging/releasing, not a release commit`);
			checkReport.push({ repo: name, dir: cwd, version: project.version, suggested: project.version, pending: true, released: baseline.released, prs, documented, chores, others });
			return NEEDED;
		}
		ok(`no pull requests merged since ${project.version} — no release needed`);
		if (chores.length) {
			note(`(${chores.length} pull request(s) marked [no_release] were ignored)`);
			for (const pr of chores) note(c('0;90', `  #${pr.number}  ${pr.title}`));
		}
		if (others.length) {
			note(`(${others.length} non-PR commit(s) on ${defaultBranch} were ignored)`);
		}
		return SKIP;
	}

	const suggested = baseline.target;
	warn(`release needed: ${prs.length} pull request(s) merged since ${since}`);
	for (const pr of prs) {
		const seen = documented.has(pr.sha) ? c('0;32', ' [changelog done]') : '';
		note(`${c('1;36', `#${pr.number}`)} ${c('0;90', `${pr.sha.slice(0, 8)} ${pr.date}`)}  ${pr.title}${seen}`);
	}
	// Everything in range documented itself: the release commit has nothing left to do,
	// so what is actually missing is the tag and the github release.
	const tagOnly = documented.size === prs.length;
	if (documented.size) {
		note(c('0;90', tagOnly
			? 'all of them already updated the changelog themselves — this needs tagging/releasing, not a release commit'
			: `${documented.size} of them already updated the changelog themselves`));
	}
	if (chores.length) {
		note(`${chores.length} more pull request(s) are marked [no_release] and get no changelog line:`);
		for (const pr of chores) note(c('0;90', `  #${pr.number}  ${pr.title}`));
	}
	if (others.length) {
		warn(`${others.length} commit(s) since then are not associated with a pull request:`);
		for (const o of others.slice(0, 10)) note(c('0;90', `  ${o.sha.slice(0, 8)} ${o.date}  ${o.subject}`));
		if (others.length > 10) note(c('0;90', `  … and ${others.length - 10} more`));
	}

	checkReport.push({ repo: name, dir: cwd, version: project.version, suggested, pending: baseline.pending, released: baseline.released, prs, documented, tagOnly, chores, others });
	return NEEDED;
}

async function processRepo(dir) {
	const name = path.basename(path.resolve(dir));
	info(`Repo: ${name}`);
	processed++;

	const cwd = path.resolve(dir);

	// Only TRACKED modifications count as dirty: stray untracked files never make
	// it into the commit anyway, and a submodule with untracked content inside it
	// is not our problem.
	const dirty = gitOut(cwd, ['status', '--porcelain', '--ignore-submodules=untracked', '--untracked-files=no']);
	if (dirty) {
		const cur = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
		warn(`working tree not clean on branch '${cur}'`);
		if (cur === BRANCH) {
			// Almost certainly leftovers from a previous (dry) run; we rebuild the
			// branch from scratch anyway, so the only question is consent.
			const discard = await askYesNo('    these look like changes from a previous run — discard and redo the release?', true);
			if (!discard) {
				warn('leaving the existing changes alone — skipping');
				return SKIP;
			}
			// `reset --hard` rather than `checkout -- .`: a previous dry run leaves its
			// changes STAGED, and checkout would restore them straight back out of the
			// index, leaving us to cut a release on top of an already-bumped version.
			if (!gitOk(cwd, ['reset', '--hard', 'HEAD'])) {
				err('could not discard the existing changes — skipping');
				return SKIP;
			}
		} else {
			warn('unrelated changes present — commit, stash, or discard them first — skipping');
			return SKIP;
		}
	}

	if (!gitOk(cwd, ['remote', 'get-url', 'origin'])) {
		warn("no 'origin' remote — skipping");
		return SKIP;
	}

	info('fetching origin');
	if (!gitOk(cwd, ['fetch', '--prune', 'origin'])) {
		err('git fetch failed');
		return FAIL;
	}

	const defaultBranch = detectDefaultBranch(cwd);
	if (!defaultBranch) {
		err('could not determine default branch');
		return FAIL;
	}
	info(`default branch: ${defaultBranch}`);

	if (!gitOk(cwd, ['checkout', defaultBranch])) {
		err(`checkout ${defaultBranch} failed`);
		return FAIL;
	}
	info('pulling (fast-forward only)');
	if (!gitOk(cwd, ['pull', '--ff-only', 'origin', defaultBranch])) {
		err('git pull --ff-only failed');
		return FAIL;
	}

	// --- what kind of project is this, and what is its current version? -------
	const project = detectProject(worktreeReader(cwd));
	if (!project) {
		warn('not a WordPress or Matomo plugin (no plugin header / plugin.json) — skipping');
		return SKIP;
	}
	if (!parseVersion(project.version)) {
		err(`could not parse the current version '${project.version}' from ${project.versionFile} — skipping`);
		return SKIP;
	}
	info(`${project.type} plugin, current version ${project.version} (from ${project.versionFile})`);

	// --- what has not been released yet? --------------------------------------
	const baseline = await resolveBaseline(cwd, project, defaultBranch, name);
	if (baseline.pending) {
		warn(`version ${project.version} is set in ${project.versionFile} but was never released`);
		note(`last release: ${baseline.released.version} (${baseline.released.label})`);
		note(`everything merged since then is unreleased, and ${project.version} itself is still to go out`);
	} else if (!baseline.released) {
		note('no released version found — measuring from the commit that set the current version');
	} else if (baseline.behind) {
		warn(`version ${project.version} is BEHIND the last release ${baseline.released.version} (${baseline.released.label}) — check where that was released from`);
		followUps.push({ repo: name, detail: `the declared version ${project.version} is older than the last release ${baseline.released.version}` });
	}
	if (baseline.unplaced) {
		warn(`wordpress.org serves ${baseline.unplaced.version} of "${baseline.unplaced.slug}", which this branch never declared — going by tags instead`);
		followUps.push({ repo: name, detail: `wordpress.org publishes ${baseline.unplaced.version}, which this branch never declared — check which branch releases go out from` });
	}

	if (!baseline.sinceSha) {
		warn(`could not find the commit that set version ${project.version}`);
		const useAll = await askYesNo('    fall back to the full history of the default branch?', false);
		if (!useAll) {
			warn('skipping');
			return SKIP;
		}
	} else if (!baseline.pending) {
		const when = gitOut(cwd, ['log', '-1', '--format=%h %ad', '--date=short', baseline.sinceSha]);
		info(`version ${project.version} was set in ${when}`);
	}

	const since = baseline.pending ? `the ${baseline.released.version} release` : project.version;
	const { prs: allPrs, others } = collectPullRequests(cwd, defaultBranch, baseline.sinceSha);

	// `[no_release]` work — test fixes, screenshot updates — is not a reason to release
	// and gets no changelog line, but it does ship with whatever release follows it, so
	// it is reported rather than hidden.
	let prs = allPrs.filter((pr) => !pr.noRelease);
	const chores = allPrs.filter((pr) => pr.noRelease);
	if (chores.length) {
		info(`${chores.length} pull request(s) are marked [no_release] and will not be asked about:`);
		for (const pr of chores) note(c('0;90', `#${pr.number} ${pr.sha.slice(0, 8)}  ${pr.title}`));
	}

	// When we are catching up on an unreleased version, some of the pull requests in
	// range wrote their changelog line themselves (that is usually how the version got
	// bumped in the first place). Asking about those again would duplicate the entry.
	if (baseline.pending) {
		const documented = prs.filter((pr) => commitTouchedChangelog(cwd, pr.sha, project));
		if (documented.length) {
			info(`${documented.length} pull request(s) already updated the changelog and will not be asked about:`);
			for (const pr of documented) note(c('0;90', `#${pr.number} ${pr.sha.slice(0, 8)}  ${pr.title}`));
			followUps.push({ repo: name, detail: `${documented.length} pull request(s) were assumed to be in the ${project.version} changelog already because they edited it — worth a glance` });
			const skipShas = new Set(documented.map((pr) => pr.sha));
			prs = prs.filter((pr) => !skipShas.has(pr.sha));
		}
	}

	if (!prs.length) {
		if (baseline.pending) {
			ok(`${project.version} is unreleased but its changelog is already complete — nothing to commit`);
			warn(`${project.version} needs tagging/releasing, not a release commit — skipping`);
			followUps.push({ repo: name, detail: `version ${project.version} is ready but unreleased — it needs a tag and a GitHub release` });
			return SKIP;
		}
		ok(`no pull requests merged since ${project.version} — no release needed`);
		if (chores.length) {
			note(`(${chores.length} pull request(s) marked [no_release] were ignored)`);
		}
		if (others.length) {
			note(`(${others.length} non-PR commit(s) on ${defaultBranch} were ignored)`);
		}
		return SKIP;
	}
	info(`${prs.length} pull request(s) to document since ${since}`);
	if (chores.length) {
		followUps.push({ repo: name, detail: `${chores.length} [no_release] pull request(s) ship with this release without a changelog line` });
	}
	if (others.length) {
		warn(`${others.length} commit(s) since then are not associated with a pull request and will not appear in the changelog:`);
		for (const o of others.slice(0, 10)) note(`  ${o.sha.slice(0, 8)} ${o.subject}`);
		if (others.length > 10) note(`  … and ${others.length - 10} more`);
		followUps.push({ repo: name, detail: `${others.length} commit(s) without a pull request were left out of the changelog` });
	}

	// --- create/reset the release branch -------------------------------------
	gitOk(cwd, ['branch', '-D', BRANCH]);
	if (!gitOk(cwd, ['checkout', '-b', BRANCH])) {
		err(`could not create branch ${BRANCH}`);
		return FAIL;
	}
	info(`on branch ${BRANCH}`);

	// --- changelog descriptions, one per PR ----------------------------------
	console.log();
	note(c('1;37', 'Changelog entries — press Enter to accept, edit the text, or clear it to exclude the PR.'));
	const entries = [];
	for (let i = 0; i < prs.length; i++) {
		const pr = prs[i];
		note(c('0;90', `#${pr.number} (${pr.sha.slice(0, 8)})`));
		for (;;) {
			const answer = await ask(`  [${i + 1}/${prs.length}] `, pr.title);
			if (answer) {
				entries.push(answer);
				break;
			}
			const exclude = await askYesNo(`  leave PR #${pr.number} out of the changelog?`, true);
			if (exclude) break;
		}
	}
	console.log();

	if (!entries.length) {
		warn('every pull request was excluded — nothing to release');
		// With an unreleased version already in place there is nothing left to write:
		// no changelog line, and no bump either. Only the tag is missing.
		const proceed = baseline.pending
			? await askYesNo(`    ${project.version} is already set — bump the version anyway?`, false)
			: await askYesNo('    still bump the version?', false);
		if (!proceed) {
			gitOk(cwd, ['checkout', defaultBranch]);
			gitOk(cwd, ['branch', '-D', BRANCH]);
			warn('skipping');
			if (baseline.pending) {
				followUps.push({ repo: name, detail: `version ${project.version} is still unreleased — it needs a tag and a GitHub release` });
			}
			return SKIP;
		}
		if (baseline.pending) {
			// They asked for a bump on top of the unreleased version, so don't offer to
			// "release what is there" a moment later.
			baseline.target = bumpVersion(project.version, 'patch');
		}
	}

	// --- which version are we releasing? -------------------------------------
	// With an unreleased bump already in place, the release to make is that version;
	// bumping again would leave it stranded forever.
	const suggested = baseline.target;
	if (baseline.pending && suggested === project.version) {
		info(`${project.version} is already set and unreleased — accept it to release it as-is, or enter a higher version`);
	}
	let newVersion = null;
	while (!newVersion) {
		const answer = await ask(`  new version (patch|minor|major or an explicit version) [${project.version} -> ] `, suggested);
		const lowered = answer.toLowerCase();
		if (['patch', 'minor', 'major'].includes(lowered)) {
			newVersion = bumpVersion(project.version, lowered);
		} else if (VALID_VERSION_RE.test(answer)) {
			newVersion = answer;
		} else {
			warn('please enter patch, minor, major, or a version like 1.2.3');
		}
	}
	const versionUnchanged = newVersion === project.version;
	info(versionUnchanged ? `releasing ${newVersion} as it stands (no version bump needed)` : `bumping ${project.version} -> ${newVersion}`);

	// --- write the changelog and bump the version ----------------------------
	let changelogFiles = [];
	let bump = { changes: [], skipped: [] };
	try {
		// Releasing the version that is already declared means its changelog entry may
		// exist too, so the new lines join it instead of starting a duplicate heading.
		if (entries.length) changelogFiles = writeChangelogs(cwd, project, newVersion, entries, { merge: versionUnchanged });
		if (!versionUnchanged) bump = applyVersionBump(cwd, project, project.version, newVersion);
	} catch (e) {
		err(`failed to update files: ${e.message}`);
		return FAIL;
	}

	if (!versionUnchanged && !bump.changes.length) {
		err(`could not find anywhere to bump the version — leaving ${BRANCH} for inspection`);
		return FAIL;
	}

	for (const f of changelogFiles) ok(`changelog: ${f} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
	if (versionUnchanged) {
		ok(`version ${newVersion} is already declared everywhere — only the changelog was updated`);
	} else {
		ok(`version bumped in ${bump.changes.length} place(s):`);
	}
	for (const ch of bump.changes) note(c('0;90', `${ch.file}:${ch.line}  ${ch.text}`));
	if (bump.skipped.length) {
		warn(`${bump.skipped.length} other occurrence(s) of ${project.version} were left untouched:`);
		for (const s of bump.skipped.slice(0, 8)) note(c('0;90', `${s.file}:${s.line}${s.text ? `  ${s.text}` : ''}`));
		if (bump.skipped.length > 8) note(c('0;90', `… and ${bump.skipped.length - 8} more`));
		followUps.push({ repo: name, detail: `${bump.skipped.length} occurrence(s) of ${project.version} were not bumped — check whether any of them should have been` });
	}

	// --- commit & push --------------------------------------------------------
	if (!gitOk(cwd, ['add', '-u'])) {
		err('git add failed');
		return FAIL;
	}
	// A changelog we created ourselves is not tracked yet.
	for (const f of changelogFiles) gitOk(cwd, ['add', '--', f]);

	if (gitOk(cwd, ['diff', '--cached', '--quiet'])) {
		warn('no changes were staged — nothing to commit');
		if (versionUnchanged) {
			note(`${newVersion} is already in the source and in the changelog — it only needs tagging/releasing`);
			followUps.push({ repo: name, detail: `version ${newVersion} is ready but unreleased — it needs a tag and a GitHub release` });
		}
		return SKIP;
	}

	// Nothing was bumped when we are releasing the version the source already declares,
	// so a "bumping version" subject would be a lie — and both subjects are recognised
	// as release commits by later runs.
	const commitMessage = versionUnchanged
		? `updating changelog for ${newVersion}`
		: `bumping version to ${newVersion}`;

	if (DRY_RUN) {
		releaseReport.push({ repo: name, version: newVersion, entries: entries.length, pushed: false, versionUnchanged });
		warn(`[dry-run] release for ${newVersion} staged on branch '${BRANCH}' but NOT committed or pushed`);
		note(`[dry-run] would commit as: ${commitMessage}`);
		note(`[dry-run] inspect with: (cd ${dir} && git diff --cached)`);
		return DRY;
	}

	try {
		git(cwd, ['commit', '-m', commitMessage]);
	} catch (e) {
		err(`git commit failed: ${gitError(e)}`);
		warn(`the release changes are still staged on branch '${BRANCH}'`);
		return FAIL;
	}
	info(`pushing ${BRANCH} to origin`);
	try {
		// The branch is rebuilt from the default branch on every run, so an existing
		// remote copy has to be replaced; the lease keeps us honest about what we saw
		// during the fetch above.
		git(cwd, ['push', '--force-with-lease', '--set-upstream', 'origin', BRANCH]);
	} catch (e) {
		err(`git push failed: ${gitError(e)}`);
		warn(`the release is committed on branch '${BRANCH}' — push it yourself once the cause is fixed`);
		return FAIL;
	}
	releaseReport.push({ repo: name, version: newVersion, entries: entries.length, pushed: true, versionUnchanged });
	ok(`pushed ${BRANCH} (${newVersion})`);
	return DONE;
}

// --- main --------------------------------------------------------------------
async function main() {
	// The config commands look at the config file itself and never touch a repo.
	if (COMMAND === 'config' || COMMAND === 'config-edit') {
		if (REPOS.length) {
			console.error(`the config command takes no folders (got: ${REPOS.join(' ')})`);
			exitCode = 64;
			return;
		}
		exitCode = COMMAND === 'config-edit' ? editConfig() : showConfig();
		return;
	}

	// Only the release run is interactive; `check` is fine in a pipe or a cron job.
	if (!CHECK_ONLY && !SCRIPTED_ANSWERS && !process.stdin.isTTY) {
		console.error("the 'release' command needs an interactive terminal (it asks for changelog text and the version to bump to).");
		console.error('drop it to just report which repos need a release; that never prompts.');
		process.exit(1);
	}

	if (CHECK_ONLY) {
		info("CHECK — reporting what needs a release; nothing will be modified. Use the 'release' command to make the commits.");
		if (DRY_RUN) warn('--dry-run has no effect in check mode (nothing is written either way).');
	} else if (DRY_RUN) {
		info('DRY RUN — no commits or pushes will be made.');
	}

	// Build the list of candidate directories: explicit args, the configured default
	// list, or a scan of $PWD.
	let candidates;
	// Whether the list was asked for by name (arguments or config) rather than found
	// by scanning: a folder that was named and turns out not to be a repo is worth
	// complaining about, a folder that merely sits in the current directory is not.
	let named = true;
	if (REPOS.length) {
		info(`Processing ${REPOS.length} folder(s) given on the command line…`);
		candidates = REPOS.map((r) => r.replace(/\/+$/, ''));
	} else {
		const config = loadConfig();
		if (config) {
			info(`Processing ${config.repos.length} folder(s) from ${config.file}…`);
			candidates = config.repos;
		} else {
			info(`Scanning ${process.cwd()} for git repositories…`);
			candidates = fs.readdirSync(process.cwd(), { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort();
			named = false;
		}
	}
	console.log();

	let foundAny = false;
	for (const dir of candidates) {
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
			err(`not a directory: ${dir} — skipping`);
			failed++;
			continue;
		}
		if (!fs.existsSync(path.join(dir, '.git'))) {
			// An explicitly-named non-repo is worth flagging; a scanned one is just noise.
			if (named) {
				warn(`not a git repository: ${dir} — skipping`);
				skipped++;
			}
			continue;
		}
		foundAny = true;

		let result;
		try {
			result = CHECK_ONLY ? await checkRepo(dir) : await processRepo(dir);
		} catch (e) {
			err(`unexpected failure: ${e.message}`);
			result = FAIL;
		}
		if (result === NEEDED) {
			released++; // "needs a release" in check mode
		} else if (result === DONE) {
			released++;
			ok(`${path.basename(path.resolve(dir))}: done`);
		} else if (result === DRY) {
			skipped++;
			ok(`${path.basename(path.resolve(dir))}: dry-run complete (not pushed)`);
		} else if (result === SKIP) {
			skipped++;
		} else {
			failed++;
			err(`${path.basename(path.resolve(dir))}: failed`);
		}
		console.log();
	}

	if (!foundAny) {
		warn(named ? 'None of the supplied folders were git repositories.' : 'No git repositories found in the current directory.');
	}

	if (CHECK_ONLY) {
		info(`Summary: checked=${processed} need-release=${released} up-to-date=${skipped} failed=${failed}`);
		console.log();
		if (checkReport.length) {
			console.log(c('1;37', `${checkReport.length} repo(s) need a release:`));
			for (const r of checkReport) {
				const what = r.pending
					? `${r.version} is bumped but unreleased (last release ${r.released.version})`
					: `${r.version} -> ${r.suggested} (patch)`;
				const count = !r.prs.length || r.tagOnly
					? ' — needs tagging only'
					: `, ${r.prs.length} unreleased pull request(s)`;
				const chores = r.chores && r.chores.length ? ` (+${r.chores.length} [no_release])` : '';
				console.log(`  ${c('1;33', r.repo)}: ${what}${count}${chores}`);
				for (const pr of r.prs) {
					const seen = r.documented && r.documented.has(pr.sha) ? c('0;32', ' [changelog done]') : '';
					note(c('0;90', `  #${pr.number}  ${pr.title}`) + seen);
				}
			}
			console.log();
			// Repos whose changelog is already complete have nothing for this script to
			// commit, so keep them out of the suggested command line.
			const tagOnlyRepos = checkReport.filter((r) => r.tagOnly || !r.prs.length);
			const needCommits = checkReport.filter((r) => !tagOnlyRepos.includes(r));
			if (needCommits.length) {
				note(`run '${path.basename(process.argv[1])} release ${needCommits.map((r) => shortPath(r.dir)).join(' ')}' to make the release commits.`);
			}
			if (tagOnlyRepos.length) {
				note(`${tagOnlyRepos.map((r) => `${r.repo} (${r.version})`).join(', ')} only need a tag and a github release.`);
			}
		} else {
			ok('nothing needs a release.');
		}
		return;
	}

	info(`Summary: processed=${processed} released=${released} skipped=${skipped} failed=${failed}`);

	if (releaseReport.length) {
		console.log();
		for (const r of releaseReport) {
			const how = r.versionUnchanged ? ' — changelog only, version was already set' : '';
			ok(`${r.repo}: ${r.version} (${r.entries} changelog entr${r.entries === 1 ? 'y' : 'ies'})${how}${r.pushed ? ` — ${BRANCH} pushed` : ' — not pushed (dry run)'}`);
		}
	}

	// --- follow-up report (high visibility) ----------------------------------
	if (followUps.length) {
		console.log();
		console.log(c('1;97;41', ' ⚠  WORTH CHECKING BEFORE YOU OPEN THE RELEASE PRs '));
		console.log();
		let current = '';
		for (const f of followUps) {
			if (f.repo !== current) {
				current = f.repo;
				console.log(c('1;91', `▌ ${f.repo}`));
			}
			console.log(c('1;91', `    ${f.detail}`));
		}
	}
}

main()
	.then(() => {
		closeRl();
		process.exit(exitCode !== null ? exitCode : (failed > 0 ? 1 : 0));
	})
	.catch((e) => {
		closeRl();
		console.error(e);
		process.exit(1);
	});
