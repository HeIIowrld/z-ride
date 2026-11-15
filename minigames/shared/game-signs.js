const game = location.pathname.includes('raindrop') ? 'raindrop' : location.pathname.includes('license-quiz') ? 'license-quiz' : 'pole-jump';
const image = `../../shared/assets/signs/sign-${game}.png`;
const header = document.querySelector('.game-nav');
if (header) { const badge = document.createElement('img'); badge.className = 'game-nav-sign'; badge.src = image; badge.alt = ''; header.append(badge); }
const panel = document.querySelector('#start article, #start .overlay-card, #waiting');
if (panel) { const badge = document.createElement('img'); badge.className = 'panel-sign'; badge.src = image; badge.alt = ''; panel.prepend(badge); }
const result = document.querySelector('#result article, #result .overlay-card, #result');
if (result) { const badge = document.createElement('img'); badge.className = 'panel-sign result-sign'; badge.src = image; badge.alt = ''; result.prepend(badge); }
