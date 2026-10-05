import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { TestProject } from 'vitest/node'

/**
 * Build the source once per run, into a directory of its own, for the suites
 * that drive the built hooks in a subprocess.
 *
 * They used to run whatever was in dist/, which on this machine is the live
 * install every Claude session's hooks load. Testing a build meant replacing
 * the live one first, and building elsewhere left the suite testing the old
 * code: a gate added in source failed against a dist that predated it.
 *
 * The directory sits under the repo root, not tmpdir, because the CLI reads
 * ../package.json relative to itself. It is unique per run so concurrent runs
 * from several sessions never share or delete each other's build.
 */
export default function setup(project: TestProject) {
  const root = resolve(__dirname)
  const outDir = mkdtempSync(join(root, '.test-dist-'))
  execFileSync(join(root, 'node_modules', '.bin', 'tsup'), ['--out-dir', outDir, '--silent'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  project.provide('distDir', outDir)
  return () => rmSync(outDir, { recursive: true, force: true })
}

declare module 'vitest' {
  export interface ProvidedContext {
    distDir: string
  }
}
