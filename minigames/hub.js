import { getSeat, setSeat } from './shared/seat.js';
import { getInventory } from './shared/inventory.js';
import { getBest, getRecords } from './shared/records.js';
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


function drawHubSketch(id,kind){const canvas=document.getElementById(id);if(!canvas)return;const box=canvas.getBoundingClientRect();canvas.width=Math.max(1,box.width*devicePixelRatio);canvas.height=Math.max(1,box.height*devicePixelRatio);const c=canvas.getContext('2d');c.scale(devicePixelRatio,devicePixelRatio);const w=box.width,h=box.height;c.strokeStyle='#171717';c.lineWidth=2;c.lineCap='round';const line=(x,y,X,Y)=>{c.beginPath();c.moveTo(x,y);c.lineTo(X,Y);c.stroke()};if(kind==='pole'){line(w*.49,22,w*.49,h-10);line(w*.52,22,w*.52,h-10);line(w*.3,35,w*.7,35);for(let i=0;i<3;i++)line(w*.49,h-24-i*28,w*.56,h-24-i*28);c.beginPath();c.moveTo(w*.24,56);c.lineTo(w*.3,50);c.lineTo(w*.36,56);c.stroke();line(0,h-19,w,h-19)}else{for(let i=0;i<28;i++){const x=(i*73%997)/997*w,y=22+(i*43%811)/811*(h-42),r=1+i%3;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.stroke()}line(0,h-22,w,h-22);line(0,h-15,w,h-15);c.beginPath();c.moveTo(w*.28,h-25);c.quadraticCurveTo(w*.38,h-39,w*.5,h-25);c.stroke()}}drawHubSketch('hub-pole-art','pole');drawHubSketch('hub-rain-art','rain');

const quizCorrect = getRecords('license-quiz').reduce((sum, record) => sum + (Number(record.stats?.correct) || 0), 0); document.querySelector('#quiz-best').textContent = quizCorrect ? `${quizCorrect}개 정답` : '기록 없음';
