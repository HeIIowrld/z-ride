// Classification is deliberately keyword based and ordered: maneuver terms first, then
// driving conditions, enforcement, speed rules, and general questions. Road context uses
// school-zone, highway, then intersection terms; all other questions use `any`.
// Only whitespace is normalized. Source wording and choice order remain untouched.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameDir = path.resolve(here, '../games/license-quiz');
const sourcePath = path.join(gameDir, 'source/koroad_qbank_20261130.txt');
const source = (await readFile(sourcePath, 'utf8')).replace(/^\uFEFF/, '').replace(/\r/g, '');
const signFiles = new Set((await readdir(path.join(gameDir, 'signs'))).map(name => name.match(/^kr_(\d+)\.svg$/)?.[1]).filter(Boolean));
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const seenNumbers = new Set();
const blocks = [...source.matchAll(/^[ \t]*(\d+)\.[ \t]*([\s\S]*?)(?=^[ \t]*\d+\.[ \t]*|^[ \t]*=====PAGE\s+\d+=====|$(?![\s\S]))/gmu)].filter(match => {
  const number = Number(match[1]);
  if (number < 1 || number > 1136 || seenNumbers.has(number)) return false;
  seenNumbers.add(number);
  return true;
});
const bank = [], dropped = Object.create(null), triggerCounts = Object.create(null), contextCounts = Object.create(null), typeCounts = Object.create(null);
let signMatches = 0;
function drop(reason) { dropped[reason] = (dropped[reason] || 0) + 1; }
function classify(question, explanation, sign) {
  // Tags come from the QUESTION text only (explanations mention many unrelated terms).
  // Rain words are whole phrases so that words like "비고", "비상", "정비" never match.
  const q = question;
  const rain = /빗길|빗물|비가\s*(?:오|내리)|비\s*오는|우천|폭우|젖은\s*노면|노면이\s*젖|수막\s*현상|물이\s*고인/u;
  const night = /야간|밤에|전조등|등화|상향등|하향등/u;
  let trigger = 'idle', roadContext = 'any';
  if (/어린이\s*보호구역|스쿨존|어린이통학버스/u.test(q)) { trigger = 'caution:school_zone'; roadContext = 'school_zone'; }
  else if (/과속\s*방지턱/u.test(q)) trigger = 'caution:speed_bump';
  else if (/구간\s*단속/u.test(q)) trigger = 'camera:section';
  else if (/무인\s*(?:교통)?\s*단속|단속\s*(?:카메라|장비)/u.test(q)) trigger = 'camera:fixed';
  else if (rain.test(q)) trigger = 'wiper';
  else if (/미끄러운|결빙|빙판|눈길|블랙\s*아이스/u.test(q)) trigger = 'caution:slippery';
  else if (night.test(q)) trigger = 'night';
  else if (/유턴/u.test(q)) trigger = 'tbt:uturn';
  else if (/우회전/u.test(q) && !/좌회전/u.test(q)) trigger = 'tbt:right';
  else if (/좌회전/u.test(q) && !/우회전/u.test(q)) trigger = 'tbt:left';
  else if (/방향지시등|진로\s*(?:를)?\s*변경|차로\s*(?:를)?\s*변경|진로변경/u.test(q)) trigger = 'turnSignal';
  else if (/제한속도|법정속도|최고속도|최저속도|속도\s*제한/u.test(q)) trigger = 'speedLimit';
  if (roadContext === 'any') {
    if (/고속도로|자동차\s*전용\s*도로|갓길/u.test(q)) roadContext = 'highway';
    else if (/교차로|회전교차로|횡단보도|좌회전|우회전|유턴/u.test(q)) roadContext = 'intersection';
    else if (/주택가|이면도로|골목|보행자\s*우선\s*도로|노인\s*보호구역/u.test(q)) roadContext = 'urban';
  }
  const type = sign !== null ? 'sign' : (rain.test(q) || night.test(q) || /안개|강풍|기상|눈길|빙판/u.test(q)) ? 'weather_time' : /단속|범칙금|과태료|벌점|제한속도/u.test(q) ? 'enforcement' : /상황|경우|때\s/u.test(q) ? 'situation' : 'general';
  return { trigger, roadContext, type };
}
function legalBasisOf(explanation) {
  const m = explanation.match(/(도로교통법\s*시행규칙|도로교통법\s*시행령|도로교통법|교통사고처리\s*특례법|특정범죄\s*가중처벌\s*등에\s*관한\s*법률|자동차관리법|자동차손해배상\s*보장법)\s*(제\s*\d+\s*조(?:의\s*\d+)?|\[?별표\s*\d+\]?)?/u);
  return m ? (m[1].replace(/\s+/g, ' ') + (m[2] ? ' ' + m[2].replace(/\s+/g, '') : '')).trim() : '';
}
for (const match of blocks) {
  const sourceNo = Number(match[1]);
  const body = match[2].replace(/^\s*=====PAGE\s+\d+=====\s*$/gm, '').trim();
  const answerMatch = body.match(/■\s*정답\s*[:：]\s*([^\n]*)/u);
  const explanationMatch = body.match(/■\s*해설\s*[:：]\s*([\s\S]*?)(?=\n\s*\d+\.\s|$)/u);
  const answerNums = answerMatch?.[1].match(/[1-5]/g)?.map(Number) || [];
  const questionEnd = body.search(/\n\s*[①②③④⑤]/u);
  const questionRaw = questionEnd >= 0 ? body.slice(0, questionEnd) : body.split(/\n\s*■\s*(?:정답|해설)/u)[0];
  const question = normalize(questionRaw);
  const rawChoices = body.slice(Math.max(0, questionEnd)).split(/\n\s*■\s*(?:정답|해설)/u)[0];
  const choices = [];
  for (const line of rawChoices.split('\n')) {
    const pieces = line.split(/(?=[①②③④⑤])/u);
    for (const piece of pieces) {
      const choice = normalize(piece.replace(/^\s*[①②③④⑤]\s*/u, ''));
      if (choice) choices.push(choice);
    }
  }
  const explanation = normalize(explanationMatch?.[1] || '');
  if (choices.length !== 4) { drop('choice_count'); continue; }
  if (answerNums.length !== 1 || answerNums[0] > 4) { drop('answer_count'); continue; }
  let sign = null;
  if (/다음\s*안전표지/u.test(question)) {
    const ref = explanation.match(/(?:주의|규제|지시)\s*표지\s*[\(（]?\s*(\d{3})\s*번?/u) || explanation.match(/(\d{3})\s*번/u) || explanation.match(/일련번호\s*(\d{3})/u);
    if (!ref || !signFiles.has(ref[1])) { drop('sign_missing_svg_or_number'); continue; }
    sign = Number(ref[1]); signMatches++;
  } else if (/다음\s*(?:사진|그림|영상|일러스트)|상황에서/u.test(question)) { drop('visual_dependency'); continue; }
  if (!question || !explanation) { drop('missing_text'); continue; }
  const tags = classify(question, explanation, sign);
  const legalBasis = explanation.match(/(?:도로교통법(?:\s*시행령|\s*시행규칙)?\s*제\s*\d+조(?:의\s*\d+)?|도로교통법령\s*제\s*\d+조)/u)?.[0]?.replace(/\s+/gu, ' ').trim() || '';
  const item = { id: `koroad-${sourceNo}`, sourceNo, question, choices, answer: answerNums[0] - 1, explanation, legalBasis, sign, ...tags, reviewStatus: 'official', source: '한국도로교통공단 학과시험 문제은행 (2026.11.30. 시행)' };
  bank.push(item);
  triggerCounts[item.trigger] = (triggerCounts[item.trigger] || 0) + 1;
  contextCounts[item.roadContext] = (contextCounts[item.roadContext] || 0) + 1;
  typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
}
bank.sort((a, b) => a.sourceNo - b.sourceNo);
await writeFile(path.join(gameDir, 'questions.json'), `${JSON.stringify(bank, null, 2)}\n`, 'utf8');
console.log(`total parsed: ${blocks.length}\nkept: ${bank.length}\ndropped: ${JSON.stringify(dropped)}\nsign questions matched SVG: ${signMatches}`);
for (const [label, counts] of [['trigger', triggerCounts], ['roadContext', contextCounts], ['type', typeCounts]]) {
  console.log(`${label}:`);
  for (const [key, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${key}: ${count}`);
}
