import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
async function run(command: string, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_PATH: '' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(join(dist, 'worker-stage-'));
  try {
    const bundle = join(staging, 'worker');
    await run('pnpm', ['--filter', '@kivro/worker', 'deploy', '--prod', '--legacy', '--frozen-lockfile', bundle], root);
    // pnpm's legacy self-reference can point back to the source checkout.
    const self = join(bundle, 'node_modules/.pnpm/node_modules/@kivro/worker');
    if ((await lstat(self).catch(() => null))?.isSymbolicLink() && await realpath(self) === await realpath(join(root, 'apps/worker'))) {
      await unlink(self); await symlink(relative(dirname(self), bundle), self, 'dir');
    }
    await cp(join(root, 'security/sandbox'), join(bundle, 'security/sandbox'), { recursive: true });
    await mkdir(join(bundle, 'docs'), { recursive: true });
    for (const name of ['OPENCLAW_COMPATIBILITY.md', 'WORKER-RELEASE.md']) await cp(join(root, 'docs', name), join(bundle, 'docs', name));
    const files: Record<string, { sha256?: string; symlink?: string }> = {};
    const actualRoot = await realpath(bundle);
    const visit = async (directory: string) => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), rel = relative(bundle, path).split(sep).join('/');
        if (['.env', '.git', '.kivro', '.local'].includes(name) || name.startsWith('.env.')) throw new Error(`Private path in Worker artifact: ${rel}`);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
          const target = await realpath(path);
          if (target !== actualRoot && !target.startsWith(`${actualRoot}${sep}`)) throw new Error(`External symlink in Worker artifact: ${rel}`);
          files[rel] = { symlink: await readlink(path) };
        } else if (stat.isDirectory()) await visit(path);
        else if (stat.isFile()) files[rel] = { sha256: await fileHash(path) };
        else throw new Error(`Unsupported artifact entry: ${rel}`);
      }
    };
    await visit(bundle);
    const manifest = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8')) as { version: string };
    if (!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(manifest.version)) throw new Error('Invalid Worker package version');
    await writeFile(join(bundle, 'RELEASE-MANIFEST.json'), JSON.stringify({ version: manifest.version, platform: process.platform, architecture: process.arch,
      nodeMinimum: '22.13.0', openclaw: '2026.8.2 (0965053)', protocol: 1, sandboxImage: 'kivro-sandbox:2026.8.2',
      signed: false, releaseStage: 'private-beta', files }, null, 2));
    // Run from the deployed directory: no workspace node_modules may rescue it.
    await run(process.execPath, ['--import', 'tsx', 'src/index.ts', 'version'], bundle);
    await run(process.execPath, ['--import', 'tsx', 'src/index.ts', 'help'], bundle);
    const archive = resolve(dist, `kivro-worker-${manifest.version}-${process.platform}-${process.arch}.tar.gz`);
    await run('tar', ['-czf', archive, '-C', staging, 'worker'], root);
    await writeFile(`${archive}.sha256`, `${await fileHash(archive)}  ${basename(archive)}\n`);
    console.log(`Verified private-beta Worker artifact: ${archive}`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Worker packaging failed'); process.exitCode = 1; });
