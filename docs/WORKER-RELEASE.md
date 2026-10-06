# Worker Private-Beta Artifact

`pnpm worker:package` deploys the exact installed production dependency closure,
copies the pinned sandbox recipe and compatibility documentation, verifies that
no private configuration paths or escaping symlinks are present, and executes
the CLI from the isolated deployment before packaging it.

Outputs are in `dist/kivro-worker-VERSION-PLATFORM-ARCH.tar.gz` and its `.sha256`
file. `RELEASE-MANIFEST.json` records runtime compatibility, platform/architecture,
per-file hashes and internal symlink targets. The archive includes dependencies,
but requires Node.js 22.13+ and a separately installed supported OpenClaw/Docker.
It contains no identity, pairing code, provider keys or personal configuration.

Verify the checksum before extracting on the matching operating system and CPU:

```sh
shasum -a 256 -c kivro-worker-VERSION-PLATFORM-ARCH.tar.gz.sha256
tar -xzf kivro-worker-VERSION-PLATFORM-ARCH.tar.gz
cd worker
node --import tsx src/index.ts version
node --import tsx src/index.ts help
docker build -t kivro-sandbox:2026.8.2 security/sandbox
```

The artifact is deliberately labeled **unsigned private beta**. It does not
claim macOS notarization, Windows code signing, secure automatic updates or
public-release approval. Those release-stage gates need the operator's signing
identities and independent security acceptance. Installation never happens
automatically during packaging. Background-service installation remains an
explicit Worker CLI action on supported hosts.

CI builds artifacts on macOS and Linux, and separately runs actual isolated
OpenClaw/Docker smoke and deterministic full-stack tests on a disposable hosted
Linux runner. No provider keys or production secrets are available to those
tests. Successful local execution is not represented as a completed remote CI run.
