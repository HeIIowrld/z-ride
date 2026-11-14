import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createQuizEngine } from '../shared/quiz-engine.js';

const bank = JSON.parse(await readFile(new URL('../games/license-quiz/questions.json', import.meta.url), 'utf8'));
const signFiles = new Set((await readdir(new URL('../games/license-quiz/signs/', import.meta.url))).filter(name => /^kr_\d+\.svg$/.test(name)));
const ids = new Set(), sourceNumbers = new Set();
assert.ok(bank.length >= 300, `question count must be at least 300 (got ${bank.length})`);
for (const q of bank) {
  assert.match(q.id, /^koroad-\d+$/);
  assert.equal(q.id, `koroad-${q.sourceNo}`);
  assert.ok(!ids.has(q.id), `duplicate id ${q.id}`); ids.add(q.id);
  assert.ok(Number.isInteger(q.sourceNo) && q.sourceNo >= 1 && q.sourceNo <= 1136);
  assert.ok(!sourceNumbers.has(q.sourceNo), `duplicate source number ${q.sourceNo}`); sourceNumbers.add(q.sourceNo);
  assert.equal(q.choices.length, 4, `${q.id}: exactly four choices`);
  assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3);
  assert.equal(q.reviewStatus, 'official');
  if (q.sign !== null) assert.ok(signFiles.has(`kr_${q.sign}.svg`), `${q.id}: SVG missing`);
  assert.ok(['highway','intersection','school_zone','urban','any'].includes(q.roadContext));
}
for (const trigger of ['tbt:right','caution:school_zone','wiper','night','speedLimit']) assert.ok(bank.filter(q => q.trigger === trigger).length >= 5, `${trigger} needs at least five items`);
assert.ok(bank.filter(q => q.roadContext === 'highway').length >= 8);
assert.ok(bank.filter(q => q.roadContext === 'intersection').length >= 8);

let time = 1_000_000;
const engine = createQuizEngine({ bank, now: () => time, rng: () => 0 });
const first = engine.onTrigger({ type: 'tbt', detail: { turn: 'right' }, at: time }); assert.ok(first);
assert.equal(engine.onTrigger({ type: 'caution', detail: { kind: 'speed_bump' }, at: time + 1000 }), null, '60-second gap');
time += 60_000;
const second = engine.onTrigger({ type: 'tbt', detail: { turn: 'right' }, at: time }); assert.ok(second); assert.notEqual(first.id, second.id, 'no duplicate question');
const priorityEngine = createQuizEngine({ bank, now: () => time, rng: () => 0 });
assert.equal(priorityEngine.onTrigger({ type: 'tbt', detail: { turn: 'right' }, at: time })?.trigger, 'tbt:right', 'trigger match has priority');
const leftEngine = createQuizEngine({ bank, now: () => time, rng: () => 0 });
assert.equal(leftEngine.onTrigger({ type: 'tbt', detail: { turn: 'left' }, at: time })?.trigger, 'tbt:left');
const fallbackEngine = createQuizEngine({ bank: bank.filter(q => q.trigger !== 'tbt:right'), now: () => time, rng: () => 0 });
assert.equal(fallbackEngine.onTrigger({ type: 'tbt', detail: { turn: 'right' }, roadContext: 'highway', at: time })?.roadContext, 'highway', 'context fallback');
const idleEngine = createQuizEngine({ bank: bank.filter(q => q.trigger === 'idle'), now: () => time, rng: () => 0 });
assert.ok(idleEngine.onTrigger({ type: 'practice', at: time }), 'practice falls back to idle');
time += 300_000;
assert.ok(engine.onTrigger({ type: 'idle', at: time }), 'idle after five minutes');
console.log(`PASS bank: ${bank.length} official questions, unique source numbers, four choices, existing sign SVGs`);
console.log('PASS coverage: required triggers and road contexts');
console.log('PASS engine: 60-second gap, duplicate prevention, trigger priority, context fallback, idle');
