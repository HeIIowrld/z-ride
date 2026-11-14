import { getSeat, setSeat } from './shared/seat.js';
import { getInventory } from './shared/inventory.js';
import { getBest, getRecords } from './shared/records.js';
import { createScenery } from './shared/scenery.js';
import { drawWindowFrame } from './shared/window-frame.js';
import { startLootTracking, currentLootRegion } from './shared/loot-tracker.js';
startLootTracking();
const lootLinks=document.createElement('nav');lootLinks.className='loot-nav';lootLinks.innerHTML='<a href="bag.html">가방</a><a href="codex.html">도감</a><a href="vehicle/garage.html?dev=1">차고</a><a href="dev/route-replay.html">경로 재생</a><span id="current-region">위치 대기 중</span>';document.querySelector('.topbar').after(lootLinks);
setInterval(()=>{const node=document.querySelector('#current-region');if(node&&currentLootRegion())node.textContent=`현재 지역: ${currentLootRegion()}`;},1000);
const dialog = document.querySelector('#seat-dialog'), seatLabel = document.querySelector('#seat-label');
function renderSeat() { const seat = getSeat(); seatLabel.textContent = seat === 'right' ? '오른쪽 좌석' : seat === 'left' ? '왼쪽 좌석' : '선택 필요'; }
document.querySelector('#seat-button').addEventListener('click', () => dialog.showModal());
dialog.querySelectorAll('[data-seat]').forEach(button => button.addEventListener('click', () => { setSeat(button.dataset.seat); renderSeat(); }));
renderSeat(); if (!getSeat()) dialog.showModal();
const best = getBest('pole-jump'); document.querySelector('#best-score').textContent = best ? `${best.score.toLocaleString('ko-KR')}점 · ${best.stats?.poles || 0}개 기둥` : '아직 기록이 없어요';
for (const mode of ['real','practice']) { const record=getBest('raindrop',r=>r.stats?.mode===mode); document.querySelector(`#best-${mode}`).textContent=record?`${record.score}점`:'기록 없음'; }
// Inventory is rendered here as a compact total, with item detail available in the title.
const inventory = getInventory(), parts = Number(inventory.part) || 0;
document.querySelector('#inventory-list').textContent = `부품 ${parts} · 냉각수 셀 ${Number(inventory.coolant)||0} · 터렛 ${Number(inventory.turret)||0} · 보급품 ${Number(inventory.supply)||0}`;
document.querySelector('.offline').title = `보유 부품 ${parts}개 · 아이템 ${Object.keys(inventory).length}종`;


function drawHubScene(id,kind){const canvas=document.getElementById(id);if(!canvas)return;const c=canvas.getContext('2d'),scene=createScenery({seed:73}),render=()=>{const box=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),w=box.width,h=box.height,bottom=h*.78;canvas.width=Math.max(1,w*dpr);canvas.height=Math.max(1,h*dpr);c.setTransform(dpr,0,0,dpr,0,0);scene.draw(c,0,0,w,bottom,{sharp:true});if(kind==='pole'){const x=w*.48,top=h*.25,night=scene.timeOfDay==='night';c.fillStyle=night?'#111725':'#172432';c.strokeStyle=night?'#ffc77e':'#e4f3ff';c.lineWidth=2;c.beginPath();c.moveTo(x-5,bottom);c.lineTo(x-2,top);c.lineTo(x+3,top);c.lineTo(x+6,bottom);c.closePath();c.fill();c.stroke();c.fillRect(x-24,top+15,48,4);c.strokeRect(x-24,top+15,48,4);c.fillStyle=night?'#ffbd70':'#172432';c.beginPath();c.arc(x-25,top+31,6,0,Math.PI*2);c.fill();c.fillRect(x-28,top+36,7,15);c.fillRect(x-34,top+39,8,4);c.fillRect(x-27,top+49,4,8);c.fillRect(x-21,top+49,4,8);}else if(kind==='rain'){c.fillStyle='rgba(100,190,255,.18)';c.fillRect(w*.1,h*.12,w*.8,h*.62);for(let i=0;i<6;i++){const x=w*(.2+i*.12),y=h*(.28+(i%3)*.11);c.fillStyle='#d8f2ff';c.beginPath();c.ellipse(x,y,2+i%2,3+i%2,0,0,Math.PI*2);c.fill();}}else{c.fillStyle='#172432';c.fillRect(w*.46,bottom*.25,w*.06,bottom*.65);c.fillStyle='#263e51';c.fillRect(w*.3,bottom*.16,w*.38,bottom*.2);c.strokeStyle='#d8f2ff';c.strokeRect(w*.3,bottom*.16,w*.38,bottom*.2);}drawWindowFrame(c,w,h,{glassBottom:bottom});};render();new ResizeObserver(render).observe(canvas);}drawHubScene('hub-pole-art','pole');drawHubScene('hub-rain-art','rain');drawHubScene('hub-quiz-art','sign');

const quizCorrect = getRecords('license-quiz').reduce((sum, record) => sum + (Number(record.stats?.correct) || 0), 0); document.querySelector('#quiz-best').textContent = quizCorrect ? `${quizCorrect}개 정답` : '기록 없음';
const quizThumb=document.querySelector('.game-card[href*="license-quiz"] .game-art canvas');if(quizThumb){const c=quizThumb.getContext('2d'),r=quizThumb.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),scene=createScenery({seed:81});quizThumb.width=Math.max(1,r.width*dpr);quizThumb.height=Math.max(1,r.height*dpr);c.setTransform(dpr,0,0,dpr,0,0);scene.update(30,0);scene.draw(c,0,0,r.width,r.height*.78,{sharp:true});c.fillStyle='#172432';c.fillRect(r.width*.46,r.height*.36,r.width*.06,r.height*.32);c.fillRect(r.width*.3,r.height*.3,r.width*.38,r.height*.15);c.strokeStyle='#d8f2ff';c.strokeRect(r.width*.3,r.height*.3,r.width*.38,r.height*.15);drawWindowFrame(c,r.width,r.height,{glassBottom:r.height*.78});}
