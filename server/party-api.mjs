import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createAuthProviders } from './auth-providers.mjs';
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const digest=s=>createHash('sha256').update(s).digest();
export function createPartyApi(ctx) {
  const invites=new Map();
  const providers=ctx.authProviders??createAuthProviders({googleClientId:ctx.googleClientId,publicOrigin:ctx.publicOrigin});
  function authorizeReview(req) {
    const value=req.headers.authorization?.slice(7);
    if (!ctx.reviewToken || !req.headers.authorization?.startsWith('Bearer ') || !value || !timingSafeEqual(digest(value),digest(ctx.reviewToken))) throw fail('REVIEW_AUTH_REQUIRED','Separate place reviewer token required',401);
  }
  function previewInvite(inviteToken) {
    if(typeof inviteToken!=='string'||inviteToken.length>128)throw fail('INVITE_REQUIRED','QR invitation required');
    const invite=invites.get(digest(inviteToken).toString('hex'));
    if(!invite||invite.expiresAt<=Date.now()||invite.used>=3)throw fail('INVITE_EXPIRED','Ask car for a fresh QR',409);
    const room=ctx.roomFor(invite.roomId);if(room.closedAt)throw fail('INVITE_EXPIRED','Party closed',409);
    return {partyId:room.roomId,partyName:ctx.places.partyName(room.roomId),expiresAt:invite.expiresAt,requiresHostApproval:true,joinable:room.members.size<4,availableSeats:['FRONT_PASSENGER','REAR_LEFT','REAR_RIGHT'].filter(seat=>![...room.members.values()].some(m=>m.seat===seat))};
  }
  function publicRequest(req,path,body) {
    if (path==='/api/auth/providers' && req.method==='GET') return {status:200,data:providers.describe()};
    if (path==='/api/admin/places/review' && req.method==='POST') { authorizeReview(req); const result=ctx.places.review(body); ctx.notify(); return {status:200,data:result}; }
    if (path!=='/api/invites/redeem' || req.method!=='POST') return null;
    if (typeof body.inviteToken!=='string' || body.inviteToken.length>128) throw fail('INVITE_REQUIRED','QR invitation required');
    previewInvite(body.inviteToken);
    const invite=invites.get(digest(body.inviteToken).toString('hex'));
    if (!invite || invite.expiresAt<=Date.now()) throw fail('INVITE_EXPIRED','Ask car for a fresh QR',409);
    const room=ctx.roomFor(invite.roomId);
    if (room.closedAt || invite.used>=3) throw fail('INVITE_EXPIRED','Invitation closed',409);
    if (!ctx.passengerSeat(body.seat) || typeof body.nickname!=='string' || body.nickname.trim().length<1 || body.nickname.length>24 || body.passengerConfirmed!==true) throw fail('INVALID_JOIN','Nickname, passenger confirmation and seat required');
    if (room.members.size>=4) throw fail('ROOM_FULL','Host plus 3 phones maximum',409);
    if (ctx.sessions.size>=500) throw fail('SESSION_LIMIT','Session capacity reached',503);
    const credential=randomBytes(24).toString('base64url');
    const session={sessionId:randomUUID(),role:'PHONE',nickname:body.nickname.trim(),expiresAt:Date.now()+8*3600000,roomId:room.roomId};
    const member={memberId:randomUUID(),sessionId:session.sessionId,nickname:session.nickname,role:body.seat,seat:body.seat,approved:false,socket:null,receipts:new Map(),collectedPickups:new Set()};
    ctx.sessions.set(digest(credential).toString('hex'),session);room.members.set(session.sessionId,member);invite.used++;ctx.change(room);
    return {status:201,data:{token:credential,sessionId:session.sessionId,expiresAt:session.expiresAt,roomId:room.roomId,memberId:member.memberId,pending:true,room:ctx.snapshot(room,member)}};
  }
  function handle(req,path,body,session) {
    if (path==='/api/places/catalog' && req.method==='GET') return {status:200,data:ctx.places.status()};
    if (path==='/api/places/nearby' && req.method==='POST') { ctx.memberFor(ctx.roomFor(session.roomId),session);return {status:200,data:ctx.places.nearby(body)}; }
    const shared=path.match(/^\/api\/spots\/([^/]+)\/shared$/);
    if (shared && req.method==='GET') { ctx.memberFor(ctx.roomFor(session.roomId),session);return {status:200,data:ctx.places.shared(shared[1],ctx.rooms.values())}; }
    const match=path.match(/^\/api\/rooms\/([^/]+)\/(route(?:\/spots)?|party(?:\/(?:invite|leave|remove|disband|contribute|events\/join))?|results|rewards(?:\/claim)?)$/);
    if (!match) return null;
    const room=ctx.roomFor(match[1]), action=match[2], member=ctx.memberFor(room,session,action!=='party/leave');
    const query=new URL(req.url,'http://localhost').searchParams,paging={offset:Number(query.get('offset')??0),limit:Number(query.get('limit')??50)};
    if(req.method==='GET'&&action==='results')return {status:200,data:ctx.places.events.results(room,paging)};
    if(req.method==='GET'&&action==='rewards')return {status:200,data:ctx.places.events.rewards(room,paging)};
    if (req.method==='GET' && action==='route') return {status:200,data:ctx.places.routeInfo(room.roomId)};
    if (req.method!=='POST') throw fail('METHOD_NOT_ALLOWED','Use documented method',405);
    if (action==='route/spots') return {status:200,data:ctx.places.routeSpots(room.roomId,body)};
    if (action==='party/leave') {
      if (member.role==='CAR_HOST') throw fail('HOST_MUST_DISBAND','Host must explicitly disband',409);
      ctx.accounts?.depart(member,'LEFT');room.departedMembers??=new Map();room.departedMembers.set(session.sessionId,member);room.members.delete(session.sessionId);session.roomId=null;
      if (member.socket) ctx.closeSocket(member.socket,4410,'Left party');member.socket=null;
      ctx.pause(room,'MEMBER_LEFT');ctx.change(room);return {status:200,data:{partyId:room.roomId,status:'LEFT'}};
    }
    ctx.requireHost(room,session);
    if (action==='party/remove') {
      const target=[...room.members.values()].find(m=>m.memberId===body.memberId);
      if (!target || target.role==='CAR_HOST') throw fail('INVALID_MEMBER','Select a phone member',409);
      for (const [key,invite] of invites) if(invite.roomId===room.roomId)invites.delete(key);
      ctx.accounts?.depart(target,'REMOVED');room.departedMembers??=new Map();room.departedMembers.set(target.sessionId,target);room.members.delete(target.sessionId);
      const s=[...ctx.sessions.values()].find(s=>s.sessionId===target.sessionId);if(s)s.roomId=null;
      if(target.socket)ctx.closeSocket(target.socket,4410,'Removed from party');target.socket=null;
      ctx.pause(room,'MEMBER_REMOVED');ctx.change(room);return {status:200,data:{partyId:room.roomId,status:'REMOVED',memberId:target.memberId}};
    }
    if (action==='route') { const data=ctx.places.setRoute(room.roomId,body);return {status:200,data}; }
    if (action==='party') { const data=ctx.places.setParty(room.roomId,body);ctx.change(room);return {status:200,data}; }
    if(action==='party/events/join'){const data=ctx.places.joinEvent(room,body);ctx.change(room);ctx.notify();return {status:200,data};}
    if(action==='rewards/claim'){const data=ctx.places.events.claim(room,body);if(!data.replayed)ctx.collectionChanged(room);return {status:200,data};}
    if (action==='party/contribute') { const data=ctx.places.contribute(room,body,ctx.gate(room).allowed);if(!data.replayed)ctx.eventChanged(data.instance.instanceId);return {status:200,data}; }
    if (action==='party/invite') {
      if (!ctx.publicOrigin) throw fail('PUBLIC_ORIGIN_REQUIRED','Configure the trusted public origin',503);
      for (const [id,old] of invites) if (old.roomId===room.roomId || old.expiresAt<=Date.now()) invites.delete(id);
      const inviteToken=randomBytes(24).toString('base64url'),expiresAt=Date.now()+120000;
      invites.set(digest(inviteToken).toString('hex'),{roomId:room.roomId,expiresAt,used:0});
      return {status:201,data:{partyId:room.roomId,joinUrl:(ctx.phonePublicUrl||ctx.publicOrigin+'/play')+'#invite='+inviteToken,expiresAt,maxUses:3,requiresHostApproval:true,qrPayloadType:'URL'}};
    }
    if (action==='party/disband') {
      ctx.pause(room,'PARTY_DISBANDED');room.closedAt=Date.now();room.joinUsed=true;room.joinExpiresAt=0;ctx.joinCodes.delete(room.joinCode);
      room.vehicle.hostConnected=false;room.vehicle.receivedAt=0;room.vehicle.foreground=false;
      ctx.places.closeParty(room.roomId);for(const [key,invite] of invites)if(invite.roomId===room.roomId)invites.delete(key);
      for(const m of room.members.values()) {ctx.accounts?.depart(m,'CLOSED');const s=[...ctx.sessions.values()].find(s=>s.sessionId===m.sessionId);if(s)s.roomId=null;if(m.socket)ctx.closeSocket(m.socket,4410,'Party disbanded');m.socket=null;}
      ctx.change(room);return {status:200,data:{partyId:room.roomId,status:'DISBANDED'}};
    }
    throw fail('NOT_FOUND','Party operation not found',404);
  }
  return {publicRequest,handle,previewInvite};
}
