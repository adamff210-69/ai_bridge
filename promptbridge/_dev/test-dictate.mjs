/**
 * Pure-logic tests for extension/dictate.js.
 *
 * Run:  node _dev/test-dictate.mjs
 * No install needed — the engine is a classic IIFE, so it loads straight from
 * disk with a stub `globalThis`. Nothing here touches the DOM.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'extension', 'dictate.js'), 'utf8');
const scope = {};
new Function('globalThis', src)(scope);
const D = scope.PB.dictate;

let pass = 0;
const fails = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fails.push([name, got, want]);
  return ok;
};
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const say = (...phrases) => {
  const b = new D.CorrectionBuffer('');
  for (const p of phrases) b.push(p);
  return b.text;
};
const withCommit = (phrases, at) => {
  const b = new D.CorrectionBuffer('');
  phrases.forEach((p, i) => {
    b.push(p);
    if (i === at) b.commit();
  });
  return b.text;
};

/* ------------------------------------------------------------------ */
section('1 · self-correction');

check('magnitude slot keeps its clause', say('we should budget 50K for this', 'actually 75K'), 'we should budget 75K for this');
check('bare marker awaits replacement', say('let me meet Tuesday', 'wait', 'Friday'), 'let me meet Friday');
check('"wait no, X" is one correction', say('let me meet Tuesday', 'wait no Friday'), 'let me meet Friday');
check('falls back to clause boundary', say('we need the report and the summary', 'actually we need only the report'), 'we need only the report');
check('leading "no" + number word', say('I need three things', 'no five things'), 'I need five things');
check('leading "no" + weekday', say('ship it Friday', 'no Monday'), 'ship it Monday');
check('proper noun keeps its modifier', say('deploy to Staging tonight', 'actually production'), 'deploy to production tonight');
check('commit shields earlier sentences', say('keep this sentence, retract me', 'actually 42'), 'keep this sentence, 42');
check('"no" inside a phrase is inert', say('the no code path needs a test'), 'the no code path needs a test');
check('"no" with no slot is inert', say('no changes needed'), 'no changes needed');
check('currency', say('we need $2000 for the plan', 'actually $5000'), 'we need $5000 for the plan');
check('clock time is one slot', say('the call is at 3:30', 'wait 4:15'), 'the call is at 4:15');
check('units', say('latency is 200ms', 'actually 80ms'), 'latency is 80ms');
check('percent', say('we finished 40% of it', 'actually 90%'), 'we finished 90% of it');
check('scratch that trims the clause', say('remove the header, the footer and the nav', 'scratch that'), 'remove the header');
check('plain phrases still append', say('we need the report', 'and the summary'), 'we need the report and the summary');
check('empty input is safe', say(''), '');
check('two corrections in a row', say('budget 50K for tools', 'wait 75K', 'ship it Monday', 'no Friday'), 'budget 75K for tools ship it Friday');
check('version numbers', say('we are on Chrome 118', 'actually 120'), 'we are on Chrome 120');
check('last slot wins', say('move the standup to Tuesday and the review to Thursday', 'no Wednesday'), 'move the standup to Tuesday and the review to Wednesday');
check('multi-word tail re-phrases', say('call Sam about the invoice', 'actually email Tom about it'), 'call email Tom about it');
check('real commit boundary holds', withCommit(['ship it Friday', 'no Monday', 'also update the changelog'], 1), 'ship it Monday also update the changelog');
check('marker detection is a pure test', [D.looksLikeCorrection('wait'), D.looksLikeCorrection('we should ship it'), D.looksLikeCorrection('no wait')], [true, false, true]);

/* ------------------------------------------------------------------ */
section('2 · personal dictionary');

const d = new D.Dictionary();
d.add('PromptBridge');
d.add('ECONNRESET');
d.add('BullMQ');
check('seed size', d.size, 3);
check('exact terms are not rewritten', d.snap('PromptBridge is fine'), 'PromptBridge is fine');
check('fuzzy snap', d.snap('we use promtbridge here'), 'we use PromptBridge here');
check('snap is idempotent', d.snap(d.snap('promtbridge')), 'PromptBridge');
check('ordinary prose is untouched', d.snap('the bridge collapsed under load'), 'the bridge collapsed under load');
check('learnFromEdit spots the fix', d.learnFromEdit('send it to the prompt bridge team', 'send it to the PromptBridge team'), ['PromptBridge']);
check('no duplicates on relearn', d.learnFromEdit('use PromptBridge', 'use PromptBridge'), []);
check('removal', [d.remove('BullMQ'), d.size], [true, 2]);
check('clear', [d.clear(), d.size], [true, 0]);
const capped = new D.Dictionary({}, 5);
for (let i = 0; i < 20; i++) capped.add('Term' + i);
check('cap is enforced', capped.size <= 5, true);
check('levenshtein', [D.levenshtein('kitten', 'sitting'), D.levenshtein('', 'abc'), D.levenshtein('same', 'same')], [3, 3, 0]);
check('looksLikeTerm', [D.looksLikeTerm('PromptBridge'), D.looksLikeTerm('ECONNRESET'), D.looksLikeTerm('hello')], [true, true, false]);

/* ------------------------------------------------------------------ */
section('3 · command grammar');

