import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } as const

type Row = { pane_id: string; tab_id: string; agent: string; agent_status: string; name: string }

const row = (n: number, agent: string, agent_status: string, name: string): Row => ({
  pane_id: `w1:p${n}`,
  tab_id: `w1:t${n}`,
  agent,
  agent_status,
  name,
})

// Stands for the host: herdr's answers, the .park folder, and what reached the screen and the model.
const IN_HERDR = { HERDR_SESSION: 'work', HERDR_PANE_ID: 'w1:p1' }

const host = (
  on: On,
  agents: Row[],
  notes: string[] = [],
  raw?: (argv: readonly string[]) => string | { exitCode: number } | undefined,
  env: Record<string, string> = IN_HERDR,
) => {
  const seen = {
    prompts: [] as { pane: string; text: string }[],
    closed: [] as string[],
    submitted: [] as string[],
    toasts: [] as string[],
    commands: [] as string[],
    statuses: [] as (string | undefined)[],
  }
  mock.env(on, env)
  const clock = mock.clock(on)
  // Lets the saves a command left running finish, then fires the timer that submits the prompt.
  const settle = async () => {
    for (let i = 0; i < 4; i++) await clock.advance(250)
  }
  const where = { cwd: '/repo' }
  on('session.cwd', () => ({ value: where.cwd }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const forced = raw?.(argv)
    if (typeof forced === 'object') return { value: { ...OK, stdout: '', ...forced } }
    if (forced !== undefined) return { value: { ...OK, stdout: forced } }
    if (argv[0] === 'find') return { value: { ...OK, stdout: notes.map(n => `/repo/.park/${n}\n`).join('') } }
    if (argv[3] === 'agent' && argv[4] === 'list') {
      return { value: { ...OK, stdout: JSON.stringify({ result: { agents } }) } }
    }
    if (argv[3] === 'agent' && argv[4] === 'prompt') {
      seen.prompts.push({ pane: argv[5] ?? '', text: argv[6] ?? '' })
      return { value: { ...OK, stdout: JSON.stringify({ result: { agent: { agent_status: 'idle' } } }) } }
    }
    if (argv[3] === 'tab' && argv[4] === 'close') seen.closed.push(argv[5] ?? '')

    return { value: { ...OK, stdout: '' } }
  })

  return { ...seen, settle, where, clock }
}

