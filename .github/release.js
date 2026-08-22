/**
 * Release Script — monorepo, per-component, change-aware.
 *
 * Purpose: automate releases so you can't forget to bump a file, AND so that
 * only the components that actually changed since the last release get a new
 * version. Run one of the npm scripts:
 *
 *    npm run release:patch | release:minor | release:major     (final)
 *    npm run pre:patch     | pre:minor     | pre:major          (prerelease)
 *    npm run release:promote                                    (rc -> final)
 *
 * Pass `-- --force` (e.g. `npm run release:major -- --force`) to release every
 * component even when nothing changed since the last tag. Use this to cut a
 * milestone (e.g. the first official 1.0.0) off a changelog-only commit, where
 * the normal change-detection would otherwise report "nothing to do".
 *
 * Promoting a prerelease (`--promote`)
 * -----------------------------------
 * `npm run release:promote` publishes an existing prerelease as the final
 * release AT THE SAME VERSION -- no bump, no changelog regeneration. It exists
 * because the normal path cannot do this: a prerelease already wrote the plain
 * version (e.g. 1.4.0) into package.json/plugin.cfg and tagged `1.4.0-rc`, so
 * a follow-up `release:patch` finds nothing changed since that tag, and with
 * `--force` would bump to 1.4.1 rather than publishing 1.4.0.
 *
 * What it does: tags the COMMIT THE RC POINTS AT as `X.Y.Z` (that is the code
 * that was actually tested -- if HEAD has moved on you are told exactly which
 * commits are being left out, and must confirm), points release.cfg at
 * `archive/X.Y.Z.zip`, commits and pushes.
 *
 * prerelease.cfg is deliberately left alone: LoxBerry compares both channels
 * and offers whichever version is higher, so a prerelease.cfg left behind the
 * release is harmless and prerelease testers simply follow the final build.
 *
 * What it does
 * ------------
 * 1. Refuses to run on a dirty git tree.
 * 2. Finds the last release tag (git describe --tags). Everything committed
 *    since that tag is "this release's changes". No tag yet → first release,
 *    every component counts as changed.
 * 3. For each component declared in package.json `config.release.components`,
 *    asks git whether any of its watched paths changed since the last tag.
 * 4. Bumps the version of ONLY the changed components, each by the requested
 *    level (major/minor/patch), from that component's own current version —
 *    so component versions may legitimately diverge.
 *      - `kind:"npm"`    → bumps <path>/package.json (npm --no-git-tag-version)
 *      - `kind:"plugin"` → bumps the root package.json AND mirrors that version
 *                          into plugin.cfg + release.cfg|prerelease.cfg.
 * 5. Regenerates CHANGELOG.md from the last tag to HEAD.
 * 6. Shows a summary + `git status`, asks for confirmation (resets on "no").
 * 7. Commits only the files it touched, tags, and pushes.
 *
 * Tagging / baseline
 * ------------------
 * LoxBerry auto-update downloads `archive/<version>.zip`, so the *plugin*
 * component must carry a git tag equal to its version. Therefore:
 *   - plugin changed     → tag `X.Y.Z` (or `X.Y.Z-rc` for a prerelease).
 *                          This also advances the change-detection baseline.
 *   - plugin NOT changed → only sub-components moved; we still create a
 *     (sub-comp only)      lightweight baseline tag `rel-<timestamp>` so the
 *                          next run diffs from here and a component isn't
 *                          bumped twice for one change. (`rel-*` does NOT
 *                          match the GitHub release workflow's tag filter,
 *                          so no GitHub release is cut for it.)
 *
 * Config (package.json)
 * ---------------------
 *   "config": { "release": {
 *     "components": [
 *       { "name":"plugin", "kind":"plugin", "watch":["bin","templates",...] },
 *       { "name":"bridge", "kind":"npm", "path":"bridge", "watch":["bridge"] },
 *       ...
 *     ],
 *     "additionalCommands": [ { "command":"npm run build",
 *                               "gitFiles":["webfrontend","templates"] } ]
 *   } }
 *
 * `watch` entries are git pathspecs (files or directories). A component is
 * "changed" if `git diff --name-only <lastTag>..HEAD -- <watch...>` is
 * non-empty. Overlapping watch lists are intentional: a change in `bin/`
 * bumps both the `daemon` package and the `plugin` (the daemon ships inside
 * the plugin).
 *
 * Implementation note: every external process is run via execFileSync with an
 * argument array (no shell), so paths with spaces and arbitrary branch names
 * can't break or inject into a command line.
 *
 * Required devDependencies: prompts, read-ini-file, write-ini-file,
 * generate-changelog.
 */

