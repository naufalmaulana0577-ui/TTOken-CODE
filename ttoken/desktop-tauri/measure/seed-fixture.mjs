/**
 * Write the synthetic Sessions the S2 and S3 measurement scenarios open, into an isolated Harness home.
 *
 * Run with the payload's bundled Node, `--input-type=module --eval`, and the payload project as the working directory,
 * so the imports resolve to the shipped packages. Arguments: the Harness home, then the fixture Workspace directory.
 * Measure-Desktop.ps1 -Setup does this.
 *
 * Content comes from fixed constants, as in benchmarks/long-session-browser/synthetic-history.ts: mixed prose,
 * reasoning, code fences, and tool results, with no user data, model, or network. Each Session is written through the
 * shipped JSONL persistence plugin at `<home>/sessions`, the root the Desktop profile reads. Existing fixture Sessions
 * are replaced.
 */

import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [home, workspace] = process.argv.slice(1).map(path => resolve(path))
if (home === undefined || workspace === undefined) throw new Error('usage: seed-fixture <harness home> <workspace>')

/** Sessions of the fixture: id, title, closed turns, and the marker text every Assistant answer carries. */
const FIXTURE = [
  { id: 'ttoken-measure-s2-long', title: 'S2 long session', turns: 240, marker: 'S2-LONG' },
  { id: 'ttoken-measure-s3-a', title: 'S3 session A', turns: 30, marker: 'S3-SESSION-A' },
  { id: 'ttoken-measure-s3-b', title: 'S3 session B', turns: 30, marker: 'S3-SESSION-B' },
  { id: 'ttoken-measure-s3-c', title: 'S3 session C', turns: 30, marker: 'S3-SESSION-C' },
]
/** Creation times spaced one minute apart, oldest first, ending one hour before seeding. */
const FIRST_CREATED_AT = Date.now() - 3_600_000 - FIXTURE.length * 60_000

function history(spec) {
  const session = Session.create(spec.id)
  let time = FIRST_CREATED_AT
  for (let turn = 1; turn <= spec.turns; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${spec.marker} request ${turn}: review the synthetic change and keep its ordering. `.repeat(6) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title: spec.title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    const callId = `${spec.id}-tool-${turn}`
    const tool = turn % 6 === 0
    const code = turn % 12 === 0
      ? `\n\n\`\`\`ts\n${Array.from({ length: 60 }, (_, line) => `const value${line} = ${line}`).join('\n')}\n\`\`\``
      : ''
    const reasoning = 'Compare the synthetic module and its test. '.repeat(40)
    const text = `${spec.marker} answer ${turn}. ${'Preserve ordering and validate the output. '.repeat(30)}${code}`
    const args = '{"path":"src/example.ts"}'
    const stream = new AssistantStreamAccumulator()
    const push = (chunk) => { stream.push({ time: time++, chunk }) }
    for (const [index, block] of [{ type: 'reasoning', text: reasoning }, { type: 'text', text }].entries()) {
      push({ type: 'block-start', index, blockType: block.type })
      for (let offset = 0; offset < block.text.length; offset += 12) {
        push({ type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text.slice(offset, offset + 12) })
      }
      push({ type: 'block-end', index, block })
    }
    if (tool) {
      push({ type: 'block-start', index: 2, blockType: 'tool-call' })
      for (let offset = 0; offset < args.length; offset += 8) {
        push({ type: 'tool-call-delta', index: 2, id: callId, ...offset === 0 ? { name: 'synthetic_tool' } : {}, argumentsDelta: args.slice(offset, offset + 8) })
      }
      push({ type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'synthetic_tool', arguments: args } })
    }
    push({ type: 'usage', usage: { inputTokens: 4000, outputTokens: 800 } })
    push({ type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } })
    session.append('assistant/message', {
      turn, step: 1, stream: [...stream.snapshot()],
      message: createAssistantMessage({
        source: { provider: 'ttoken', model: 'deepseek/deepseek-v4.1-flash' },
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text },
          ...tool ? [{ type: 'tool-call', id: callId, name: 'synthetic_tool', arguments: args }] : [],
        ],
      }),
      usage: { inputTokens: 4000, outputTokens: 800 },
    }, { surfaceOp: 'append' })
    if (tool) {
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_tool', arguments: args })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'Synthetic tool output line.\n'.repeat(160) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents()
}

const root = join(home, 'sessions')
const seeder = new Context()
try {
  await seeder.plugin(JsonlSessionPersistence, { root })
  for (const [index, spec] of FIXTURE.entries()) {
    const meta = {
      version: SESSION_FORMAT_VERSION,
      id: spec.id,
      createdAt: FIRST_CREATED_AT + index * 60_000,
      isSeeded: false,
      cwd: workspace,
      delegationDepth: 0,
    }
    const location = seeder.sessionPersistence.locate?.(meta)
    if (location?.kind === 'jsonl') rmSync(location.path, { force: true })
    const events = history(spec)
    const handle = await seeder.sessionPersistence.create(meta)
    await handle.append(events)
    await handle.close()
    console.log(`seeded ${spec.title}: ${spec.turns} turns, ${events.length} events`)
  }
}
finally {
  await seeder.fiber.dispose()
}
