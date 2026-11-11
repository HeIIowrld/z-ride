import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQuizEngine } from '../shared/quiz-engine.js';
const bank = JSON.parse(await readFile(new URL('../games/license-quiz/questions.json', import.meta.url), 'utf8'));
const required = ['id','type','trigger','question','choices','answer','explanation','legalBasis','reviewedAt','reviewStatus'];
assert.equal(bank.length, 40, 'question count must be 40');
for (const q of bank) { for (const key of required) assert.ok(key in q, `${q.id} missing ${key}`); assert.equal(q.choices.length,4); assert.ok(q.answer >= 0 && q.answer < 4); assert.equal(q.reviewStatus,'draft'); }
for (const [trigger,count] of Object.entries(Object.groupBy(bank, q => q.trigger))) assert.ok(count.length >= 5, `${trigger} has fewer than five questions`);
let time = 0; const engine = createQuizEngine({ bank, now: () => time, rng: () => 0 });
const first = engine.onTrigger({ type:'tbt', detail:{turn:'right'}, at:time }); assert.ok(first); assert.equal(engine.onTrigger({ type:'caution', detail:{kind:'speed_bump'}, at:time+1000 }),null,'60 second gap');
time += 60_000; const second = engine.onTrigger({ type:'tbt', detail:{turn:'right'}, at:time }); assert.ok(second); assert.notEqual(first.id, second.id,'no duplicate question');
const priorityEngine = createQuizEngine({ bank, now: () => time, rng: () => 0 }); assert.equal(priorityEngine.onTrigger({ type:'tbt', detail:{turn:'right'}, at:time })?.trigger,'tbt:right');
time += 300_000; const idle = engine.onTrigger({ type:'idle', at:time }); assert.ok(idle, 'idle question after five minutes');
console.log('PASS questions: 40 valid, 4 choices, required fields, 5+ per trigger');
console.log('PASS engine: 60-second gap, duplicate prevention, priority ordering, idle after five minutes');
