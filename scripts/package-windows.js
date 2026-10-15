/**
 * Builds release/ap-automation-agent-win-x64.zip:
 *   ap-automation-agent.exe  the agent as one Node single-executable app (no Node install needed)
 *   install.cmd / install.ps1, uninstall.cmd / uninstall.ps1, agent.env.example, README.txt
 *
 * Run on Windows with Node 22: the .exe is this machine's node.exe with the
 * bundled agent injected into it.   npm run package:win
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const build = path.join(root, 'build');
const stage = path.join(build, 'package');
const release = path.join(root, 'release');
const { version } = require('../package.json');
const EXE = 'ap-automation-agent.exe';
const ZIP = 'ap-automation-agent-win-x64.zip';
// The marker postject looks for in node.exe (fixed by Node for single-executable apps)
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(file, args) {
  execFileSync(file, args, { stdio: 'inherit' });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Build the Windows package on Windows: the .exe is made from node.exe.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Node 22 or later is needed (this is ${process.version}).`);
  const declared = fs.readFileSync(path.join(root, 'src', 'paths.ts'), 'utf8').match(/AGENT_VERSION = '([^']+)'/)?.[1];
  if (declared !== version) throw new Error(`src/paths.ts says ${declared} but package.json says ${version}.`);

  fs.rmSync(build, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(release, { recursive: true });

  // 1. The agent and its dependencies as one CommonJS file
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(build, 'agent.cjs'),
    // Optional speed-ups ws looks for and does without
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning',
  });

  // 2. The single-executable blob
  const seaConfig = path.join(build, 'sea-config.json');
  fs.writeFileSync(
    seaConfig,
    JSON.stringify({
      main: path.join(build, 'agent.cjs'),
      output: path.join(build, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  run(process.execPath, ['--experimental-sea-config', seaConfig]);

  // 3. node.exe with the blob injected
  const exe = path.join(stage, EXE);
  fs.copyFileSync(process.execPath, exe);
  run(process.execPath, [
    require.resolve('postject/dist/cli.js'),
    exe,
    'NODE_SEA_BLOB',
    path.join(build, 'sea-prep.blob'),
    '--sentinel-fuse',
    SEA_FUSE,
  ]);
  const reported = execFileSync(exe, ['--version']).toString().trim();
  if (!reported.endsWith(version)) throw new Error(`The .exe says "${reported}", expected ${version}.`);

  // 4. Installer and notes
  for (const file of fs.readdirSync(path.join(root, 'windows'))) {
    fs.copyFileSync(path.join(root, 'windows', file), path.join(stage, file));
  }

  // 5. The zip
  const zip = path.join(release, ZIP);
  fs.rmSync(zip, { force: true });
  run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`,
  ]);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`\n${reported} (Node ${process.version}) -> ${path.relative(root, zip)} (${mb} MB)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