const CMD = [
  ['send it', { kind: 'send' }], ['press enter', { kind: 'send' }], ['submit', { kind: 'send' }], ['go', { kind: 'send' }],
  ['scratch that', { kind: 'undo' }], ['clear it', { kind: 'undo' }], ['never mind', { kind: 'undo' }],
  ['stop listening', { kind: 'stop' }], ['stop', { kind: 'stop' }],
  ['new paragraph', { kind: 'newline' }], ['new point', { kind: 'newline' }],
  ['read that back', { kind: 'speak' }], ['speak', { kind: 'speak' }],
  ['enhance that', { kind: 'enhance' }], ['prompt it', { kind: 'enhance' }],
  ['draft the follow up', { kind: 'followup' }], ['continue this', { kind: 'followup' }],
  ['capture this pack', { kind: 'capture' }], ['save the context', { kind: 'capture' }], ['capture pack', { kind: 'capture' }],
  ['send to claude', { kind: 'sendTo', dest: 'claude' }], ['try chat gpt', { kind: 'sendTo', dest: 'chatgpt' }],
  ['continue in gemini', { kind: 'sendTo', dest: 'gemini' }],
  ['bullet list', { kind: 'lens', mode: 'bullets' }], ['make it a bullet list', { kind: 'lens', mode: 'bullets' }],
  ['bullets', { kind: 'lens', mode: 'bullets' }], ['turn this into a list', { kind: 'lens', mode: 'bullets' }],
  ['make it a table', { kind: 'lens', mode: 'table' }], ['as json', { kind: 'lens', mode: 'json' }],
  ['format it as json please', { kind: 'lens', mode: 'json' }],
  ['the code only', { kind: 'lens', mode: 'code' }], ['extract the code', { kind: 'lens', mode: 'code' }],
  ['write it as an email', { kind: 'lens', mode: 'email' }], ['make it an e-mail', { kind: 'lens', mode: 'email' }],
  ['shorter', { kind: 'lens', mode: 'tldr' }], ['tl dr', { kind: 'lens', mode: 'tldr' }], ['give me a summary', { kind: 'lens', mode: 'tldr' }],
  ['more formal', { kind: 'refine' }], ['make it formal', { kind: 'refine' }], ['casual', { kind: 'refine' }],
  ['less formal', { kind: 'refine' }], ['translate to spanish', { kind: 'refine' }], ['translate this to tamil', { kind: 'refine' }],
];
for (const [phrase, want] of CMD) {
  const got = D.matchCommand(phrase);
  check('cmd: ' + phrase, got && Object.keys(want).every((k) => got[k] === want[k]), true);
}
for (const phrase of [
  'send it to the manager about the invoice',
  'the list of things we need is long',
  'i want to stop the service',
  'no code please',
  'go to the settings page',
  'we need a summary of the quarterly numbers for the board deck',
  '',
  null,
]) {
  check('not a cmd: ' + phrase, D.matchCommand(phrase), null);
}

/* ------------------------------------------------------------------ */
section('4 · command dispatch');

const calls = [];
const fakeShell = { actions: new Proxy({}, { get: (_, k) => (...a) => (calls.push([k, ...a]), true) }) };
for (const c of [
  { kind: 'send' }, { kind: 'undo' }, { kind: 'stop' }, { kind: 'newline' }, { kind: 'speak' },
  { kind: 'enhance' }, { kind: 'followup' }, { kind: 'capture' }, { kind: 'sendTo', dest: 'claude' },
  { kind: 'lens', mode: 'bullets' }, { kind: 'refine', instruction: 'Rewrite the text to be more formal and professional' },
]) D.runCommand(c, fakeShell);
check('every command reached an action', calls.length, 11);
check('sendTo carried its destination', calls.find((c) => c[0] === 'sendTo')[1], 'claude');
check('lens carried its mode', calls.find((c) => c[0] === 'lens')[1], 'bullets');
check('refine carried its instruction', calls.find((c) => c[0] === 'refine')[1], 'Rewrite the text to be more formal and professional');
check('unknown command is a no-op', D.runCommand({ kind: 'nope' }, fakeShell), false);
check('missing action does not throw', D.runCommand({ kind: 'send' }, {}), undefined);

/* ------------------------------------------------------------------ */
section('5 · filler + punctuation');

check('fillers stripped', D.clean('um so basically we should uh ship it on Friday'), 'We should ship it on Friday.');
check('mid-sentence "so" is kept', D.clean('we need it so the build passes'), 'We need it so the build passes.');
check('short text is not force-punctuated', D.clean('ok'), 'Ok');
check('polish snaps to the dictionary', D.polish('use promtbridge', { dictionary: (() => { const x = new D.Dictionary(); x.add('PromptBridge'); return x; })() }), 'Use PromptBridge');
check('polish with no dictionary is safe', D.polish('um hello there'), 'Hello there');
check('tiers are declared', D.tiers.map((t) => t.id), ['webspeech', 'whisper-local']);

/* ------------------------------------------------------------------ */
console.log('');
for (const [n, got, want] of fails) console.log('  FAIL ' + n + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
console.log(fails.length ? '\n\x1b[31m' + fails.length + ' failed\x1b[0m, ' + pass + ' passed' : '\x1b[32mall ' + pass + ' checks passed\x1b[0m');
process.exit(fails.length ? 1 : 0);
