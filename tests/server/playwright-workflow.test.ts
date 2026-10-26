import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync(resolve('.github/workflows/playwright.yml'), 'utf8'))

describe('Playwright shard budget', () => {
  it('keeps every test distributed over six independently required shards', () => {
    const job = workflow.jobs['e2e-shard']
    expect(job.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6])
    expect(job.strategy['fail-fast']).toBe(false)
    const run = job.steps.find((step: any) => step.name === 'Run Playwright tests')
    expect(run.run).toBe('npm run test:e2e -- --shard=${{ matrix.shard }}/6')
    expect(workflow.jobs.e2e.needs).toBe('e2e-shard')
    expect(workflow.jobs.e2e.steps.at(-1).run).toBe('test "$SHARD_RESULT" = success')
  })

  it('reserves cold-runner setup time, allows graceful test timeout, and requires blob reports', () => {
    const job = workflow.jobs['e2e-shard']
    const testStep = job.steps.find((step: any) => step.name === 'Run Playwright tests')
    expect(job['timeout-minutes']).toBe(50)
    expect(testStep['timeout-minutes']).toBe(25)
    // Keep cold-runner setup and artifact upload outside the test-step budget.
    expect(job['timeout-minutes'] - testStep['timeout-minutes']).toBeGreaterThanOrEqual(20)
    const config = readFileSync(resolve('playwright.config.ts'), 'utf8')
    expect(config).toContain('globalTimeout: process.env.CI ? 23 * 60 * 1000 : undefined')
    const report = job.steps.find((step: any) => step.name === 'Upload shard report')
    expect(report.with['if-no-files-found']).toBe('error')
    expect(report.if).toBe('${{ !cancelled() }}')
  })
})
