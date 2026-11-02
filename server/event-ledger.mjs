import {createHash, randomUUID} from 'node:crypto';

const clone = value => structuredClone(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), {code, status});
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const keyOf = room => `${room.roomId}:${room.game.missionRunId}`;

/** Durable logical results and demo rewards. The enclosing server commits before publishing. */
export function createEventLedger({clock = Date.now, durationMs = 1800000, respawnMs = 300000,
  target = 3, missionReward = 1, sharedReward = 2, capacity = 10000} = {}) {
  for (const [value, min, max] of [[durationMs,1000,86400000],[respawnMs,1000,86400000],
    [target,1,100],[missionReward,0,100],[sharedReward,0,100],[capacity,1,100000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid event policy');
  }
  let state = {version:1, revision:0, instances:{}, current:{}, runs:{}, results:{}, awards:{}, bindings:{}, receipts:{}};
  const policy = () => ({durationMs,respawnMs,target,missionReward,sharedReward,rewardResource:'supplies',rewardKind:'DEMO_GAME_RESOURCE_NOT_MONEY'});
  const roomKey = (room, id) => `${room.roomId}:${id}`;
  function receipt(room, operation, body) {
    if (!body || typeof body.commandId !== 'string' || !body.commandId.length || body.commandId.length > 128) throw fail('COMMAND_ID_REQUIRED','commandId required',400);
    const id=roomKey(room,body.commandId), fingerprint=createHash('sha256').update(JSON.stringify(canonical({operation,body}))).digest('hex');
    const old=state.receipts[id];
    if (old && old.fingerprint!==fingerprint) throw fail('IDEMPOTENCY_CONFLICT','Command changed');
    if (!old && Object.keys(state.receipts).length>=capacity) throw fail('EVENT_CAPACITY','Event receipt capacity reached',429);
    return {old:old ? {...clone(old.response),replayed:true} : null, save:response=>{state.receipts[id]={fingerprint,response:clone(response)};return response;}};
  }
  function create(spotId, cycle = 1) {
    if (Object.keys(state.instances).length>=capacity) throw fail('EVENT_CAPACITY','Event archive capacity reached',429);
    const at=clock(), instance={instanceId:randomUUID(),spotId,eventType:'COMMUNITY_MISSIONS',contentVersion:'community-v1',
      cycle,revision:0,phase:'ACTIVE',outcome:null,startedAt:at,expiresAt:at+durationMs,endedAt:null,respawnAt:null,
      completed:false,target,contributions:[],rewardPolicy:{missionSupplies:missionReward,sharedSupplies:sharedReward}};
    state.instances[instance.instanceId]=instance;state.current[spotId]=instance.instanceId;state.revision++;return instance;
  }
  const current = spotId => clone(state.instances[state.current[spotId]] ?? null);
  function live(instance) {return instance?.phase==='ACTIVE' && clock()<instance.expiresAt;}
  function binding(room) {return state.bindings[keyOf(room)] ?? null;}
  function assertPlayable(room) {
    const b=binding(room);if(b&&!live(state.instances[b.instanceId]))throw fail('EVENT_NOT_ACTIVE','Configure a new mission and join the current event');
  }
  function award(id, partyId, source, amount) {
    if (amount && !state.awards[id]) state.awards[id]={awardId:id,partyId,...source,resource:'supplies',amount,status:'PENDING',createdAt:clock(),claimedAt:null};
  }
  function finish(run, outcome, room) {
    if(state.results[run.runKey])return false;
    const result={resultId:randomUUID(),runKey:run.runKey,partyId:run.partyId,missionRunId:run.missionRunId,
      scenarioId:run.scenarioId,instanceId:state.bindings[run.runKey]?.instanceId??null,outcome,startedAt:run.startedAt,
      endedAt:clock(),participants:clone(run.participants),stageHistory:clone(run.stageHistory),contributions:clone(run.contributions),
      summary:room?{kills:room.stats?.kills??0,waveCleared:room.stats?.waveCleared===true,virtualDistanceM:room.game?.distanceM??0}:clone(run.summary??{kills:0,waveCleared:false,virtualDistanceM:0})};
    state.results[run.runKey]=result;run.status=outcome;
    if(outcome==='SUCCEEDED')award('mission:'+run.runKey,run.partyId,{kind:'MISSION_CLEAR',resultId:result.resultId,instanceId:result.instanceId},run.rewardSupplies??0);
    state.revision++;return true;
  }
  function observe(room, {legacy=false}={}) {
    const id=keyOf(room);let changed=false;
    for(const run of Object.values(state.runs))if(run.partyId===room.roomId&&run.runKey!==id&&run.status==='ACTIVE')changed=finish(run,'CANCELLED')||changed;
    if(room.game.scenarioId==='generic-coop-v1')return changed;
    let run=state.runs[id];
    if(!run){
      if(Object.keys(state.runs).length>=capacity)throw fail('EVENT_CAPACITY','Mission result capacity reached',429);
      run=state.runs[id]={runKey:id,partyId:room.roomId,missionRunId:room.game.missionRunId,scenarioId:room.game.scenarioId,
        startedAt:clock(),rewardSupplies:legacy&&room.game.completed?0:missionReward,status:'ACTIVE',participants:[],stageHistory:[],contributions:[]};changed=true;
    }
    if(run.status!=='ACTIVE')return changed;
    run.summary={kills:room.stats?.kills??0,waveCleared:room.stats?.waveCleared===true,virtualDistanceM:room.game.distanceM??0};
    for(const m of room.members.values())if(m.approved&&!run.participants.some(p=>p.memberId===m.memberId))run.participants.push({memberId:m.memberId,role:m.role,seat:m.seat});
    if(!run.stageHistory.some(s=>s.stageId===room.game.stageId)){run.stageHistory.push({stageId:room.game.stageId,at:clock()});changed=true;}
    for(const memberId of room.game.interactions)if(!run.contributions.some(c=>c.memberId===memberId&&c.stageId===room.game.stageId)){
      run.contributions.push({memberId,stageId:room.game.stageId,objectiveId:room.game.objectiveState.objectiveId,at:clock()});changed=true;
    }
    const b=binding(room),instance=b&&state.instances[b.instanceId];
    if(b&&!live(instance)&&!room.game.completed)changed=finish(run,instance?.outcome==='EXPIRED'?'EXPIRED':'CANCELLED',room)||changed;
    else if(room.game.completed){const b=binding(room);changed=finish(run,b&&!live(state.instances[b.instanceId])?'EXPIRED':'SUCCEEDED',room)||changed;}
    else if(room.closedAt)changed=finish(run,'CANCELLED',room)||changed;
    if(changed)state.revision++;return changed;
  }
  function join(room, body) {
    const r=receipt(room,'join',body);if(r.old)return r.old;
    if(room.game.scenarioId==='generic-coop-v1'||room.game.completed||room.game.stageIndex!==0||room.state==='PLAYING')throw fail('EVENT_MISSION_REQUIRED','Configure a finite mission and join before starting');
    const existing=state.instances[state.current[body.spotId]];
    if(body.expectedInstanceId!==(existing?.instanceId??null))throw fail('EVENT_INSTANCE_CONFLICT','Refresh shared event instance');
    if(existing&&!live(existing))throw fail('EVENT_NOT_ACTIVE','Wait for the next event cycle');
    if(existing?.contributions.some(c=>c.partyId===room.roomId))throw fail('ALREADY_CONTRIBUTED','This party already contributed to this event');
    const old=binding(room);if(old)throw fail('MISSION_ALREADY_BOUND','This mission already joined an event');
    if(!state.runs[keyOf(room)]&&Object.keys(state.runs).length>=capacity)throw fail('EVENT_CAPACITY','Mission capacity reached',429);
    const instance=existing??create(body.spotId);observe(room);
    state.bindings[keyOf(room)]={instanceId:instance.instanceId,spotId:body.spotId,joinedAt:clock()};state.revision++;
    return r.save({instance:clone(instance),missionRunId:room.game.missionRunId,replayed:false});
  }
  function contribute(room, body, gateAllowed) {
    const r=receipt(room,'contribute',body);if(r.old)return r.old;
    const instance=state.instances[body.instanceId],b=binding(room),result=state.results[keyOf(room)];
    if(!instance||state.current[body.spotId]!==body.instanceId||instance.spotId!==body.spotId)throw fail('EVENT_INSTANCE_CONFLICT','Current instanceId required');
    if(!gateAllowed||room.state!=='CLEARED'||!result||result.outcome!=='SUCCEEDED'||b?.instanceId!==instance.instanceId)throw fail('CONTRIBUTION_NOT_READY','Joined mission must have a server-recorded successful result and parked gate');
    if(!live(instance))throw fail('EVENT_NOT_ACTIVE','Event is closed');
    if(instance.contributions.some(c=>c.partyId===room.roomId))throw fail('ALREADY_CONTRIBUTED','One contribution per party per event');
    if(body.expectedInstanceRevision!==instance.revision)throw fail('INSTANCE_REVISION_CONFLICT','Refresh event revision');
    instance.contributions.push({partyId:room.roomId,resultId:result.resultId,at:clock()});instance.revision++;
    if(instance.contributions.length>=instance.target){
      instance.completed=true;instance.phase='COOLDOWN';instance.outcome='SUCCEEDED';instance.endedAt=clock();instance.respawnAt=clock()+respawnMs;
      for(const c of instance.contributions)award('event:'+instance.instanceId+':'+c.partyId,c.partyId,{kind:'SHARED_EVENT_CLEAR',instanceId:instance.instanceId},instance.rewardPolicy.sharedSupplies);
    }
    state.revision++;return r.save({instance:clone(instance),eventRevision:state.revision,replayed:false,rewardGranted:false,rewardStatus:instance.completed?'CLAIMABLE':'WAITING_FOR_EVENT_CLEAR'});
  }
  function tick() {
    let changed=false;
    for(const id of Object.values(state.current)){
      const instance=state.instances[id];
      if(instance.phase==='ACTIVE'&&clock()>=instance.expiresAt){
        instance.phase='COOLDOWN';instance.outcome='EXPIRED';instance.endedAt=instance.expiresAt;instance.respawnAt=instance.expiresAt+respawnMs;instance.revision++;state.revision++;changed=true;
        for(const [runKey,b] of Object.entries(state.bindings))if(b.instanceId===id&&state.runs[runKey]?.status==='ACTIVE')finish(state.runs[runKey],'EXPIRED');
      }
      if(instance.phase==='COOLDOWN'&&clock()>=instance.respawnAt&&Object.keys(state.instances).length<capacity){create(instance.spotId,instance.cycle+1);changed=true;}
    }
    return changed;
  }
  function claim(room, body) {
    const r=receipt(room,'reward',body);if(r.old)return r.old;
    const a=state.awards[body.awardId];if(!a||a.partyId!==room.roomId)throw fail('REWARD_NOT_FOUND','Own party reward required',404);
    if(a.status==='CLAIMED')throw fail('REWARD_ALREADY_CLAIMED','This party already received the reward');
    if(!Number.isSafeInteger(room.collection.inventory.supplies+a.amount))throw fail('INVENTORY_LIMIT','Inventory capacity exceeded');
    room.collection.inventory.supplies+=a.amount;a.status='CLAIMED';a.claimedAt=clock();state.revision++;
    return r.save({award:clone(a),inventory:clone(room.collection.inventory),replayed:false,rewardGranted:true});
  }
  function page(items, {offset=0,limit=50}={}) {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('INVALID_PAGE','offset >=0 and limit 1..100 required',400);
    const values=items.slice().reverse();return {items:values.slice(offset,offset+limit).map(clone),offset,nextOffset:offset+limit<values.length?offset+limit:null};
  }
  function results(room, query) {const p=page(Object.values(state.results).filter(r=>r.partyId===room.roomId),query);return {results:p.items,offset:p.offset,nextOffset:p.nextOffset,policy:policy(),eventRevision:state.revision};}
  function rewards(room, query) {const p=page(Object.values(state.awards).filter(a=>a.partyId===room.roomId),query);return {awards:p.items,offset:p.offset,nextOffset:p.nextOffset,eventRevision:state.revision};}
  function restore(saved, legacy = {}) {
    if(saved){if(saved.version!==1)throw new Error('Unknown event ledger format');state=clone(saved);return;}
    for(const old of Object.values(legacy)){
      const at=clock(),instance={...clone(old),cycle:1,eventType:'LEGACY_COMMUNITY',contentVersion:'legacy-v1',phase:old.completed?'COOLDOWN':'ACTIVE',outcome:old.completed?'SUCCEEDED':null,
        startedAt:at,expiresAt:at+durationMs,endedAt:old.completed?at:null,respawnAt:old.completed?at+respawnMs:null,rewardPolicy:{missionSupplies:0,sharedSupplies:0}};
      state.instances[instance.instanceId]=instance;state.current[instance.spotId]=instance.instanceId;
    }
  }
  return {policy,current,join,observe,contribute,claim,results,rewards,tick,assertPlayable,
    due:()=>Object.values(state.current).some(id=>{const i=state.instances[id];return i.phase==='ACTIVE'?clock()>=i.expiresAt:clock()>=i.respawnAt&&Object.keys(state.instances).length<capacity;}),
    projection:room=>({revision:state.revision,missionRunId:room.game.missionRunId,instanceId:binding(room)?.instanceId??null,resultId:state.results[keyOf(room)]?.resultId??null,outcome:state.results[keyOf(room)]?.outcome??null}),
    ensureConfigure:scenarioId=>{if(scenarioId!=='generic-coop-v1'&&Object.keys(state.runs).length>=capacity)throw fail('EVENT_CAPACITY','Mission capacity reached',429);},
    restoreRoom:room=>observe(room,{legacy:true}),
    revision:()=>state.revision,durable:()=>clone(state),restore};
}
