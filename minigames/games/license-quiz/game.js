import { inJourney, returnToJourney } from '../../shared/journey.js';
import { createQuizEngine } from '../../shared/quiz-engine.js';
import { createVehicleFeed } from '../../shared/vehicle.js';
import { ensurePassenger } from '../../shared/passenger.js';
import { addItem, ITEMS } from '../../shared/inventory.js';
import { itemBadge, itemScope, scopeLabel } from '../../shared/item-icons.js';
import { awardMinigame } from '../../shared/loot-client.js';
import { startLootTracking } from '../../shared/loot-tracker.js';
startLootTracking();
import { saveRecord, getRecords } from '../../shared/records.js';
import { SERVER_URL } from '../../shared/config.js';
import { signSvg } from './signs.js';
import { createScenery } from '../../shared/scenery.js';
import { drawWindowFrame } from '../../shared/window-frame.js';

const $ = selector => document.querySelector(selector), params = new URLSearchParams(location.search), dev = params.get('dev') === '1', devAutostart = dev && params.get('autostart') === '1';
window.__layoutCheck=()=>{const box=document.querySelector('.quiz-stage'),els=[...box.querySelectorAll('.quiz-top,.quiz-screen:not(.hidden),.quiz-banner:not(.hidden)')].filter(e=>e.getClientRects().length),hits=[];for(let i=0;i<els.length;i++)for(let j=i+1;j<els.length;j++){const a=els[i].getBoundingClientRect(),b=els[j].getBoundingClientRect();if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)hits.push([els[i].id||els[i].className,els[j].id||els[j].className])}return hits};
const session = params.get('session') || 'default', bank = await fetch('./questions.json').then(r => r.json());
const wrongKey = 'zride.quiz.wrongNote', readWrong = () => { try { const x=JSON.parse(localStorage.getItem(wrongKey)||'[]');return Array.isArray(x)?x:[]; } catch { return []; } }, writeWrong = ids => { try { localStorage.setItem(wrongKey,JSON.stringify(ids)); } catch { /* Storage is optional. */ } };
const engine = createQuizEngine({ bank });
let phase='waiting', score=0, current=null, shownAt=0, timer=null, bannerTimer=null, lastActivity=Date.now(), speedStillSince=null, distanceM=0, startedAt=Date.now(), reviewList=[], reviewIndex=0, reviewMode=false, items={}, responseTimes=[], roadContext='urban', roadOverride='auto', flareAwarded=false;
function classifyRoad(value={}) { if(roadOverride!=='auto')return roadContext=roadOverride; const v=value.feed||value; if(['highway','intersection','school_zone','urban'].includes(v.roadType))roadContext=v.roadType; else if(Number(v.speedLimitKmh)>=100)roadContext='highway'; else if(v.tbt&&Number(v.tbtDistanceM)<300)roadContext='intersection'; else if(v.caution?.kind==='school_zone'||v.caution==='school_zone')roadContext='school_zone'; else roadContext='urban'; return roadContext; }
const typeItem = { general:'supply', sign:'ammo', situation:'medkit', weather_time:'coolant', enforcement:'supply' };
const typeLabel = { sign: '교통 표지', situation: '도로 상황', weather_time: '날씨·시간대', enforcement: '교통 단속' };
function state() { return { phase, score, asked:engine.summary().asked, correct:engine.summary().correct, combo:engine.summary().combo, currentQuestionId:current?.id||null, wrongNote:readWrong(), lastAskedAt:engine.lastAskedAt }; }
function drawQuizScenery(){const canvas=$('#quiz-scenery'),box=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),w=box.width,h=box.height;if(!w||!h)return;canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d'),scene=createScenery({seed:137});scene.update(roadContext==='highway'?160:230,40);c.setTransform(dpr,0,0,dpr,0,0);scene.draw(c,0,0,w,h*.84,{sharp:true});drawWindowFrame(c,w,h,{glassBottom:h*.84});}
function setPhase(value) { phase=value; for(const id of ['waiting','banner','question','result','report','review']) $(`#${id}`).classList.toggle('hidden',id!==value); if(value==='question'){const chip=document.querySelector('#road-context');if(chip)chip.textContent=({highway:'고속도로 주행 중',intersection:'교차로 접근 중',school_zone:'어린이보호구역 주행 중',urban:'일반 도로 주행 중',any:'모든 도로 상황'})[current?.roadContext||roadContext]||'일반 도로 주행 중';drawQuizScenery();} }
if(!document.querySelector('#road-context')){const chip=document.createElement('div');chip.id='road-context';chip.className='road-context';chip.textContent='일반 도로 주행 중';$('#question').prepend(chip);}
function updateHud(){const s=engine.summary();$('#score').textContent=score;$('#correct').textContent=s.correct;$('#combo').textContent=s.combo;$('#review-button').disabled=!(speedStillSince&&Date.now()-speedStillSince>=5000&&readWrong().length);}
function trigger(type, detail={}, ignoreGap=dev&&$('#ignore-gap')?.checked) {
  if (phase !== 'waiting') return null;
  const event={type,detail,roadContext:classifyRoad(detail),at:Date.now()};lastActivity=event.at;
  if(SERVER_URL){fetch(`${SERVER_URL}/api/trigger?session=${encodeURIComponent(session)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...event,ignoreGap:!!ignoreGap})}).then(r=>r.json()).then(data=>{const q=bank.find(item=>item.id===data.questionId);if(q)showQuestion(q);}).catch(()=>{});return null;}
  const q=engine.onTrigger(event,{ignoreGap});if(q)showQuestion(q);return q;
}
function showQuestion(q){if(phase!=='waiting')return;current=q;shownAt=Date.now();reviewMode=false;$('#banner-text').textContent=q.trigger.startsWith('caution:')?'방금 지나간 표지판, 무슨 뜻일까?':q.trigger==='idle'?'운전면허 일반 문제':'지금 상황에서 지켜야 할 법규는?';$('#sign').replaceChildren();if(q.sign!==null){const img=document.createElement('img');img.src=`./signs/kr_${q.sign}.svg`;img.alt=`\uC548\uC804\uD45C\uC9C0 ${q.sign}\uBC88`;img.onerror=()=>{$('#sign').innerHTML=signSvg(q.sign);};$('#sign').append(img);}$('#question-text').textContent=q.question;const choices=q.choices.map((text,index)=>({text,index}));for(let i=choices.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[choices[i],choices[j]]=[choices[j],choices[i]];}$('#choices').replaceChildren(...choices.map(choice=>{const button=document.createElement('button');button.textContent=choice.text;button.onclick=()=>answer(choice.index);return button;}));setPhase('banner');navigator.vibrate?.(80);let left=20;$('#time-left').textContent=left;$('#banner-progress').style.transform='scaleX(1)';clearInterval(timer);clearTimeout(bannerTimer);const deadline=Date.now()+20000;timer=setInterval(()=>{left=Math.max(0,Math.ceil((deadline-Date.now())/1000));$('#time-left').textContent=left;$('#banner-progress').style.transform=`scaleX(${Math.max(0,(deadline-Date.now())/20000)})`;if(!left)answer(-1);},200);bannerTimer=setTimeout(()=>{if(phase==='banner')setPhase('question');},5000);}
function answer(index){if(!current||!['banner','question'].includes(phase))return;clearInterval(timer);clearTimeout(bannerTimer);const elapsed=Date.now()-shownAt, result=engine.answer(current.id,index,elapsed), wasCorrect=index===current.answer;if(wasCorrect){score+=result.score;const id=typeItem[current.type];items[id]=(items[id]||0)+1;addItem(id,1,{gameId:'license-quiz',questionId:current.id});if(result.combo>=5&&!flareAwarded){flareAwarded=true;addItem('flare',1,{gameId:'license-quiz',milestone:5});}}else{const ids=readWrong();if(!ids.includes(current.id))ids.push(current.id);writeWrong(ids);}$('#result-label').textContent=wasCorrect?'정답':'오답';$('#result-title').textContent=wasCorrect?`+${result.score}점`:'다음에는 맞혀봐요';$('#explanation').textContent=current.explanation;let sourceNote=$('#source-note');if(!sourceNote){sourceNote=document.createElement('small');sourceNote.id='source-note';$('#explanation').after(sourceNote);}sourceNote.textContent='\uCD9C\uCC98: \uD55C\uAD6D\uB3C4\uB85C\uAD50\uD1B5\uACF5\uB2E8 \uD559\uACFC\uC2DC\uD5D8 \uBB38\uC81C\uC740';$('#legal').textContent=`근거: ${current.legalBasis}`;const reward = $('#reward');
if (wasCorrect) {
  const item = ITEMS[typeItem[current.type]];
  reward.replaceChildren(itemBadge(item), `${item.name} · ${scopeLabel(itemScope(item))}`);
} else reward.textContent = '오답노트에 저장했어요';
current=null;setPhase('result');updateHud();}
const idName = id => ITEMS[id]?.name ?? id;
function endDrive() {
  clearInterval(timer);
  clearTimeout(bannerTimer);
  const summary = engine.summary();
  const rates = Object.entries(summary.byType).flatMap(([type, stats]) => typeLabel[type] ? [
    [typeLabel[type], `${stats.correct}/${stats.asked} (${Math.round(stats.accuracy * 100)}%)`],
  ] : []);
  const rows = [
    [`출제 ${summary.asked}문제 · 정답 ${summary.correct}문제`, score + '점'],
    ...rates,
    ['최고 콤보', summary.maxCombo],
    ['평균 응답 시간', Math.round(summary.avgResponseMs / 1000) + '초'],
    ['보급품', Object.entries(items).map(([id, count]) => `${idName(id)} ${count}`).join(' · ') || '없음'],
    ['오답노트', readWrong().length + '문제'],
  ];
  const report = $('#report-content');
  report.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'quiz-report-row';
    const stat = document.createElement('strong');
    stat.textContent = value;
    row.append(label, stat);
    return row;
  }));
  saveRecord({ gameId: 'license-quiz', score, durationMs: Date.now() - startedAt, distanceM,
    stats: { asked: summary.asked, correct: summary.correct, byType: summary.byType,
      maxCombo: summary.maxCombo, avgResponseMs: summary.avgResponseMs, wrongIds: summary.wrongIds, items: { ...items } },
    endReason: 'drive_end' });
  setPhase('report');
  awardMinigame('license-quiz', { score, correctByType: summary.byType }).then(out => {
    const line = document.createElement('p');
    line.textContent = `추가 획득 아이템: ${(out.items || []).map(item => item.name).join(', ') || '없음'}`;
    report.append(line);
  });
}
function showReview(){reviewList=readWrong().map(id=>bank.find(q=>q.id===id)).filter(Boolean);reviewIndex=0;if(!reviewList.length)return;setPhase('review');renderReview();}
function renderReview(){const q=reviewList[reviewIndex];if(!q){setPhase('waiting');updateHud();return;}$('#review-question').textContent=q.question;$('#review-choices').replaceChildren(...q.choices.map((text,index)=>{const button=document.createElement('button');button.textContent=text;button.onclick=()=>{if(index===q.answer){score+=5;const ids=readWrong().filter(id=>id!==q.id);writeWrong(ids);reviewList=reviewList.filter(item=>item.id!==q.id);$('#review-question').textContent='정답입니다. 복습 보너스 +5점';}else $('#review-question').textContent=`다시 생각해 보세요. ${q.explanation}`;setTimeout(()=>{reviewIndex++;renderReview();updateHud();},900);};return button;}));}
$('#banner').onclick=()=>{if(phase==='banner'){clearTimeout(bannerTimer);setPhase('question');}};$('#banner').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#banner').click();}};$('#continue-button').onclick=()=>{current=null;setPhase('waiting');updateHud();};$('#end-button').onclick=endDrive;$('#report-close').onclick=()=>{if(inJourney)returnToJourney();else location.href='../../index.html';};$('#review-button').onclick=showReview;$('#review-close').onclick=()=>{setPhase('waiting');updateHud();};
const feed=createVehicleFeed({dev,session});if(!SERVER_URL)feed.on('trigger',event=>trigger(event.type,event.detail,false));else feed.on('question',message=>{const q=bank.find(item=>item.id===message.questionId);if(q)showQuestion(q);});feed.on('update',value=>{classifyRoad(value);distanceM+=value.distanceDeltaM||0;if(value.speedKmh<3){speedStillSince??=Date.now();}else speedStillSince=null;updateHud();});
setInterval(()=>{const now=Date.now();if(now-lastActivity>=300000){trigger('idle',{},false);}if(new Date().getHours()>=19||new Date().getHours()<6){if(!window.__nightSent){window.__nightSent=true;trigger('night',{},false);}}updateHud();},1000);
if(dev){const panel=document.querySelector('.vehicle-dev');if(panel){const controls=document.createElement('div');controls.className='quiz-dev';controls.innerHTML='<label><input id="ignore-gap" type="checkbox" checked> 출제 간격 무시</label><label>도로 상황 <select id="road-context-select"><option value="auto">자동</option><option value="highway">고속도로</option><option value="intersection">교차로</option><option value="school_zone">어린이보호구역</option><option value="urban">일반 도로</option></select></label><div class="quiz-dev-buttons"></div>';panel.append(controls);controls.querySelector('#road-context-select').onchange=e=>{roadOverride=e.target.value;if(roadOverride!=='auto')roadContext=roadOverride;};const defs=[['우회전 안내','tbt',{turn:'right'}],['좌회전 안내','tbt',{turn:'left'}],['과속방지턱 통과','caution',{kind:'speed_bump'}],['어린이보호구역 통과','caution',{kind:'school_zone'}],['와이퍼 켜짐','wiper',{on:true,level:1}],['단속카메라','camera',{kind:'fixed'}],['구간단속','camera',{kind:'section'}],['방향지시등','turnSignal',{side:'right'}],['야간','night',{}]];const box=controls.querySelector('.quiz-dev-buttons');for(const [label,type,detail] of defs){const button=document.createElement('button');button.textContent=label;button.onclick=()=>trigger(type,detail);box.append(button);}}}
if (inJourney) {
  $('#report-close').textContent = '여행 지도로 돌아가기';
  $('#end-button').className = 'secondary-button';
  $('#end-button').textContent = '성적표 보기';
  const practice = document.createElement('button');
  practice.className = 'primary-button';
  practice.textContent = '일반 문제 풀기';
  practice.onclick = () => trigger('practice');
  $('#waiting .quiz-actions').before(practice);
}
window.__licenseQuiz={getState:state,trigger:(type,detail)=>trigger(type,detail)};
if(new Date().getHours()>=19||new Date().getHours()<6){window.__nightSent=true;trigger('night',{},false);}if(!devAutostart)await ensurePassenger();updateHud();if(devAutostart)trigger('practice',{},true);
$('#choices').addEventListener('click',event=>{const button=event.target.closest('button');if(!button||!current)return;button.classList.add('choice-pressed');$('#choices').querySelectorAll('button').forEach(choice=>{const choiceIndex=current.choices.indexOf(choice.textContent);if(choiceIndex===current.answer)choice.classList.add('choice-correct');else if(choice===button)choice.classList.add('choice-wrong');choice.disabled=true;});},{capture:true});
