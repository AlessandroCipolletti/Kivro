import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
// Test-only direct import: production storage/media has no adapter dependency.
import { DockerSandbox, IMAGE_ID, SELF_TEST_LIMITS } from '../../openclaw-adapter/src/docker.js';

export async function resolveMediaFixtureImage(image = process.env.KIVRO_SANDBOX_IMAGE ?? 'kivro-sandbox:2026.8.2'): Promise<string> {
  const docker = new DockerSandbox(), imageId = await docker.imageId(image), attemptId = randomUUID();
  const spec = { name: `kivro-probe-${attemptId}`, attemptId, owner: 'media-fixture', imageId, limits: SELF_TEST_LIMITS };
  // Create/inspect without starting: enforce the production entrypoint, user,
  // resolved image identity, mount, network and resource policy before generation.
  try { await docker.create(spec); } finally { await docker.remove(spec); }
  return imageId;
}

/** Test-only generation: fixed synthetic inputs, policy-checked image, no network or host mounts. */
export async function generateMediaFixtures(approvedImageId?: string): Promise<Map<string, Buffer>> {
  if (approvedImageId !== undefined && !IMAGE_ID.test(approvedImageId)) throw new Error('MEDIA_FIXTURE_REQUIRES_RESOLVED_IMAGE_ID');
  const imageId = await resolveMediaFixtureImage(approvedImageId);
  const name = `kivro-media-fixtures-${randomUUID()}`;
  const script = String.raw`
    const {spawnSync} = require('node:child_process');
    const {readFileSync} = require('node:fs');
    function run(binary, args) {
      const result = spawnSync(binary, args, {encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
      if (result.status !== 0) throw new Error(binary + ': ' + (result.stderr || result.error).toString().slice(0,2000));
    }
    const ff = ['-nostdin','-v','error','-threads','1','-filter_threads','1'];
    const video = ['-f','lavfi','-i','color=c=green:s=32x32:r=5:d=0.4'];
    const audio = ['-f','lavfi','-i','sine=frequency=440:duration=0.2'];
    run('/usr/bin/ffmpeg', [...ff,...video,'-frames:v','1','-c:v','libwebp','-threads','1','/job/work/lossy.webp']);
    run('/usr/bin/ffmpeg', [...ff,...video,'-frames:v','1','-c:v','libwebp','-lossless','1','-threads','1','/job/work/lossless.webp']);
    run('/usr/bin/ffmpeg', [...ff,...video,'-c:v','libx264','-pix_fmt','yuv420p','-threads','1','/job/work/clip.mov']);
    run('/usr/bin/ffmpeg', [...ff,...video,'-c:v','libx264','-pix_fmt','yuv420p','-threads','1','/job/work/clip.mp4']);
    run('/usr/bin/ffmpeg', [...ff,...video,'-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-movflags','+faststart','/job/work/faststart.mp4']);
    run('/usr/bin/ffmpeg', [...ff,...video,'-c:v','libvpx','-threads','1','/job/work/clip.webm']);
    run('/usr/bin/ffmpeg', [...ff,...audio,'-c:a','libmp3lame','-threads','1','/job/work/tone.mp3']);
    run('/usr/bin/ffmpeg', [...ff,...audio,'-c:a','aac','-threads','1','/job/work/tone.m4a']);
    run('/usr/bin/blender', ['--background','--factory-startup','--disable-autoexec','--threads','1','--python-expr',
      "import bpy; bpy.ops.export_scene.obj(filepath='/job/work/cube.obj',use_materials=False,use_selection=False); bpy.ops.export_scene.fbx(filepath='/job/work/cube.fbx',object_types={'MESH'},use_custom_props=False,bake_anim=False,path_mode='STRIP',embed_textures=False)"]);
    const names = ['lossy.webp','lossless.webp','clip.mov','clip.mp4','faststart.mp4','clip.webm','tone.mp3','tone.m4a','cube.obj','cube.fbx'];
    process.stdout.write(JSON.stringify(names.map(name => [name,readFileSync('/job/work/'+name).toString('base64')])));
  `;
  const args = ['run', '--rm', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=1000:1000', '--cpus=1', '--memory=1g', '--pids-limit=128',
    '--tmpfs=/job/work:rw,noexec,nosuid,size=134217728,uid=1000,gid=1000', '--tmpfs=/tmp:rw,noexec,nosuid,size=67108864,uid=1000,gid=1000',
    '--env=OMP_NUM_THREADS=1', '-i', '--entrypoint=node', imageId, '-'];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).unref(); reject(new Error('MEDIA_FIXTURE_TIMEOUT')); }, 180000);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 ** 2) { child.kill('SIGKILL'); spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).unref(); } else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (error.length < 4000) error += chunk.toString(); });
    child.on('error', failure => { clearTimeout(timer); reject(failure); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || size > 2 * 1024 ** 2) { reject(new Error(`MEDIA_FIXTURE_FAILED:${error}`)); return; }
      try { resolve(new Map((JSON.parse(Buffer.concat(chunks).toString()) as [string, string][]).map(([filename, base64]) => [filename, Buffer.from(base64, 'base64')]))); }
      catch (failure) { reject(failure); }
    });
    child.stdin.on('error', () => undefined); child.stdin.end(script);
  });
}
