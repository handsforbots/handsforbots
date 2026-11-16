import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

type Manifest = {
  name: string
  description?: string
  keywords?: string[]
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  publishConfig?: { access?: string }
  repository?: { url?: string; directory?: string }
}

const packages = readdirSync(join(root, 'packages'))
  .filter((dir) => existsSync(join(root, 'packages', dir, 'package.json')))
  .map((dir) => ({ dir, manifest: JSON.parse(read(`packages/${dir}/package.json`)) as Manifest }))

/** The package plus the `@handsforbots` peers it can't work without: what an install line must name. */
function expectedInstall({ manifest }: (typeof packages)[number]): string[] {
  const optional = manifest.peerDependenciesMeta ?? {}
  const peers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => name.startsWith('@handsforbots/') && !optional[name]?.optional,
  )
  return [manifest.name, ...peers].sort()
}

/** `@handsforbots` packages named by the first `npm install` line of a text. */
function installed(text: string): string[] | undefined {
  const line = text.split('\n').find((l) => l.trim().startsWith('npm install'))
  if (!line) return undefined
  return [...line.matchAll(/@handsforbots\/[a-z0-9-]+/g)].map((m) => m[0]).sort()
}

/** The text of a `### \`@handsforbots/<name>\`` section, up to the next heading of that level or above. */
function section(text: string, name: string): string | undefined {
  const start = text.indexOf(`### \`${name}\``)
  if (start < 0) return undefined
  const rest = text.slice(start + 1)
  const end = rest.search(/\n#{2,3} /)
  return end < 0 ? rest : rest.slice(0, end)
}

describe('package catalog', () => {
  it('finds the packages it checks', () => {
    expect(packages.map((p) => p.dir)).toContain('core')
    expect(packages.length).toBeGreaterThan(20)
  })

  it.each(['docs/en-us/packages.md', 'docs/pt-br/packages.md'])(
    '%s describes every package with the install line its peers require',
    (doc) => {
      const text = read(doc)
      const wrong = packages.flatMap((pkg) => {
        const body = section(text, pkg.manifest.name)
        if (!body) return [`${pkg.manifest.name}: no section`]
        const names = installed(body)
        return JSON.stringify(names) === JSON.stringify(expectedInstall(pkg))
          ? []
          : [`${pkg.manifest.name}: installs ${names?.join(' ') ?? 'nothing'}`]
      })
      expect(wrong).toEqual([])
    },
  )

  it('each package README installs what its peers require', () => {
    const wrong = packages.flatMap((pkg) => {
      const path = `packages/${pkg.dir}/README.md`
      if (!existsSync(join(root, path))) return [`${pkg.manifest.name}: no README`]
      const names = installed(read(path))
      // A README without an install line is allowed only for the standalone library, which documents itself.
      if (!names && pkg.dir === 'semantic-event-observability') return []
      return JSON.stringify(names) === JSON.stringify(expectedInstall(pkg))
        ? []
        : [`${pkg.manifest.name}: installs ${names?.join(' ') ?? 'nothing'}`]
    })
    expect(wrong).toEqual([])
  })

  it('the integration skill lists every package', () => {
    const text = read('skills/handsforbots/references/packages.md')
    const missing = packages.filter((pkg) => !text.includes(`| \`${pkg.dir}\` |`)).map((pkg) => pkg.manifest.name)
    expect(missing).toEqual([])
  })

  it('every description starts with its role and the keywords name it, so the npm listing reads at a glance', () => {
    const roles: Record<string, string> = {
      'Start here': 'core',
      'Transport (pick one)': 'transport',
      UI: 'ui',
      Plugin: 'plugin',
      'Add-on': 'addon',
      Standalone: 'standalone',
      Dev: 'dev',
    }
    const wrong = packages.flatMap(({ dir, manifest }) => {
      const { description = '', keywords = [] } = manifest
      const label = Object.keys(roles).find((r) => description.replace(/^⭐ /, '').startsWith(`${r}. `))
      if (!label) return [`${manifest.name}: description has no role`]
      if (!keywords.includes('handsforbots') || !keywords.includes(`h4b-${roles[label]}`))
        return [`${manifest.name}: keywords lack handsforbots or h4b-${roles[label]}`]
      const readme = read(`packages/${dir}/README.md`)
      if (dir !== 'semantic-event-observability' && !readme.includes(`\n${description}\n`))
        return [`${manifest.name}: README summary differs from the description`]
      return []
    })
    expect(wrong).toEqual([])
  })

  it('the core README, the npm front door, links every other package', () => {
    const text = read('packages/core/README.md')
    const missing = packages
      .filter((pkg) => pkg.dir !== 'core' && !text.includes(`(https://www.npmjs.com/package/${pkg.manifest.name})`))
      .map((pkg) => pkg.manifest.name)
    expect(missing).toEqual([])
  })

  it.each(['README.md', 'docs/pt-br/README.md'])('%s lists every capability package', (doc) => {
    const text = read(doc)
    const missing = packages
      .filter((pkg) => /^(Plugin|Add-on|Standalone|Dev)\. /.test(pkg.manifest.description ?? ''))
      .filter((pkg) => !text.includes(`(https://www.npmjs.com/package/${pkg.manifest.name})`))
      .map((pkg) => pkg.manifest.name)
    expect(missing).toEqual([])
  })

  it('every package is published publicly from this repository', () => {
    const wrong = packages
      .filter(
        ({ dir, manifest }) =>
          manifest.publishConfig?.access !== 'public' ||
          manifest.repository?.directory !== `packages/${dir}` ||
          !manifest.repository?.url?.includes('github.com/handsforbots/handsforbots'),
      )
      .map((pkg) => pkg.manifest.name)
    expect(wrong).toEqual([])
  })
})
