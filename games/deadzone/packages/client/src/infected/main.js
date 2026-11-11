import * as THREE from 'three';
import { Swarm } from '../render/swarm.js';
import { ENEMY_TYPES } from '@overrun/shared/defs.js';
const renderer=new THREE.WebGLRenderer({canvas:document.getElementById('infected'),antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
const scene=new THREE.Scene();scene.background=new THREE.Color(0x111a14);scene.fog=new THREE.Fog(0x111a14,18,40);
scene.add(new THREE.HemisphereLight(0xd7e8c6,0x364331,2.7));
const key=new THREE.DirectionalLight(0xffdcaf,3);key.position.set(-3,6,7);scene.add(key);
const rim=new THREE.DirectionalLight(0x8eb57a,2.2);rim.position.set(6,3,-4);scene.add(rim);
const camera=new THREE.PerspectiveCamera(35,1,.1,100);
const swarm=new Swarm({scene});
const types=['rusher','stalker','bruiser','spitter'];
const list=types.map((key,i)=>({key,eid:i,x:(i-1.5)*3.15,z:0,r:ENEMY_TYPES[key].r,vx:3,vz:0,faceA:Math.PI/2,hpFrac:1}));
for(let i=0;i<4;i++){
 const base=new THREE.Mesh(new THREE.CylinderGeometry(1.25,1.35,.2,32),new THREE.MeshStandardMaterial({color:0x29392a,roughness:.9}));base.position.set((i-1.5)*3.15,-.16,0);scene.add(base);
}
function resize(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.position.set(0,4.1,Math.max(13.8,13.8/(camera.aspect/1.6)));camera.lookAt(0,1.1,0);camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();let last=performance.now();
function frame(now){const dt=Math.min(.05,(now-last)/1000);last=now;swarm.update(list,dt,1,null);renderer.render(scene,camera);requestAnimationFrame(frame);}requestAnimationFrame(frame);
