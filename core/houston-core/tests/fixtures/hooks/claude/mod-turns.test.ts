import { expect, mock, test } from 'claude-code/testing';

function world(on, failHelper = false) {
  const reports = [];
  mock.env(on, { TR_SESSION: '7', HOUSTON_CHANNEL: 'fixture' });
  on('session.id', () => ({ value: 'root-session' }));
  on('session.cwd', () => ({ value: '/fixture' }));
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: 'unchanged' }));
  on('process.run', (_, e) => {
    if (failHelper) return { deny: 'fixture failure' };
    reports.push({ event: e.argv[2], payload: JSON.parse(e.init.stdin), env: e.init.env });
    return { value: { exitCode: 0, stdout: '', stderr: '' } };
  });
  return reports;
}

test('the main interrupted turn reports once without altering the answer', async ($, on) => {
  const reports = world(on);
  await $.turn.start({ turnId: 'one', text: '' });
  const ended = { turnId: 'one', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' };
  const result = await $.turn.complete(ended);
  await $.turn.complete(ended);
  expect(result.text).toBe('unchanged');
  expect(reports.map(report => report.event)).toEqual(['ModTurnStart', 'ModTurnInterrupted']);
  expect(reports[1].payload).toEqual({ session_id: 'root-session', cwd: '/fixture', turn_id: 'one' });
  expect(reports[1].env).toEqual({ TR_SESSION: '7', HOUSTON_CHANNEL: 'fixture' });
});

test('subagents, normal answers and old turns do not interrupt the pane', async ($, on) => {
  const reports = world(on);
  await $.turn.start({ turnId: 'one', text: '' });
  await $.turn.start({ turnId: 'two', text: '' });
  for (const event of [
    { turnId: 'one', isAborted: true, reason: 'aborted' },
    { turnId: 'two', isAborted: true, reason: 'aborted', agentId: 'child' },
    { turnId: 'two', isAborted: false, reason: 'answer' },
    { turnId: 'two', isAborted: false, reason: 'error' },
  ]) {
    const result = await $.turn.complete({ answer: '', durationMs: 1, ...event });
    expect(result.text).toBe('unchanged');
  }
  expect(reports.map(report => report.event)).toEqual(['ModTurnStart', 'ModTurnStart']);
});

test('a failed helper cannot stop the native lifecycle chain', async ($, on) => {
  world(on, true);
  on('ui.log', () => ({ value: undefined }));
  await $.turn.start({ turnId: 'one', text: '' });
  const result = await $.turn.complete({ turnId: 'one', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' });
  expect(result.text).toBe('unchanged');
});
