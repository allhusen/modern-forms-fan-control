import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(root, '.runtime');
const release = 'node-v24.22.2-darwin-arm64';
const archive = resolve(runtime, `${release}.tar.gz`);
const expected = 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a';
const buildDirectory = await mkdtemp(resolve(tmpdir(), 'fan-control-build-'));
const appPath = resolve(buildDirectory, 'Fan Control.app');
const contents = resolve(appPath, 'Contents');
const resources = resolve(contents, 'Resources');
await mkdir(runtime, { recursive: true });
try { await readFile(archive); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(`https://nodejs.org/dist/v24.22.2/${release}.tar.gz`);
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
}
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== expected) throw new Error('Node.js runtime checksum mismatch.');
execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', runtime, `${release}/bin/node`, `${release}/LICENSE`]);
await mkdir(resolve(contents, 'MacOS'), { recursive: true });
await mkdir(resources, { recursive: true });
await cp(resolve(root, 'macos/FanControl.icns'), resolve(resources, 'FanControl.icns'));
// Only this generated resource directory is replaced; user data is outside the bundle.
await rm(resolve(resources, 'controller'), { recursive: true, force: true });
await mkdir(resolve(resources, 'controller'), { recursive: true });
for (const file of ['app-server.mjs', 'server.mjs', 'lib', 'public', 'package.json', 'package-lock.json', 'node_modules', 'config.json']) {
  await cp(resolve(root, file), resolve(resources, 'controller', file), { recursive: true, dereference: true });
}
await cp(resolve(runtime, release, 'bin/node'), resolve(resources, 'node'));
await chmod(resolve(resources, 'node'), 0o755);
await cp(resolve(runtime, release, 'LICENSE'), resolve(resources, 'Node-LICENSE'));
await cp(resolve(root, 'macos/Info.plist'), resolve(contents, 'Info.plist'));
execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macosx14.0', '-module-cache-path', resolve(runtime, 'swift-cache'), '-framework', 'Cocoa', '-framework', 'WebKit', resolve(root, 'macos/FanControl.swift'), '-o', resolve(contents, 'MacOS/FanControl')], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', resolve(resources, 'node')], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', appPath], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
// Deliver an archive from the signed temporary bundle. iCloud adds Finder
// metadata to .app directories in Documents, which breaks strict verification.
await mkdir(resolve(root, 'dist'), { recursive: true });
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, resolve(root, 'dist/Fan Control.zip')]);
await rm(buildDirectory, { recursive: true, force: true });
console.log('Built dist/Fan Control.zip with its own window, server, HomeKit bridge, and Node.js runtime.');
