import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { root, run } from './common.js';

const dist = join(root, 'dist');
async function hash(path: string) {
  const value = createHash('sha256'); for await (const chunk of createReadStream(path)) value.update(chunk); return value.digest('hex');
}
async function manifest(directory: string) {
  const canonical = await realpath(directory), entries: Record<string, { sha256?: string; symlink?: string }> = {};
  const visit = async (path: string) => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), rel = relative(directory, child).split(sep).join('/'), stat = await lstat(child);
      if (['.git', '.env', '.kivro', '.local'].includes(name) || name.startsWith('.env.')) throw new Error(`Private path rejected: ${rel}`);
      if (stat.isSymbolicLink()) {
        const target = await realpath(child);
        if (target !== canonical && !target.startsWith(canonical + sep)) throw new Error(`External artifact link: ${rel}`);
        entries[rel] = { symlink: await readlink(child) };
      } else if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) entries[rel] = { sha256: await hash(child) };
      else throw new Error(`Special artifact entry: ${rel}`);
    }
  };
  await visit(directory); return entries;
}

async function main() {
  await mkdir(dist, { recursive: true });
  const stage = await mkdtemp(join(dist, 'cloud-stage-'));
  try {
    const api = join(stage, 'api');
    await run('pnpm', ['--filter', '@kivro/api', 'deploy', '--prod', '--legacy', '--frozen-lockfile', api]);
    const self = join(api, 'node_modules/.pnpm/node_modules/@kivro/api');
    if ((await lstat(self).catch(() => null))?.isSymbolicLink() && await realpath(self) === await realpath(join(root, 'apps/api'))) {
      await unlink(self); await symlink(relative(dirname(self), api), self, 'dir');
    }
    // Generated Prisma engines are outside the @prisma/client package itself.
    const sourceClient = dirname(createRequire(join(root, 'packages/database/package.json')).resolve('@prisma/client'));
    const database = createRequire(join(api, 'package.json')).resolve('@kivro/database');
    const deployedClient = dirname(createRequire(database).resolve('@prisma/client'));
    await cp(join(sourceClient, '../../.prisma/client'), join(deployedClient, '../../.prisma/client'), { recursive: true });
    await cp(join(root, 'packages/database/prisma'), join(api, 'prisma'), { recursive: true });
    await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "const {createApp}=await import('./src/app.ts');const app=await createApp({logger:false,env:{NODE_ENV:'test',PAYMENT_MODE:'fake',DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',S3_BUCKET:'test',S3_ACCESS_KEY:'test',S3_SECRET_KEY:'test'}});await app.close();console.log('API_ARTIFACT_IMPORT_OK');"],
    { cwd: api, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: '' } });
    const web = join(stage, 'web');
    await cp(join(root, 'apps/web/.next/standalone'), web, { recursive: true, verbatimSymlinks: true });
    await cp(join(root, 'apps/web/.next/static'), join(web, 'apps/web/.next/static'), { recursive: true });
    const publicDirectory = join(root, 'apps/web/public');
    if (await lstat(publicDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
      await cp(publicDirectory, join(web, 'apps/web/public'), { recursive: true });
    }
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
    for (const [name, path] of [['api', api], ['web', web]] as const) {
      const files = await manifest(path);
      await writeFile(join(path, 'RELEASE-MANIFEST.json'), JSON.stringify({ version, platform: process.platform, architecture: process.arch, releaseStage: 'private-beta', files }, null, 2));
      const archive = join(dist, `kivro-${name}-${version}-${process.platform}-${process.arch}.tar.gz`);
      await run('tar', ['-czf', archive, '-C', stage, name]);
      await writeFile(`${archive}.sha256`, `${await hash(archive)}  ${basename(archive)}\n`);
      console.log(`Verified ${name} deployment artifact: ${archive}`);
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Cloud packaging failed'); process.exitCode = 1; });
