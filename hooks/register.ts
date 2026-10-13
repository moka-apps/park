import type { EngineInterface, Register } from 'claude-code'

type Agent = {
  pane_id: string
  tab_id: string
  agent: string
  agent_status: string
  name?: string
  terminal_title_stripped?: string
}

// saving: the save prompt is out. busy: the tab was mid-task, so nothing was sent.
type Outcome = 'saving' | 'saved' | 'blocked' | 'busy' | 'failed'
type Tab = { agent: Agent; outcome: Outcome }

// process.run allows ten minutes at most; herdr gives up half a minute before that.
const SAVE_WAIT_MS = 540_000
// A note older than this is not offered at session start.
const FRESH_DAYS = 3

// Where the next-session notes go, relative to the project folder.
const NOTE_DIR = '.park'

const SAVE =
  'Save your work now. Finish or write down anything unsaved: what was done, what was not checked, dead ends, and anything a later session needs. Ask nothing, do not commit or push, then stop.'

const parkPrompt = (tabList: string) =>
  [
    'Park this session.',
    '1. Save your own work now: finish or write down anything unsaved. Ask nothing.',
    `2. Write the start prompt for the next session to the ${NOTE_DIR}/ folder of this project as park-<topic>.md: what is done, what is open, the first step, and any agent tab below that did not save.`,
    '3. Reply with the file path and one line per agent tab.',
    tabList === '' ? 'There are no other agent tabs.' : `Agent tabs after /park:\n${tabList}`,
  ].join('\n')

// The tabs of the last /park, by pane. A reload empties it; /park close then asks for a new /park.
let tabs = new Map<string, Tab>()
// The tab this session runs in; /park close never closes it, even when another agent shares it.
let ownTab: string | undefined
let isParking = false
let clearStatus: { cancel: () => void } | undefined

const label = (a: Agent) => (a.name ?? a.terminal_title_stripped ?? a.pane_id).slice(0, 28)

const lines = (list: Iterable<Tab>) =>
  [...list].map(t => `${t.outcome.padEnd(7)} ${t.agent.agent.padEnd(7)} ${label(t.agent)}`).join('\n')

// Without herdr (no session, or no pane id to tell this tab apart) there are no other tabs to act on.
async function herdr($: EngineInterface, args: readonly string[], timeoutMs?: number) {
  const session = await $.env.get('HERDR_SESSION')
  if (session === undefined || (await $.env.get('HERDR_PANE_ID')) === undefined) return undefined

  return $.process.run(['herdr', '--session', session, ...args], timeoutMs === undefined ? undefined : { timeoutMs })
}

async function others($: EngineInterface): Promise<Agent[]> {
  const ran = await herdr($, ['agent', 'list'])
  if (ran === undefined || ran.exitCode !== 0) return []
  const self = await $.env.get('HERDR_PANE_ID')
  const agents: Agent[] = JSON.parse(ran.stdout).result.agents
  ownTab = agents.find(a => a.pane_id === self)?.tab_id ?? ownTab

  return agents.filter(a => a.pane_id !== self)
}

// A command hook may not submit a prompt itself (it holds the turn the prompt would wait on),
// so the prompt goes out from a timer just after the hook has answered.
function later($: EngineInterface, text: string) {
  $.clock.after(250, () => void $.prompt.submit({ text, asUser: true }))
}

function show($: EngineInterface) {
  $.ui.status(tabs.size === 0 ? undefined : `park: ${[...tabs.values()].map(t => `${label(t.agent)} ${t.outcome}`).join(', ')}`)
}

// Known limit: "saved" means the tab took the save prompt and went quiet. The pane is not read to
// confirm the save itself; add a `herdr agent read` check if a false "saved" ever shows up.
async function save($: EngineInterface, tab: Tab) {
  try {
    const ran = await herdr(
      $,
      ['agent', 'prompt', tab.agent.pane_id, SAVE, '--wait', '--timeout', String(SAVE_WAIT_MS)],
      SAVE_WAIT_MS + 30_000,
    )
    const status = ran?.exitCode === 0 ? /"agent_status":"(\w+)"/.exec(ran.stdout)?.[1] : undefined
    tab.outcome = status === 'idle' || status === 'done' ? 'saved' : status === 'blocked' ? 'blocked' : 'failed'
  } catch {
    tab.outcome = 'failed'
  }
  show($)
}

