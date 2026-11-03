import {createHash, randomBytes, randomUUID} from 'node:crypto';
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});

/** Phone account APIs delegate game access to existing approved room memberships. */
export function createAccountApi(ctx){
  const {accounts}=ctx;
  const token=req=>req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):undefined;
  function detach(room,member,status){
    room.departedMembers??=new Map();room.departedMembers.set(member.sessionId,member);room.members.delete(member.sessionId);
    for(const [key,s]of ctx.sessions)if(s.sessionId===member.sessionId)ctx.sessions.delete(key);
    if(member.socket)ctx.closeSocket(member.socket,4410,status);member.socket=null;
    accounts.depart(member,status);ctx.pause(room,status);ctx.change(room);
  }
  function approve(room,member){
    const plan=accounts.approval(room,member);if(!plan)return;
    if(plan.old){const oldRoom=ctx.rooms.get(plan.old.partyId),oldMember=oldRoom&&[...oldRoom.members.values()].find(m=>m.memberId===plan.old.memberId);
      if(oldMember)detach(oldRoom,oldMember,'SWITCHED');
    }
    accounts.activate(plan);
  }
  function gameTicket(user){
    const membership=accounts.active(user);if(!membership)throw fail('NO_ACTIVE_PARTY','Join a vehicle party first');
    const room=ctx.roomFor(membership.partyId),member=[...room.members.values()].find(m=>m.memberId===membership.memberId&&m.accountUserId===user.userId);
    if(room.closedAt||!member?.approved)throw fail('NO_ACTIVE_PARTY','No approved party membership');
    if(ctx.sessions.size-[...ctx.sessions.values()].filter(s=>s.sessionId===member.sessionId).length>=500)throw fail('SESSION_LIMIT','Session capacity reached',503);
    const oldSessionId=member.sessionId;
    for(const [key,s]of ctx.sessions)if(s.sessionId===oldSessionId)ctx.sessions.delete(key);
    room.members.delete(oldSessionId);if(member.socket)ctx.closeSocket(member.socket,4412,'Replaced by account resume');member.socket=null;
    const credential=randomBytes(24).toString('base64url'),sessionId=randomUUID(),expiresAt=Date.now()+28800000;
    member.sessionId=sessionId;room.members.set(sessionId,member);
    ctx.sessions.set(createHash('sha256').update(credential).digest('hex'),{sessionId,role:'PHONE',nickname:member.nickname,expiresAt,roomId:room.roomId,accountUserId:user.userId});
    ctx.pause(room,'PHONE_SESSION_REPLACED');ctx.change(room);
    return {token:credential,tokenPurpose:'PARTY_PLAY',expiresAt,roomId:room.roomId,memberId:member.memberId,pending:false,sessionId,room:ctx.snapshot(room,member)};
  }
  function requireGoogleTransport(req){if((ctx.accountTlsRequired||accounts.describe().google.enabled)&&!ctx.isSecure(req))throw fail('AUTH_HTTPS_REQUIRED','Phone accounts require HTTPS through a trusted TLS proxy',403);}
  function handle(req,path,body){
    if(path.startsWith('/api/accounts/')||path.startsWith('/api/me')||path==='/api/auth/google/challenge'||path==='/api/invites/preview'){requireGoogleTransport(req);accounts.prune();}
    if(req.method==='GET'&&path==='/api/client-config')return {status:200,data:ctx.clientConfig};
    if(req.method==='POST'&&path==='/api/accounts/guest')return {status:201,data:accounts.guest(body)};
    if(req.method==='POST'&&path==='/api/auth/google/challenge'){requireGoogleTransport(req);return {status:200,data:accounts.challenge(body,token(req))};}
    if(req.method==='POST'&&path==='/api/invites/preview'){
      const preview=ctx.partyApi.previewInvite(body.inviteToken),user=token(req)?accounts.authenticate(token(req)):null;
      return {status:200,data:{...preview,activePartyId:user?accounts.view(user).activePartyId:null,requiresVehicleSwitch:!!user&&!!accounts.view(user).activePartyId&&accounts.view(user).activePartyId!==preview.partyId}};
    }
    if(!path.startsWith('/api/me')&&!path.startsWith('/api/accounts/'))return null;
    const user=accounts.authenticate(token(req));
    if(req.method==='GET'&&path==='/api/me')return {status:200,data:{account:accounts.view(user)}};
    if(req.method==='POST'&&path==='/api/me/profile'){const account=accounts.profile(user,body);for(const room of ctx.rooms.values())if(!room.closedAt)for(const m of room.members.values())if(m.accountUserId===user.userId){m.nickname=user.displayName;ctx.change(room);}return {status:200,data:{account}};}
    if(req.method==='GET'&&path==='/api/me/parties')return {status:200,data:accounts.memberships(user)};
    if(req.method==='GET'&&path==='/api/me/history'){
      const query=new URL(req.url,'http://localhost').searchParams,offset=Number(query.get('offset')??0),limit=Number(query.get('limit')??50);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('INVALID_PAGE','offset >=0 and limit 1..100 required',400);
      const rows=accounts.personalHistory(user,ctx.places.events.allResults()).reverse();
      return {status:200,data:{results:rows.slice(offset,offset+limit),nextOffset:offset+limit<rows.length?offset+limit:null}};
    }
    if(req.method==='POST'&&path==='/api/accounts/refresh')return {status:200,data:accounts.refresh(token(req))};
    if(req.method==='POST'&&path==='/api/accounts/logout'){
      for(const [key,s]of ctx.sessions)if(s.accountUserId===user.userId)ctx.sessions.delete(key);
      for(const room of ctx.rooms.values())for(const m of room.members.values())if(m.accountUserId===user.userId){
        for(const [key,s]of ctx.sessions)if(s.sessionId===m.sessionId)ctx.sessions.delete(key);
        if(m.socket)ctx.closeSocket(m.socket,4413,'Account logged out');m.socket=null;ctx.pause(room,'ACCOUNT_LOGGED_OUT');ctx.change(room);
      }
      return {status:200,data:accounts.logout(token(req))};
    }
    if(req.method==='POST'&&path==='/api/me/party-ticket')return {status:200,data:gameTicket(user)};
    if(req.method==='POST'&&path==='/api/me/invitations/accept'){
      const preview=ctx.partyApi.previewInvite(body.inviteToken),plan=accounts.planJoin(user,preview.partyId,body);plan.partyName=preview.partyName;
      const response=ctx.partyApi.publicRequest({method:'POST'},'/api/invites/redeem',{inviteToken:body.inviteToken,nickname:user.displayName,seat:body.seat,passengerConfirmed:body.passengerConfirmed});
      const room=ctx.roomFor(response.data.roomId),member=[...room.members.values()].find(m=>m.memberId===response.data.memberId);
      const membership=accounts.pending(user,plan,member);
      for(const s of ctx.sessions.values())if(s.sessionId===member.sessionId)s.accountUserId=user.userId;
      return {status:201,data:{...response.data,tokenPurpose:'PARTY_PLAY',membership,account:accounts.view(user),previousPartyRemainsActiveUntilApproval:!!plan.fromMembershipId}};
    }
    if(req.method==='POST'&&path==='/api/me/invitations/cancel'){
      const p=accounts.pendingOf(user);if(!p)throw fail('NO_PENDING_PARTY','No pending invitation');
      const room=ctx.roomFor(p.partyId),member=[...room.members.values()].find(m=>m.memberId===p.memberId);if(member)detach(room,member,'CANCELLED');
      return {status:200,data:{cancelled:true,account:accounts.view(user)}};
    }
    if(req.method==='POST'&&path==='/api/me/party/leave'){
      const p=accounts.active(user);if(!p)throw fail('NO_ACTIVE_PARTY','No active party');const room=ctx.roomFor(p.partyId),member=[...room.members.values()].find(m=>m.memberId===p.memberId);
      if(member)detach(room,member,'LEFT');return {status:200,data:{left:true,account:accounts.view(user)}};
    }
    return null;
  }
  return {handle,token,approve,detach,requireGoogleTransport};
}
