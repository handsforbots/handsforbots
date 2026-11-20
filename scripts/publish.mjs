#!/usr/bin/env node
// Publishes every public package in packages/ whose version is not on npm yet.
// Run by .github/workflows/release.yml with npm trusted publishing (OIDC): no
// token, no 2FA prompt. `pnpm pack` turns `workspace:^` into real versions and
// applies publishConfig; `npm publish` does the OIDC exchange and provenance.
// NPM_TAG (default `alpha`) is the dist-tag of the publish; NPM_ALSO_TAGS
// (comma-separated, e.g. `latest`) are pointed at the new version afterwards,
// which needs "Allow npm dist-tag" in each package's settings on npmjs.com:
// without it the version is published and a warning says which tag was not moved.
//
//   NPM_TAG=alpha NPM_ALSO_TAGS=latest node scripts/publish.mjs [--dry-run]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')

/** Public packages of the repository, in folder order. */
export function workspacePackages(dir = join(root, 'packages')) {
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'package.json')))
    .map((name) => ({ dir: join(dir, name), manifest: JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => !manifest.private)
}

/** The packages to publish: those whose `name@version` is not on the registry. */
export function plan(packages, isPublished) {
  return packages.filter(({ manifest }) => !isPublished(manifest.name, manifest.version))
}

const onRegistry = (name, version) => {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.trim() === version
}

function main() {
  const tag = process.env.NPM_TAG || 'alpha'
  const alsoTags = (process.env.NPM_ALSO_TAGS || '').split(',').map((t) => t.trim()).filter((t) => t && t !== tag)
  const dryRun = process.argv.includes('--dry-run')
  const all = workspacePackages()
  const todo = plan(all, onRegistry)
  for (const { manifest } of all) {
    if (!todo.some((p) => p.manifest.name === manifest.name)) console.log(`skip ${manifest.name}@${manifest.version} (already on npm)`)
  }
  if (todo.length === 0) return console.log('Nothing to publish.')
  const out = mkdtempSync(join(tmpdir(), 'h4b-publish-'))
  for (const { dir, manifest } of todo) {
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'inherit' })
    const tarball = join(out, `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`)
    const args = [
      'publish',
      tarball,
      '--tag',
      tag,
      '--access',
      'public',
      ...(process.env.CI ? ['--provenance'] : []),
      ...(dryRun ? ['--dry-run'] : []),
    ]
    console.log(`npm ${args.join(' ')}`)
    execFileSync('npm', args, { stdio: 'inherit' })
    if (dryRun) continue
    for (const extra of alsoTags) {
      const moved = spawnSync('npm', ['dist-tag', 'add', `${manifest.name}@${manifest.version}`, extra], { stdio: 'inherit' })
      if (moved.status !== 0) {
        console.log(`::warning::${manifest.name}@${manifest.version} is published, but its '${extra}' tag was not moved. Enable "Allow npm dist-tag" for the package on npmjs.com, or run: npm dist-tag add ${manifest.name}@${manifest.version} ${extra}`)
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
