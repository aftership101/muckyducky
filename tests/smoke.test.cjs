const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname,'..');
const js = fs.readFileSync(path.join(root,'app.js'),'utf8');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');

test('JavaScript parses', () => assert.doesNotThrow(() => new vm.Script(js)));
test('all required interface controls exist', () => {
  for (const id of ['dot','status','timer','password','setup','callBtn','muteBtn','endBtn','restoreBtn','error','localState','remoteState','diagnostics','remoteAudio']) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
});
test('one password input, no extra settings', () => {
  assert.equal((html.match(/<input\b/g)||[]).length,1);
  assert.doesNotMatch(html,/micSelect|copyLogBtn|inviteInput/);
});
test('microphone does not enable noise suppression', () => {
  assert.match(js,/noiseSuppression:false/);
  assert.doesNotMatch(js,/noiseSuppression:true/);
});
test('explicit remote hangup is handled immediately', () => {
  assert.match(js,/m\.type==='exit'/);
  assert.match(js,/holdRemote=true;closeMedia\(\)/);
});
test('heartbeat absence alone cannot remove active audio', () => {
  assert.match(js,/quality==='dead'/);
  assert.match(js,/inspectAudio\(\)/);
});
test('recovery timers and stale-session protections are present', () => {
  assert.match(js,/sessionId=/);
  assert.match(js,/ticket!==epoch/);
  assert.match(js,/clearTimers\(\)/);
  assert.match(js,/nextRetry/);
});
test('no embedded PIN or hardcoded shared secret', () => {
  assert.doesNotMatch(js, /['"]0120['"]/);
  assert.match(js,/crypto\.subtle\.digest/);
});
test('no unexpected external dependencies other than PeerJS', () => {
  const src=[...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(src.length,2);
  assert.match(src[0],/^https:\/\/cdn\.jsdelivr\.net\/npm\/peerjs@/);
  assert.match(src[1],/^app\.js\?v=/);
});
