---
meta:
  title: Release Kimi Code Companion
  navLabel: Release Kimi
  category: Guides
  contentType: How-to
contentPlan: ./content-plan.md#release-packages
---

# Release Kimi Code Companion

Validate and package the Kimi plugin from this repository. The plugin source is `plugins/kimi`; its `plugin.json` is the version authority and its marketplace install identity is `kimi@model-companions-kimi`.

## Validate a release

Run from the repository root with Node.js 18.18 or newer, npm, and Claude Code 2.1.169 or newer for strict manifest validation:

```bash
npm test
npm run validate
npm run release:check:strict
```

Run the package checks directly when diagnosing a packaged change:

```bash
npm --prefix plugins/kimi test
npm --prefix plugins/kimi run validate
```

## Version and package Kimi

Update the version authority and every generated or runtime version through the repository’s transaction. Replace both example versions with the intended plugin and marketplace versions:

```bash
node scripts/bump-version.mjs kimi 1.0.1 \
  --marketplace-version 1.0.1
npm run version:check
```

Do not edit version fields independently. Run the strict gate again, verify the proposed tag, and create the collision-safe archive:

```bash
npm run release:check:strict
npm run release:target -- v1.0.1
node scripts/release-checksums.mjs \
  --output dist/kimi-1.0.1
```

Verify `SHA256SUMS` from the output directory. Use the command available on the release system:

```bash
cd dist/kimi-1.0.1
shasum -a 256 -c SHA256SUMS
sha256sum --check SHA256SUMS
```

Create and push `v1.0.1` only after the checks pass. The tag workflow independently verifies the manifest version, rebuilds the archive, verifies its checksum, and creates provenance attestations:

```bash
git tag v1.0.1
git push origin v1.0.1
```

This repository releases only Kimi; do not coordinate a sibling package version, archive, or canary here. The marketplace metadata must continue to point to `./plugins/kimi` and identify `model-companions-kimi`.

## Recover a stopped version transaction

Version changes fail closed when the documented version lock or journal is present. First confirm that no release process owns the lock. Preserve unexpected symbolic links, incomplete directories, or malformed owner records as evidence. Recover the authenticated transaction, then validate its result:

```bash
node scripts/bump-version.mjs --recover
npm run version:check
npm run release:check:strict
```

Retry the bump with a new marketplace version if recovery reports a rollback.

Do not remove a live lock or publish a replacement archive over an existing output.
