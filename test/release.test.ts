import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module script without types
import { plan, workspacePackages } from '../scripts/publish.mjs'

const root = join(import.meta.dirname, '..')

type Pkg = { dir: string; manifest: { name: string; version: string; private?: boolean } }

describe('release', () => {
  it('publishes only public packages whose version is not on npm', () => {
    const packages = workspacePackages() as Pkg[]
    expect(packages.length).toBeGreaterThan(20)
    expect(packages.every((p) => !p.manifest.private && p.manifest.name.startsWith('@handsforbots/'))).toBe(true)
    const published = new Set(['@handsforbots/core'])
    const todo = plan(packages, (name: string) => published.has(name)) as Pkg[]
    expect(todo.map((p) => p.manifest.name)).not.toContain('@handsforbots/core')
    expect(todo).toHaveLength(packages.length - 1)
  })

  it('runs with OIDC permissions and the publish script', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('node scripts/publish.mjs')
    // npm matches the trusted publisher by this exact file name.
    expect(readFileSync(join(root, 'scripts/npm-trust.sh'), 'utf8')).toContain('--file release.yml')
  })
})
