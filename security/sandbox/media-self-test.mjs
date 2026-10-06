import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

async function run(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { if (error.length < 2000) error += chunk.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MEDIA_TEST_TIMEOUT')); }, 60000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`MEDIA_TEST_FAILED:${error}`)); });
  });
}
// Only fixed synthetic assets are generated. No seller/buyer file or command is used.
await run('/usr/bin/blender', ['--background', '--factory-startup', '--disable-autoexec', '--threads', '1', '--python-expr', "import bpy; s=bpy.context.scene; s.render.resolution_x=64; s.render.resolution_y=64; s.render.resolution_percentage=100; bpy.ops.wm.save_as_mainfile(filepath='/job/work/canary.blend')"]);
await run('/usr/bin/blender', ['--background', '--factory-startup', '--disable-autoexec', '/job/work/canary.blend', '--engine', 'BLENDER_WORKBENCH', '--threads', '1', '--render-format', 'PNG', '--render-output', '/job/output/render_', '--render-frame', '1']);
const png = (await readdir('/job/output')).find(name => name.endsWith('.png'));
assert(png); assert((await readFile(`/job/output/${png}`)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
await run('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-threads', '1', '/job/work/canary.wav']);
await run('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', '/job/work/canary.wav', '-t', '120', '-threads', '1', '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-n', '/job/output/transcoded.mp4']);
assert.equal((await readFile('/job/output/transcoded.mp4')).subarray(4, 8).toString(), 'ftyp');
process.stdout.write(JSON.stringify({ type: 'media-test', ok: true, checks: ['blender-fixed-render', 'ffmpeg-fixed-transcode'] }) + '\n');
