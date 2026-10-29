import { describe, expect, test } from 'claude-code/testing'

import { defaultPatEnv, hasGitignoreEntry, parseProjectUrl, withGitignoreEntry, withLocalPat } from '../hooks/ado'
import { CWD, repoPath } from './repo'

describe('setup helpers', () => {
  test('defaultPatEnv names the variable after the project', () => {
    expect(defaultPatEnv(parseProjectUrl('https://dev.azure.com/org/Web%20Portal'))).toBe('ADO_PAT_WEB_PORTAL')
    expect(defaultPatEnv(parseProjectUrl('https://fabrikam.visualstudio.com/Bug-Tracker'))).toBe('ADO_PAT_BUG_TRACKER')
  })

  test('withLocalPat keeps every other key of the local settings', () => {
    const before = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, env: { OTHER: '1' } })
    expect(JSON.parse(withLocalPat(before, 'ADO_PAT_X', 'p'))).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      env: { OTHER: '1', ADO_PAT_X: 'p' },
    })
    expect(JSON.parse(withLocalPat(undefined, 'ADO_PAT_X', 'p'))).toEqual({ env: { ADO_PAT_X: 'p' } })
  })

  test('withLocalPat refuses a file that is not a JSON object', () => {
    expect(() => withLocalPat('{ broken', 'A', 'p')).toThrow()
    expect(() => withLocalPat('[]', 'A', 'p')).toThrow()
  })

  test('gitignore entries are recognised and appended once', () => {
    expect(hasGitignoreEntry('node_modules/\n.claude/\n')).toBe(true)
    expect(hasGitignoreEntry('node_modules/\n')).toBe(false)
    expect(withGitignoreEntry('node_modules/')).toBe(
      'node_modules/\n\n# Claude Code local settings (holds the Azure DevOps PAT)\n.claude/settings.local.json\n',
    )
  })
})

test('the pane walks a repository without ado.json through URL then PAT, then lists tasks', async ($, on) => {
  const files = new Map<string, string>([[`${CWD}/.gitignore`, 'node_modules/\n']])
    on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: {} }))
  on('fs.read', (_$, e) => {
    const text = files.get(repoPath(e.path))
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(repoPath(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ deny: 'no such path' }))
  on('http.fetch', (_$, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: e.url.includes('/wiql') ? JSON.stringify({ workItems: [] }) : JSON.stringify({ value: [] }),
    },
  }))

  const ui = await $.ui.mount({
    plugin: 'ado-tasks',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ado-tasks',
    props: {
      title: 'Azure DevOps Tasks',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'setup-url' })).toBeDefined()

  await ui.input({ key: 'setup-url', text: 'https://dev.azure.com/org/My%20Proj/_boards/board' })
  expect(JSON.parse(files.get(`${CWD}/.claude/ado.json`) ?? '{}')).toEqual({
    projectUrl: 'https://dev.azure.com/org/My%20Proj/_boards/board',
    patEnv: 'ADO_PAT_MY_PROJ',
  })
  expect(files.get(`${CWD}/.gitignore`)).toMatch(/\.claude\/settings\.local\.json/)
  expect(await ui.find({ key: 'setup-pat' })).toBeDefined()

  await ui.input({ key: 'setup-pat', text: '  secret-pat  ' })
  expect(JSON.parse(files.get(`${CWD}/.claude/settings.local.json`) ?? '{}')).toEqual({
    env: { ADO_PAT_MY_PROJ: 'secret-pat' },
  })
  expect(await ui.find({ key: 'setup-pat' })).toBeUndefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No work items.' })).toBeDefined()
})