async function close($: EngineInterface) {
  const all = [...tabs.values()]
  if (all.length === 0) return { text: 'Nothing parked. Run /park first.' }
  // A saved tab that was given new work since is no longer safe to close.
  const working = new Set((await others($)).filter(a => a.agent_status === 'working').map(a => a.pane_id))
  const open = all.filter(t => t.outcome !== 'saved' || working.has(t.agent.pane_id))
  if (open.length > 0) return { text: `Not closing. These tabs are not saved, or are working again:\n${lines(open)}` }

  const ids = new Set(all.map(t => t.agent.tab_id))
  ids.delete(ownTab ?? '')
  for (const id of ids) {
    await herdr($, ['tab', 'close', id])
  }
  tabs = new Map()
  show($)

  return { text: `Closed ${ids.size} saved tab${ids.size === 1 ? '' : 's'}.` }
}

// The newest note in this project's .park folder, no older than `days`.
async function newestNote($: EngineInterface, days: number): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  try {
    const ran = await $.process.run([
      'find', `${cwd}/${NOTE_DIR}`, '-maxdepth', '1', '-name', 'park-*.md', '-mtime', `-${days}`, '-exec', 'ls', '-t', '{}', '+',
    ])

    return ran.exitCode === 0 ? ran.stdout.split('\n')[0]?.split('/').pop() || undefined : undefined
  } catch {
    // no `find` on this machine (Windows): there is simply no note to offer
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      await $.command.register({
        name: 'park',
        description: 'Save this tab and write a note for the next session. In herdr, also saves the other agent tabs; /park close closes them',
        immediate: true,
      })
      await $.command.register({
        name: 'unpark',
        description: `Pick up the newest next-session note from ${NOTE_DIR}`,
        immediate: true,
      })
      const note = await newestNote($, FRESH_DAYS)
      if (note !== undefined) {
        $.ui.toast(`Parked note: ${note}. Type /unpark to pick it up.`, { timeoutMs: 15_000 })
      }
    }

    return next(e)
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    if (e.args.trim() === 'close') return close($)
    if (isParking) return { text: `Already parking:\n${lines(tabs.values())}` }

    clearStatus?.cancel()
    isParking = true
    let agents: Agent[]
    try {
      agents = await others($)
    } catch (err) {
      isParking = false
      throw err
    }
    const first = (a: Agent): Outcome =>
      a.agent_status === 'working' ? 'busy' : a.agent_status === 'blocked' ? 'blocked' : 'saving'
    tabs = new Map(agents.map(a => [a.pane_id, { agent: a, outcome: first(a) }]))
    show($)

    const sent = [...tabs.values()].filter(t => t.outcome === 'saving')
    void Promise.all(sent.map(t => save($, t))).then(() => {
      isParking = false
      later($, parkPrompt(lines(tabs.values())))
      // the line has done its job once the note is going out; /park close still works from `tabs`
      clearStatus = $.clock.after(60_000, () => $.ui.status(undefined))
    })

    return {
      text:
        agents.length === 0
          ? 'No other agent tabs. Saving this tab and writing the next-session note.'
          : `Parking ${agents.length} tab${agents.length === 1 ? '' : 's'}. This tab saves once they settle.\n${lines(tabs.values())}`,
    }
  })

  on('command.run', { command: 'unpark' }, async $ => {
    const note = await newestNote($, 3650)
    if (note === undefined) return { text: `No park note in ${NOTE_DIR}.` }
    later($, `Read ${NOTE_DIR}/${note} and follow it.`)

    return { text: `Picking up ${note}.` }
  })
}