const prompts = require('prompts');

const readIniFile = require('read-ini-file');
const writeIniFile = require('write-ini-file');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

// Resolve how to invoke npm without going through a shell.
//
// On Windows `npm` is the batch shim `npm.cmd`. Since the CVE-2024-27980
// hardening (Node >=18.20.2/20.12.2/21.7.3), execFileSync refuses to spawn a
// .cmd/.bat file unless shell:true is set, and we deliberately never use a
// shell here (see the implementation note above). So instead of the shim we
// run npm's own CLI script with the current node binary -- node.exe is a real
// executable, no shell required, and the no-injection guarantee is preserved.
// If npm-cli.js isn't where we expect (unusual installs: Volta, scoop, etc.)
// we fall back to npm.cmd via a shell as a last resort.
const npmInvocation = () => {
  if (!IS_WIN) return { file: 'npm', prefixArgs: [], shell: false };
  const cli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js'
  );
  if (fs.existsSync(cli)) {
    return { file: process.execPath, prefixArgs: [cli], shell: false };
  }
  return { file: 'npm.cmd', prefixArgs: [], shell: true };
};

const question = async (message) => {
  const answer = await prompts({ type: 'confirm', name: 'answer', message });
  return answer.answer;
};

// ----- process helpers (no shell) -------------------------------------------

// Run a program with an explicit argv. Inherits stdio by default so prompts
// and git output stay visible; pass capture:true to get trimmed stdout.
const run = (file, args, { capture = false, shell = false } = {}) =>
  execFileSync(file, args, {
    cwd: ROOT,
    shell,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...(capture ? { encoding: 'utf8' } : {}),
  });

const git = (...args) => run('git', args);
const gitOut = (...args) => {
  try {
    return run('git', args, { capture: true }).trim();
  } catch (e) {
    return '';
  }
};

// Does this exact tag exist locally? `git tag --list <name>` echoes the name
// back when it does and prints nothing when it does not (unlike rev-parse,
// which would also resolve branches and abbreviated hashes).
const tagExists = (name) => gitOut('tag', '--list', name) === name;

const isGitClean = () => gitOut('status', '--porcelain') === '';
const gitStatus = () => git('status');
const getLastTag = () => gitOut('describe', '--tags', '--abbrev=0');

// Did any watched path change between <lastTag> and HEAD? With no lastTag
// (first release) everything counts as changed. With --force every component
// counts as changed regardless of the diff (forced milestone release).
const componentChanged = (lastTag, watch) => {
  if (FORCE) return true;
  if (!lastTag) return true;
  const out = gitOut('diff', '--name-only', `${lastTag}..HEAD`, '--', ...watch);
  return out !== '';
};

// ----- version helpers ------------------------------------------------------

const readPkgVersion = (dir) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, dir || '.', 'package.json'), 'utf8')).version;

// Bump a package.json in place (no git tag/commit). Returns the new version.
const bumpNpm = (dir) => {
  const args = [];
  if (dir && dir !== '.') args.push('--prefix', dir);
  args.push('--no-git-tag-version', 'version', LEVEL);
  const npm = npmInvocation();
  run(npm.file, [...npm.prefixArgs, ...args], { shell: npm.shell });
  return readPkgVersion(dir || '.');
};

const updatePluginConfig = async (version) => {
  const pluginCfg = path.join(ROOT, 'plugin.cfg');
  const plugin = await readIniFile(pluginCfg);
  plugin.PLUGIN.VERSION = version;
  await writeIniFile(pluginCfg, plugin);
};

