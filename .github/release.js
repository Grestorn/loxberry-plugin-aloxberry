/**
 * Release Script — monorepo, per-component, change-aware.
 *
 * Purpose: automate releases so you can't forget to bump a file, AND so that
 * only the components that actually changed since the last release get a new
 * version. Run one of the npm scripts:
 *
 *    npm run release:patch | release:minor | release:major     (final)
 *    npm run pre:patch     | pre:minor     | pre:major          (prerelease)
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

const isGitClean = () => gitOut('status', '--porcelain') === '';
const gitStatus = () => git('status');
const getLastTag = () => gitOut('describe', '--tags', '--abbrev=0');

// Did any watched path change between <lastTag> and HEAD? With no lastTag
// (first release) everything counts as changed.
const componentChanged = (lastTag, watch) => {
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

const LEVEL = process.argv[2]; // major | minor | patch
const IS_PRERELEASE = process.argv[3] === 'true';

const main = async () => {
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