const run = ($: Parameters<TestBody>[0], command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('parks idle tabs, leaves a busy one alone, and will not close it', async ($, on) => {
  const seen = host(on, [
    row(1, 'claude', 'working', 'main'),
    row(2, 'claude', 'done', 'reviewer'),
    row(3, 'codex', 'idle', 'codex_two'),
    row(4, 'claude', 'working', 'builder'),
  ])
  await $.session.start(START)
  expect(seen.commands).toEqual(['park', 'unpark'])

  const parked = await run($, 'park')
  expect(parked.text).toContain('Parking 3 tabs')
  await seen.settle()

  // The tab's own pane (p1) is never prompted, and neither is the busy one (p4).
  expect(seen.prompts.map(p => p.pane)).toEqual(['w1:p2', 'w1:p3'])
  expect(seen.prompts[0]?.text).toContain('Save your work now')
  expect(seen.prompts[1]?.text).toContain('Save your work now')

  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toContain('Park this session.')
  expect(seen.submitted[0]).toMatch(/saved\s+claude\s+reviewer/)
  expect(seen.submitted[0]).toMatch(/busy\s+claude\s+builder/)

  const closed = await run($, 'park', 'close')
  expect(closed.text).toContain('Not closing')
  expect(closed.text).toContain('builder')
  expect(seen.closed).toEqual([])
})

test('closes the tabs once every one is saved', async ($, on) => {
  const seen = host(on, [row(1, 'claude', 'working', 'main'), row(2, 'claude', 'idle', 'reviewer'), row(3, 'codex', 'done', 'codex_two')])
  await $.session.start(START)

  expect((await run($, 'park', 'close')).text).toBe('Nothing parked. Run /park first.')
  await run($, 'park')
  await seen.settle()
  expect((await run($, 'park', 'close')).text).toBe('Closed 2 saved tabs.')
  expect(seen.closed).toEqual(['w1:t2', 'w1:t3'])
})

test('offers the newest note at session start, and /unpark picks it up', async ($, on) => {
  const seen = host(on, [], ['park-first.md', 'park-second.md'])
  await $.session.start(START)
  expect(seen.toasts).toEqual(['Parked note: park-first.md. Type /unpark to pick it up.'])

  expect((await run($, 'unpark')).text).toBe('Picking up park-first.md.')
  await seen.settle()
  expect(seen.submitted).toEqual(['Read .park/park-first.md and follow it.'])
})

test('with no other tabs, /park goes straight to saving this tab', async ($, on) => {
  const seen = host(on, [row(1, 'claude', 'working', 'main')])
  await $.session.start(START)

  expect((await run($, 'park')).text).toContain('No other agent tabs')
  await seen.settle()
  expect(seen.prompts).toEqual([])
  expect(seen.submitted[0]).toContain('There are no other agent tabs.')
})

test('a failed herdr listing does not leave /park stuck on "Already parking"', async ($, on) => {
  let broken = true
  const seen = host(on, [row(1, 'claude', 'working', 'main')], [], argv => (broken && argv[4] === 'list' ? 'not json' : undefined))
  await $.session.start(START)

  await run($, 'park').catch(() => undefined)
  broken = false
  expect((await run($, 'park')).text).not.toContain('Already parking')
  await seen.settle()
})

test('/unpark looks in the session cwd at run time, not the one seen at start', async ($, on) => {
  const finds: string[] = []
  const seen = host(on, [], ['park-a.md'], argv => {
    if (argv[0] === 'find') finds.push(argv[1] ?? '')
    return undefined
  })
  await $.session.start(START)
  seen.where.cwd = '/other'
  await run($, 'unpark')
  await seen.settle()
  expect(finds.at(-1)).toBe('/other/.park')
})

test('the park status line clears 60s after the note goes out', async ($, on) => {
  const seen = host(on, [row(2, 'claude', 'done', 'reviewer')])
  await $.session.start(START)
  await run($, 'park')
  await seen.settle()
  expect(seen.statuses.at(-1)).toContain('park: reviewer saved')

  await seen.clock.advance(60_000)
  expect(seen.statuses.at(-1)).toBeUndefined()
})

test('outside herdr the commands still register, /park writes the note, and herdr is never called', async ($, on) => {
  const ran: string[] = []
  const seen = host(on, [], ['park-a.md'], argv => {
    ran.push(argv[0] ?? '')
    return undefined
  }, {})
  await $.session.start(START)
  expect(seen.commands).toEqual(['park', 'unpark'])
  expect(seen.toasts).toEqual(['Parked note: park-a.md. Type /unpark to pick it up.'])

  expect((await run($, 'park')).text).toContain('No other agent tabs')
  await seen.settle()
  expect(seen.submitted[0]).toContain('Park this session.')
  expect(ran).not.toContain('herdr')
})

test('without a pane id this tab cannot be told apart, so no other tab is prompted', async ($, on) => {
  const seen = host(on, [row(1, 'claude', 'working', 'main'), row(2, 'claude', 'idle', 'reviewer')], [], undefined, { HERDR_SESSION: 'work' })
  await $.session.start(START)
  expect(seen.commands).toEqual(['park', 'unpark'])

  await run($, 'park')
  await seen.settle()
  expect(seen.prompts).toEqual([])
  expect(seen.submitted[0]).toContain('There are no other agent tabs.')
})

test('a machine without `find` starts the session quietly', async ($, on) => {
  const seen = host(on, [], [], argv => {
    if (argv[0] === 'find') throw new Error('spawn find ENOENT')
    return undefined
  })
  await $.session.start(START)
  expect(seen.commands).toEqual(['park', 'unpark'])
  expect(seen.toasts).toEqual([])
  expect((await run($, 'unpark')).text).toBe('No park note in .park.')
})

test('/park close does not close the tab this session runs in, even when another agent shares it', async ($, on) => {
  const own = row(1, 'claude', 'working', 'main')
  const sibling = { ...row(2, 'claude', 'idle', 'sibling'), tab_id: own.tab_id }
  const seen = host(on, [own, sibling, row(3, 'claude', 'idle', 'reviewer')])
  await $.session.start(START)
  await run($, 'park')
  await seen.settle()
  expect((await run($, 'park', 'close')).text).toBe('Closed 1 saved tab.')
  expect(seen.closed).toEqual(['w1:t3'])
})

test('/park close refuses when herdr cannot list the tabs', async ($, on) => {
  let listing = true
  const seen = host(on, [row(1, 'claude', 'working', 'main'), row(2, 'claude', 'idle', 'reviewer')], [], argv =>
    !listing && argv[4] === 'list' ? { exitCode: 1 } : undefined,
  )
  await $.session.start(START)
  await run($, 'park')
  await seen.settle()
  listing = false
  expect((await run($, 'park', 'close')).text).toContain('Not closing')
  expect(seen.closed).toEqual([])
})

test('/park close keeps a tab when another agent in it is working again', async ($, on) => {
  const rows = [row(1, 'claude', 'working', 'main'), row(2, 'claude', 'idle', 'reviewer')]
  const seen = host(on, rows)
  await $.session.start(START)
  await run($, 'park')
  await seen.settle()
  rows.push({ ...row(3, 'claude', 'working', 'newcomer'), tab_id: 'w1:t2' })
  expect((await run($, 'park', 'close')).text).toContain('Not closing')
  expect(seen.closed).toEqual([])
})

test('/park close does not claim a tab closed when herdr failed to close it', async ($, on) => {
  const seen = host(on, [row(1, 'claude', 'working', 'main'), row(2, 'claude', 'idle', 'reviewer')], [], argv =>
    argv[3] === 'tab' && argv[4] === 'close' ? { exitCode: 1 } : undefined,
  )
  await $.session.start(START)
  await run($, 'park')
  await seen.settle()
  expect((await run($, 'park', 'close')).text).toContain('Could not close')
  expect((await run($, 'park', 'close')).text).not.toBe('Nothing parked. Run /park first.')
})
