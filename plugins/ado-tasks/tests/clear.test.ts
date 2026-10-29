import { expect, mock, test } from 'claude-code/testing'
import { CWD } from './repo'

const CONFIG = JSON.stringify({ projectUrl: 'https://fabrikam.visualstudio.com/Demo', patEnv: 'ADO_PAT_TEST' })

const PANE_PROPS = {
  title: 'Azure DevOps Work Items',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

type Panel = { status?: string; tasks?: { id: number }[] }

function list(id: number, title: string) {
  return (url: string): string => {
    if (url.includes('/wiql')) return JSON.stringify({ workItems: [{ id }] })
    if (url.includes('/classificationnodes/')) return JSON.stringify({ path: '\\Demo\\Iteration', children: [] })
    return JSON.stringify({ value: [{ id, fields: { 'System.Title': title, 'System.State': 'Active' } }] })
  }
}

test('a pane drawn in a session that loaded nothing (after a /clear) shows the stored list, then the current one', async ($, on) => {
  const clock = mock.clock(on)
  const store = new Map<string, unknown>()
  // The host's `$.state`; a /clear is a new session, whose value starts unset.
  let panel: Panel | undefined
  let version = 0
  let answer = list(7, 'Fix login')
  let onLoaded: (() => void) | undefined
  const written: number[][] = []
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: { env: { ADO_PAT_TEST: 'secret' } } }))
  on('fs.read', () => ({ value: CONFIG }))
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: answer(e.url) } }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('state.get', { plugin: 'ado-tasks' }, () => ({ value: { value: panel as never, version } }))
  on('state.set', { plugin: 'ado-tasks' }, (_$, e) => {
    panel = e.value as Panel
    version += 1
    written.push((panel.tasks ?? []).map(task => task.id))
    if (panel.status === 'ok' && panel.tasks?.some(task => task.id === 8)) onLoaded?.()
    return { value: { isSet: true as const, version } }
  })

  // A mocked `$.state` redraws no reader, so each check mounts the pane afresh.
  const mount = () =>
    $.ui.mount({ plugin: 'ado-tasks', surface: 'terminal', component: 'Pane', requestId: 'ado-tasks', props: PANE_PROPS })

  // The session before the /clear loads a list, which is kept in the store.
  const before = await mount()
  await before.press({ key: 'refresh' })
  await before.unmount()
  expect(store.get(`snapshot:${CWD}`)).toBeDefined()

  // The /clear: the panel value is gone, and the service now answers another list.
  panel = undefined
  version = 0
  written.length = 0
  answer = list(8, 'Add audit log')
  const loaded = new Promise<void>(resolve => (onLoaded = resolve))

  // Drawing the empty pane is what starts the resume, with no press.
  const redrawn = await mount()
  await redrawn.unmount()
  await clock.advance(0)
  await loaded

  // The stored list came back first, then the current one replaced it.
  expect(written[0]).toEqual([7])
  expect(written[written.length - 1]).toEqual([8])
  const after = await mount()
  expect(await after.find({ key: 'open-8' })).toBeDefined()
  expect(await after.find({ key: 'open-7' })).toBeUndefined()
  await after.unmount()
})
