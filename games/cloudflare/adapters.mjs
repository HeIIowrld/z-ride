// 게임마다 다른 부분만 모은다: 게임 만들기, 차 화면·폰 메시지 처리, 다음에 깨어날 시각.
// 각 게임 폴더의 server.mjs(Node)와 같은 규칙이다. 규칙 자체는 각 게임의 game.mjs를 그대로 쓴다.
import { Game as Relay } from '../charge-relay/game.mjs';
import { Game as Tug } from '../power-tug/game.mjs';
import { Game as Volt } from '../volt-rush/game.mjs';
import { Game as Castle } from '../power-castle/game.mjs';

const fail = () => { throw new Error('BAD_MESSAGE'); };

export const ADAPTERS = {
  'charge-relay': {
    create: now => new Relay({ now }),
    maxPayload: 128 * 1024, // 그림이 들어온다
    host(game, m) {
      if (m.type === 'start') game.start(m.rounds);
      else if (m.type === 'next') game.next();
      else if (m.type === 'skip') game.expire();
      else if (m.type === 'kick') game.removePlayer(m.playerId);
      else fail();
    },
    player(game, id, m) {
      if (m.type === 'submit') game.submit(id, m);
      else if (m.type === 'heart') game.heart(id, m.index);
      else fail();
    },
    // 폰이 시간 끝에 보내는 그림을 받을 여유 1.5초
    wakeAt: game => (game.phase === 'PLAY' ? game.deadline + 1500 : null),
    wake: game => game.expire(),
  },
  'power-tug': {
    create: now => new Tug({ now }),
    host(game, m) {
      if (m.type === 'start') game.showRules();
      else if (m.type === 'skip') { if (game.phase === 'RULES') game.start(); }
      else if (m.type === 'next') game.next();
      else if (m.type === 'shuffle') game.shuffleTeams();
      else if (m.type === 'lobby') game.backToLobby();
      else if (m.type === 'kick') game.removePlayer(m.playerId);
      else fail();
    },
    player(game, id, m) {
      if (m.type === 'tap') { const phase = game.phase; game.tap(id, m.n); return game.phase === phase ? 'SOON' : 'NOW'; }
      if (m.type === 'team') game.switchTeam(id);
      else fail();
    },
    wakeAt: game => (game.deadline ? game.deadline + 20 : null),
    wake: game => game.expire(),
  },
  'volt-rush': {
    create: now => new Volt({ now }),
    host(game, m) {
      if (m.type === 'start') game.showRules();
      else if (m.type === 'skip') { if (game.phase === 'RULES') game.start(); }
      else if (m.type === 'next') game.next();
      else if (m.type === 'lobby') game.backToLobby();
      else if (m.type === 'kick') game.removePlayer(m.playerId);
      else if (m.type === 'soc') game.setSoc(m.soc, m.target);
      else fail();
    },
    player(game, id, m) {
      if (m.type === 'move') { const phase = game.phase; game.move(id, m.dir); return game.phase === phase ? 'SOON' : 'NOW'; }
      if (m.type === 'item') game.useItem(id, String(m.id ?? ''));
      else fail();
    },
    wakeAt: game => game.wakeAt(),
    wake: game => game.wake(),
  },
  'power-castle': {
    create: now => new Castle({ now }),
    host(game, m) {
      if (m.type === 'start') game.start();
      else if (m.type === 'skip') game.skipRules();
      else if (m.type === 'next') game.next();
      else if (m.type === 'lobby') game.backToLobby();
      else if (m.type === 'kick') game.removePlayer(m.playerId);
      else if (m.type === 'soc') game.setSoc(m.soc, m.target);
      else fail();
    },
    player(game, id, m) {
      if (m.type === 'act') game.act(id, String(m.kind ?? ''), m.target == null ? null : String(m.target));
      else fail();
    },
    wakeAt: game => game.wakeAt(),
    wake: game => game.wake(),
  },
};
