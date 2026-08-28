'use strict';

/**
 * The Prompt tab's backend — one headless `claude -p` per turn.
 *
 * Deliberately NOT the VSCode session you already have open. That was the first
 * thing tried, and the extension itself refuses it: `claude-vscode.editor.open`
 * takes an `initialPrompt`, but `createPanel` answers a session that already
 * exists with "Session is already open. Your prompt was not applied — enter it
 * manually", and even on the new-session path the webview only calls
 * `setInputText` — a prefill, never a submit. The IDE websocket advertised in
 * `~/.claude/ide/<port>.lock` is the extension serving *terminal* CLI sessions
 * and its whole method surface is get_current_selection / selection_changed /
 * at_mentioned / openDiff / executeCode. Nothing there submits a turn. So the
 * editor runs its own session, which it can actually drive end to end.
 *
 * A turn is a child process, not a persistent one: `--resume` carries the
 * conversation forward across turns, so there is no daemon to supervise, no
 * stdin protocol to keep in sync, and a hung turn is killed by killing a pid.
 */

const { spawn } = require('child_process');

// Availability, not approval. `--allowed-tools` is the auto-approve list; what
// keeps a tool out of the session entirely is the deny list. Bash is the whole
// point of the fence — an editor that redesigns a button has no business
// running commands — and the network tools go with it so a prompt typed into a
// web page cannot reach out of the machine.
const DENIED = ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

// A turn that has stopped making progress has to end by itself: the panel is a
// text box on a web page, not a terminal someone is watching.
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The house rule every turn is held to, whatever was asked.
 *
 * Stated rather than hoped for, because the editor and the model would
 * otherwise disagree about what a change even is. Every control in the panel
 * reads and writes classes; a `style={{…}}` is invisible to all of them, so a
 * turn that reaches for one produces a change the developer cannot then see in
 * a field, adjust with a stepper, or undo from the overlay — and the next class
 * edit they make will not override it either, since an inline style outranks
 * every utility on the element.
 *
 * The escape hatch is named on purpose. A rule with no way out gets argued with
 * or quietly broken; this one says which ladder to climb first — an arbitrary
 * value covers nearly everything a stock utility misses — and asks for the
 * reason out loud when neither can do it.
 */
const HOUSE_RULES = [
  'HOW TO STYLE, whatever is asked:',
  '- Use Tailwind utility classes. Do not add a style={{…}} attribute.',
  '  Every control in this editor reads and writes classes, so an inline style',
  '  is a change the developer cannot see, adjust or undo from the panel, and',
  '  it outranks any class they set afterwards.',
  '- If no stock utility fits, use an arbitrary value first: p-[13px],',
  '  bg-[#f0a], w-[calc(100%-3rem)]. That covers almost everything.',
  '- Only where neither can work — a value that is not known until runtime —',
  '  use inline style, and say in your reply that you had to and why.',
].join('\n');

/**
 * What the element under the cursor is, said the way a person would say it.
 *
 * This is the whole reason the tab is worth building. The overlay already knows
 * the exact source location — the loader stamped `file:line:col:hash` onto the
 * element — so the prompt does not have to describe what to change, it can
 * point at it. "Make this blue" is useless to a fresh session; "in page.tsx at
 * 42:7, the <button className='px-6 py-2'> — make this blue" is not.
 */
function preamble(ctx) {
  if (!ctx || !ctx.file) {
    return [
      'A developer is talking to you from a visual editor overlaid on their running app.',
      'They have no element selected, so this is a question about the project as a whole.',
      '',
      HOUSE_RULES,
    ].join('\n');
  }

  const lines = [
    'A developer is talking to you from a visual editor overlaid on their running app.',
    'They have selected one element on the page. It is rendered by this JSX:',
    '',
    '  file:    ' + ctx.file,
    '  line:    ' + ctx.line + ', column ' + ctx.col,
  ];
  if (ctx.tag) lines.push('  element: <' + ctx.tag + '>');
  if (ctx.classes) lines.push('  className: "' + ctx.classes + '"');
  if (ctx.text) lines.push('  text: ' + JSON.stringify(ctx.text.slice(0, 200)));
  if (ctx.instances > 1) {
    lines.push(
      '',
      'CAUTION: that one source location renders ' + ctx.instances + ' elements on this ' +
      'page. Editing it changes every one of them. If the request only makes sense for ' +
      'the one they clicked, say so instead of guessing.'
    );
  }
  lines.push(
    '',
    'Edit that element in that file. Keep the change as small as the request:',
    'this is a live app being nudged, not a refactor. Do not reformat surrounding code.',
    '',
    HOUSE_RULES,
    '',
    'Answer in one or two sentences — the reply is read in a small panel, not a terminal.'
  );
  return lines.join('\n');
}