const readCfgVersion = async (file) => {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return null;
  const cfg = await readIniFile(full);
  return (cfg.AUTOUPDATE && cfg.AUTOUPDATE.VERSION) || null;
};

const updateReleaseCfg = async (version, url, isPrerelease) => {
  const file = path.join(ROOT, isPrerelease ? 'prerelease.cfg' : 'release.cfg');
  const cfg = await readIniFile(file);
  cfg.AUTOUPDATE.VERSION = version;
  cfg.AUTOUPDATE.ARCHIVEURL = `${url}/archive/${version}${isPrerelease ? '-rc' : ''}.zip`;
  await writeIniFile(file, cfg);
};

const getGithubUrl = () => {
  const response = gitOut('remote', 'get-url', 'origin');
  if (response.startsWith('git@')) {
    return response.replace(/^[a-z]+@([^:]+):([^/]+)\/(.*).git/, 'https://$1/$2/$3');
  }
  if (response.startsWith('http')) {
    return response.endsWith('.git') ? response.slice(0, -4) : response;
  }
  console.error('Cannot determine GitHub URL — set up an https or ssh git remote.');
  process.exit(1);
};

// ----- changelog ------------------------------------------------------------

const generateChangelog = (lastTag) => {
  const bin = path.join(ROOT, 'node_modules', '.bin', IS_WIN ? 'changelog.cmd' : 'changelog');
  try {
    if (lastTag) {
      console.log(`Generating changelog from ${lastTag}..HEAD`);
      run(bin, ['-t', `${lastTag}..HEAD`, '-a']);
    } else {
      console.log('No previous tag — generating full changelog');
      const flag = { major: '-M', minor: '-m', patch: '-p' }[LEVEL] || '-p';
      run(bin, [flag, '-a']);
    }
  } catch (e) {
    console.warn('Changelog generation failed (continuing):', e.message);
  }
};

// ----- config ---------------------------------------------------------------

const getConfig = () => {
  delete require.cache[require.resolve('../package.json')];
  const pkg = require('../package.json');
  const rel = (pkg.config && pkg.config.release) || {};
  const components = Array.isArray(rel.components) ? rel.components : [];
  if (components.length === 0) {
    console.error('Configuration issue: package.json config.release.components is missing or empty.');
    process.exit(1);
  }
  for (const c of components) {
    if (!c.name || !c.kind || !Array.isArray(c.watch)) {
      console.error(`Configuration issue: component ${JSON.stringify(c)} needs name, kind, watch[].`);
      process.exit(1);
    }
    if (c.kind === 'npm' && !c.path) {
      console.error(`Configuration issue: npm component "${c.name}" needs a path.`);
      process.exit(1);
    }
  }
  const additionalCommands = Array.isArray(rel.additionalCommands) ? rel.additionalCommands : [];
  return { components, additionalCommands };
};

// Stage a file only if it exists (npm may or may not have written a lockfile).
const addIfExists = (rel) => {
  if (fs.existsSync(path.join(ROOT, rel))) git('add', rel);
};

// ----- main -----------------------------------------------------------------

// argv: [level, isPrerelease, ...flags]. LEVEL and IS_PRERELEASE stay
// positional (set by the npm scripts); flags are matched anywhere so the
// `npm run <script> -- --force` passthrough works regardless of order.
const ARGS = process.argv.slice(2);
const LEVEL = ARGS[0]; // major | minor | patch
const IS_PRERELEASE = ARGS[1] === 'true';
const FORCE = ARGS.includes('--force') || ARGS.includes('-f');
const PROMOTE = ARGS.includes('--promote');