function buildArgs(opts) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--disallowed-tools', DENIED.join(','),
  ];
  // Resume is what makes the panel a conversation rather than a series of
  // strangers. The id comes from the previous turn's system/init.
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  return args;
}

/**
 * Run one turn. `onEvent` is called with small, already-shaped objects — the
 * panel should never have to know what a stream-json envelope looks like.
 *
 * Returns { kill } so the caller can stop the turn when the browser goes away.
 */
function runTurn(opts, onEvent) {
  const args = buildArgs(opts);
  const child = spawn(opts.bin || 'claude', args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A prompt arriving from a web page must not inherit whatever the editor
    // server happened to be started with.
    env: Object.assign({}, process.env, { CLAUDE_CODE_ENTRYPOINT: 'thisone' }),
  });

  let done = false;
  const finish = (payload) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onEvent(Object.assign({ t: 'done' }, payload));
  };

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ error: 'timed out after ' + Math.round(TURN_TIMEOUT_MS / 1000) + 's' });
  }, TURN_TIMEOUT_MS);

  // The prompt goes in on stdin, never as an argv element: it is arbitrary text
  // from a text box and argv is the one place that would make its length and
  // its leading dashes matter.
  child.stdin.end(preamble(opts.context) + '\n\n---\n\n' + opts.prompt);

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a non-JSON line is noise from a wrapper, not a turn event
      }
      translate(msg, onEvent, finish);
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c.slice(0, 4096); });

  child.on('error', (err) => finish({ error: 'could not start claude: ' + err.message }));
  child.on('close', (code) => {
    finish({ error: code === 0 ? undefined : (stderr.trim() || 'claude exited ' + code) });
  });

  return { kill: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
}

/** stream-json envelope → the two or three things the panel actually shows. */
function translate(msg, onEvent, finish) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    return onEvent({ t: 'session', sessionId: msg.session_id });
  }

  // What a turn actually costs the person running it.
  //
  // `claude -p` authenticates the same way the CLI and the VSCode extension do
  // — the OAuth credentials already on this machine, not an API key — so a turn
  // draws on the plan's rolling windows, and `total_cost_usd` in the result is
  // an equivalent computed at list prices, not a charge anyone is billed.
  // Printing dollars beside a subscription turn is a plausible-looking lie, so
  // the panel shows the thing that is really being spent: the five-hour window.
  if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
    const w = (msg.rate_limit_info.unifiedWindows || {}).five_hour;
    if (w && typeof w.utilization === 'number') {
      return onEvent({ t: 'limit', utilization: w.utilization, resetsAt: w.resetsAt });
    }
    return;
  }

  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        onEvent({ t: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        // Named, not narrated. The panel shows "Edit page.tsx" so a long turn
        // does not look like a hang; the transcript is not the place to replay
        // an entire tool input.
        onEvent({ t: 'tool', name: block.name, detail: toolDetail(block) });
      }
    }
    return;
  }

  if (msg.type === 'result') {
    return finish({
      sessionId: msg.session_id,
      durationMs: msg.duration_ms,
      error: msg.is_error ? (msg.result || 'the turn failed') : undefined,
    });
  }
}

function toolDetail(block) {
  const input = block.input || {};
  const file = input.file_path || input.path || input.notebook_path;
  if (file) return String(file).split('/').pop();
  if (input.pattern) return String(input.pattern).slice(0, 40);
  return '';
}

module.exports = { runTurn, preamble, HOUSE_RULES, DENIED };