// Publish the existing prerelease as the final release, at the same version.
// Bumps nothing and regenerates nothing -- the version, plugin.cfg and the
// CHANGELOG were all written when the prerelease was cut; the only thing that
// was withheld is release.cfg, which is what stable clients read.
const promote = async () => {
  if (!isGitClean()) {
    gitStatus();
    console.log('\nWorking tree is not clean -- commit or stash your changes first.\n');
    return;
  }

  // The prerelease wrote the plain version here (npm version major|minor|patch
  // is used for prereleases too -- the -rc suffix only ever lives in the tag
  // and the archive URL), so package.json already holds the version we are
  // about to make final.
  const version = readPkgVersion('.');
  const rcTag = `${version}-rc`;

  if (!tagExists(rcTag)) {
    console.log(`\nNo prerelease to promote: tag ${rcTag} does not exist.`);
    console.log('Cut one first with `npm run pre:patch|pre:minor|pre:major`.\n');
    return;
  }
  if (tagExists(version)) {
    console.log(`\nTag ${version} already exists -- ${version} has been released already.\n`);
    return;
  }
  const releasedVersion = await readCfgVersion('release.cfg');
  if (releasedVersion === version) {
    console.log(`\nrelease.cfg is already at ${version}. Nothing to do.\n`);
    return;
  }

  // Tag the commit the RC points at, not HEAD: that is the code people
  // actually tested. Anything committed since is NOT part of this release,
  // which is worth saying out loud rather than quietly shipping it.
  const rcCommit = gitOut('rev-list', '-n', '1', rcTag);
  const head = gitOut('rev-parse', 'HEAD');

  console.log(`\nPromoting ${rcTag} -> ${version}`);
  console.log(`  release.cfg: ${releasedVersion || '(unset)'} -> ${version}`);
  console.log(`  tag ${version} -> ${rcCommit.slice(0, 9)} (the commit ${rcTag} points at)`);

  if (rcCommit !== head) {
    const extra = gitOut('log', '--oneline', `${rcTag}..HEAD`);
    const count = extra ? extra.split('\n').length : 0;
    console.log(`\n  WARNING: HEAD is ${count} commit(s) ahead of ${rcTag}.`);
    console.log('  These will NOT be in the released archive:');
    extra.split('\n').forEach((l) => console.log(`    ${l}`));
    console.log('\n  To ship them instead, cut a new prerelease and promote that.');
    if (!(await question('Release the older RC commit anyway?'))) {
      console.log('Ok, stopping.');
      return;
    }
  }

  // prerelease.cfg is intentionally untouched -- see the header note.
  await updateReleaseCfg(version, getGithubUrl(), false);
  addIfExists('release.cfg');

  gitStatus();
  if (!(await question(`Commit, tag ${version} and push?`))) {
    console.log('Resetting all changes from this run ...');
    try { git('restore', '--staged', 'release.cfg'); } catch (e) {}
    try { git('restore', 'release.cfg'); } catch (e) {}
    process.exit(1);
  }

  const headline = `chore(release): promote v${version} to final`;
  console.log(`Commit: ${headline}`);
  git('commit', '-m', headline);
  console.log(`Tag: ${version} (at ${rcCommit.slice(0, 9)})`);
  git('tag', version, rcCommit);
  git('push', '--set-upstream', 'origin', 'main');
  git('push', 'origin', '--tags');

  console.log(`\nPromoted: ${version} is now the current release.`);
};

const main = async () => {
  if (PROMOTE) return promote();
  if (!['major', 'minor', 'patch'].includes(LEVEL)) {
    console.error(`Unknown bump level "${LEVEL}". Use major | minor | patch.`);
    process.exit(1);
  }

  const { components, additionalCommands } = getConfig();

  if (!isGitClean()) {
    gitStatus();
    console.log('\nWorking tree is not clean — commit or stash your changes first.\n');
    return;
  }

  const lastTag = getLastTag();
  console.log(lastTag
    ? `Last release tag: ${lastTag}`
    : 'No previous release tag — treating this as the first release.');
  if (FORCE) {
    console.log('--force: releasing every component regardless of changes.');
  }

  const changed = components.filter((c) => componentChanged(lastTag, c.watch));
  if (changed.length === 0) {
    console.log('\nNothing changed since the last release. Nothing to do.\n');
    return;
  }

  console.log('\nComponent status since last release:');
  for (const c of components) {
    const cur = readPkgVersion(c.kind === 'plugin' ? '.' : c.path);
    const mark = changed.includes(c) ? `→ will bump (${LEVEL})` : 'unchanged — leave as-is';
    console.log(`  ${c.name.padEnd(16)} ${('v' + cur).padEnd(10)} ${mark}`);
  }

  if (!(await question(`Generate a${IS_PRERELEASE ? ' PRE' : ''} ${LEVEL} release for the ${changed.length} changed component(s)?`))) {
    console.log('Ok, stopping.');
    return;
  }

  const githubUrl = getGithubUrl();
  const pluginComp = components.find((c) => c.kind === 'plugin');
  const pluginChanged = !!pluginComp && changed.includes(pluginComp);

  // Bump each changed component from its own current version.
  const bumps = [];
  for (const c of changed) {
    const dir = c.kind === 'plugin' ? '.' : c.path;
    const from = readPkgVersion(dir);
    const to = bumpNpm(dir);
    bumps.push({ ...c, dir, from, to });
    console.log(`  ${c.name}: ${from} → ${to}`);
  }

  // Mirror the plugin version into the LoxBerry config files.
  let pluginVersion = null;
  if (pluginChanged) {
    pluginVersion = readPkgVersion('.');
    console.log(`Updating plugin.cfg + ${IS_PRERELEASE ? 'prerelease.cfg' : 'release.cfg'} ...`);
    await updatePluginConfig(pluginVersion);
    await updateReleaseCfg(pluginVersion, githubUrl, IS_PRERELEASE);
  }

  // Optional build hooks.
  additionalCommands.forEach((cmd) => {
    console.log(`Running: ${cmd.command}`);
    const parts = cmd.command.split(' ');
    run(parts[0], parts.slice(1));
  });

  generateChangelog(lastTag);

  // Stage exactly what we changed.
  addIfExists('CHANGELOG.md');
  for (const b of bumps) {
    if (b.kind === 'plugin') {
      addIfExists('package.json');
      addIfExists('package-lock.json');
      addIfExists('plugin.cfg');
      addIfExists(IS_PRERELEASE ? 'prerelease.cfg' : 'release.cfg');
    } else {
      addIfExists(path.posix.join(b.path, 'package.json'));
      addIfExists(path.posix.join(b.path, 'package-lock.json'));
    }
  }
  additionalCommands.forEach((cmd) => {
    (cmd.gitFiles || []).forEach((f) => addIfExists(f));
  });

  gitStatus();
  if (!(await question('Does this look right? Commit, tag and push?'))) {
    console.log('Resetting all changes from this run ...');
    const files = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'plugin.cfg', 'release.cfg', 'prerelease.cfg'];
    for (const b of bumps) {
      if (b.kind !== 'plugin') {
        files.push(path.posix.join(b.path, 'package.json'), path.posix.join(b.path, 'package-lock.json'));
      }
    }
    additionalCommands.forEach((cmd) => (cmd.gitFiles || []).forEach((f) => files.push(f)));
    const present = files.filter((f) => fs.existsSync(path.join(ROOT, f)));
    if (present.length) {
      try { git('restore', '--staged', ...present); } catch (e) {}
      try { git('restore', ...present); } catch (e) {}
    }
    process.exit(1);
  }

  const summary = bumps.map((b) => `${b.name}@${b.to}`).join(', ');
  const headline = pluginChanged
    ? `chore(release): v${pluginVersion}${IS_PRERELEASE ? '-rc' : ''} (${summary})`
    : `chore(release): ${summary}`;
  console.log(`Commit: ${headline}`);
  git('commit', '-m', headline);

  // Version tag when the plugin moved (LoxBerry auto-update needs it, and it
  // doubles as the next baseline); otherwise a lightweight baseline tag.
  let tagName;
  if (pluginChanged) {
    tagName = IS_PRERELEASE ? `${pluginVersion}-rc` : pluginVersion;
  } else {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    tagName = `rel-${stamp}`;
    console.log(`Plugin unchanged — baseline tag ${tagName} (no GitHub release is cut for it).`);
  }
  console.log(`Tag: ${tagName}`);
  git('tag', tagName);
  git('push', '--set-upstream', 'origin', 'main');
  git('push', 'origin', '--tags');

  console.log(`\nReleased: ${summary}`);
};

main();
