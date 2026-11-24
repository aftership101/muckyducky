(() => {
'use strict';
// The conference runs in its own mode. Regular 1:1 calls remain in app.js.
if(new URLSearchParams(window.location.search).get('group')!=='1')return;

const $=id=>document.getElementById(id);
const panel=$('groupPanel'), status=$('status'), dot=$('dot'), timer=$('timer');
const password=$('groupPassword'), joinButton=$('groupJoin'), muteButton=$('groupMute');
const leaveButton=$('groupLeave'), restoreButton=$('groupRestore'), members=$('groupMembers');
const logView=$('groupLog'), hint=$('groupHint'), audioContainer=$('groupAudios');
const MAX_PARTICIPANTS=3, SCAN_MS=3500, HEARTBEAT_MS=4000, STALE_MS=28000;
const GROUP_SAVE_KEY='muckyducky-group-last-v1';
let peer=null, stream=null, roomHash=null, slots=[], links=new Map(), slotIndex=-1;
let joinEpoch=0, starting=false, stopping=false, muted=false, startedAt=0;
let scanTimer=null, heartbeatTimer=null, clockTimer=null, attemptTimer=null;
let attempts=new Map(), extraTargets=new Set(), fullReports=new Map(), lastStatus='';
let roomFull=false, lastMicRecovery=0, micRecoveryBusy=false;
const instance=crypto.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);

$('setup').hidden=true;
document.querySelector('.controls').hidden=true;
$('slotCounts').hidden=true;
$('adminPanel').hidden=true;
const legacyDetails=document.querySelector('main > details');
if(legacyDetails)legacyDetails.hidden=true;
panel.hidden=false;

function log(line){
 const existing=logView.textContent==='—'?[]:logView.textContent.split('\n');
 existing.push(new Date().toLocaleTimeString()+'  '+line);
 logView.textContent=existing.slice(-70).join('\n');
}
function setStatus(text,kind='wait'){
 if(lastStatus!==text){lastStatus=text;log(text);}
 status.textContent=text;
 dot.className='dot '+kind;
}
function error(message){hint.textContent=message;log(message);}
function shortId(id){
 const m=slots.findIndex(s=>s===id);
 return m>=0?'slot '+String.fromCharCode(65+m):'backup peer';
}
function validPeer(id){
 return typeof id==='string'&&(slots.includes(id)||id.startsWith('md3-'+roomHash.slice(0,32)+'-r-')&&id.length<145);
}
function savedRoom(){
 try{
  const entry=JSON.parse(sessionStorage.getItem(GROUP_SAVE_KEY)||'null');
  return entry&&/^[a-f0-9]{42}$/.test(entry.hash)&&Date.now()-entry.at<86400000?entry.hash:null;
 }catch{return null;}
}
function rememberRoom(){
 if(!roomHash)return;
 try{sessionStorage.setItem(GROUP_SAVE_KEY,JSON.stringify({hash:roomHash,at:Date.now()}));}catch{}
}
function clearRoom(){
 try{sessionStorage.removeItem(GROUP_SAVE_KEY);}catch{}
}
async function deriveRoom(passwordText){
 const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('muckyducky-three-person-v1\u0000'+passwordText));
 return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('').slice(0,42);
}
function makeSlots(hash){return ['a','b','c','d','e','f'].map(s=>'md3-'+hash+'-'+s);}
function randomSpare(){return 'md3-'+roomHash.slice(0,32)+'-r-'+(crypto.randomUUID?.().replace(/-/g,'')||Math.random().toString(36).slice(2));}
function getLink(id){
 let l=links.get(id);
 if(!l){
  l={id,data:null,media:null,admitted:false,seen:0,connectedAt:0,callAt:0,lastCall:0,
     remoteReady:false,audio:null,stream:null,iceBadAt:0,packets:0,lastPacketsAt:0,lastStatsAt:0};
  links.set(id,l);
 }
 return l;
}
function active(l){
 const rtc=l.media?.peerConnection;
 const mediaLive=!!(l.remoteReady&&l.media?.open&&rtc?.connectionState!=='failed'&&rtc?.connectionState!=='closed');
 return mediaLive||!!(l.admitted&&l.data?.open&&Date.now()-l.seen<STALE_MS);
}
function activeLinks(){return [...links.values()].filter(active);}
function count(){return (peer?.open?1:0)+activeLinks().length;}
function update(){
 if(!stream){members.textContent='Not in a three-person room';return;}
 const activeMembers=activeLinks();
 members.replaceChildren();
 const summary=document.createElement('strong');
 summary.textContent=Math.min(MAX_PARTICIPANTS,count())+' / '+MAX_PARTICIPANTS+' participants';
 members.append(summary);
 const own=document.createElement('div');own.textContent=(peer?.open?shortId(peer.id):'waiting for signaling')+' — you'+(muted?' (muted)':'');
 members.append(own);
 activeMembers.forEach(l=>{
  const row=document.createElement('div');
  row.textContent=shortId(l.id)+' — '+(l.remoteReady&&l.media?.open?'audio connected':'connecting audio');
  members.append(row);
 });
 if(!peer?.open)setStatus('connecting to signaling');
 else if(activeMembers.some(l=>l.remoteReady&&l.media?.open))setStatus(activeMembers.length>=2?'three-person call':'connected','live');
 else if(roomFull&&activeMembers.length===0)setStatus('room full — waiting for a place');
 else setStatus('waiting for people');
}
function setButtons(inCall){
 $('groupSetup').hidden=inCall;
 joinButton.hidden=inCall;
 muteButton.hidden=!inCall;
 leaveButton.hidden=!inCall;
 restoreButton.hidden=!inCall;
 $('groupBack').hidden=inCall;
}
function startClock(){
 if(clockTimer)return;
 startedAt=Date.now();
 clockTimer=setInterval(()=>{
  const sec=Math.floor((Date.now()-startedAt)/1000);
  timer.textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');
 },1000);
}
function stopClock(){clearInterval(clockTimer);clockTimer=null;timer.textContent='00:00';}
function stopAudio(l){
 if(l.audio){
  try{l.audio.pause();l.audio.srcObject=null;l.audio.remove();}catch{}
  l.audio=null;
 }
 l.stream=null;l.remoteReady=false;
}
function stopMedia(l,why){
 const m=l.media;l.media=null;l.callAt=0;l.iceBadAt=0;
 stopAudio(l);
 if(m)try{m.close();}catch{}
 if(why)log(shortId(l.id)+' audio reconnect: '+why);
 update();
}
function stopData(l){
 const c=l.data;l.data=null;
 if(c)try{c.close();}catch{}
}
function removeLink(l){
 stopMedia(l);stopData(l);links.delete(l.id);
 update();
}
function failPlayback(){
 restoreButton.hidden=false;
 hint.textContent='Incoming audio needs attention. Tap Restore audio.';
}
async function playAudio(l){
 if(!l.audio||!l.audio.srcObject)return;
 try{await l.audio.play();}catch{failPlayback();}
}
function addAudio(l,s){
 stopAudio(l);
 const audio=document.createElement('audio');
 audio.autoplay=true;audio.playsInline=true;audio.setAttribute('playsinline','');
 audio.srcObject=s;audio.volume=1;audio.muted=false;
 audio.addEventListener('stalled',()=>{log(shortId(l.id)+' playback stalled');});
 audio.addEventListener('pause',()=>{if(l.audio===audio)log(shortId(l.id)+' audio paused');});
 audioContainer.append(audio);
 l.audio=audio;l.stream=s;l.remoteReady=true;l.lastPacketsAt=Date.now();
 for(const t of s.getAudioTracks()){
  t.addEventListener('ended',()=>{if(l.stream===s){log(shortId(l.id)+' remote track ended');stopMedia(l,'remote track ended');}});
  t.addEventListener('unmute',()=>playAudio(l));
 }
 playAudio(l);
 if(!clockTimer)startClock();
 update();
}
function watchMedia(l,c){
 if(l.media&&l.media!==c){
  const old=l.media;l.media=null;try{old.close();}catch{}
  stopAudio(l);
 }
 l.media=c;l.remoteReady=false;l.callAt=Date.now();l.iceBadAt=0;
 c.on('stream',remote=>{
  if(l.media!==c||stopping)return;
  l.callAt=0;
  addAudio(l,remote);
 });
 c.on('close',()=>{
  if(l.media!==c)return;
  stopMedia(l,'call closed');
 });
 c.on('error',e=>{
  if(l.media!==c)return;
  stopMedia(l,e?.type||e?.message||'media error');
 });
 const attachPc=()=>{
  if(l.media!==c||!c.peerConnection)return;
  const pc=c.peerConnection;
  if(pc.__md3Watched)return;
  pc.__md3Watched=true;
  const onState=()=>{
   if(l.media!==c)return;
   if(pc.connectionState==='failed'||pc.iceConnectionState==='failed'){
    if(!l.iceBadAt)l.iceBadAt=Date.now();
   }else l.iceBadAt=0;
  };
  pc.addEventListener('connectionstatechange',onState);
  pc.addEventListener('iceconnectionstatechange',onState);
 };
 attachPc();
 setTimeout(attachPc,1000);
 update();
}
function callPeer(l){
 if(!peer?.open||!stream||!l.admitted||l.media||peer.id<=l.id||Date.now()-l.lastCall<3500)return;
 l.lastCall=Date.now();
 try{
  const c=peer.call(l.id,stream,{metadata:{kind:'group-v1',session:instance}});
  if(c){log('calling '+shortId(l.id));watchMedia(l,c);}
 }catch(e){log(shortId(l.id)+' call failed: '+(e.message||e));}
}
function send(l,message){
 if(l.data?.open)try{l.data.send(message);}catch{}
}
function announce(l){
 send(l,{type:'hello',session:instance,peers:[peer.id,...activeLinks().map(x=>x.id)].slice(0,3)});
}
function rejectFull(dc){
 const respond=()=>{
  try{if(dc.open)dc.send({type:'full',limit:MAX_PARTICIPANTS});}catch{}
  setTimeout(()=>{try{dc.close();}catch{}},350);
 };
 if(dc.open)respond();else dc.on('open',respond);
}
function watchData(l,dc){
 if(l.data&&l.data!==dc){
  if(l.data.open){try{dc.close();}catch{}return;}
  stopData(l);
 }
 l.data=dc;
 const onOpen=()=>{
  if(l.data!==dc||stopping)return;
  l.admitted=true;l.seen=Date.now();
  log('signaling linked to '+shortId(l.id));
  announce(l);update();callPeer(l);
 };
 dc.on('open',onOpen);
 dc.on('data',msg=>{
  if(l.data!==dc||!msg||typeof msg!=='object')return;
  l.seen=Date.now();
  if(msg.type==='full'){
   fullReports.set(l.id,Date.now());roomFull=true;
   log(shortId(l.id)+' reports room full');
   stopData(l);l.admitted=false;update();return;
  }
  if(msg.type==='leave'){log(shortId(l.id)+' left');removeLink(l);return;}
  if(msg.type==='hello'||msg.type==='heartbeat'){
   l.admitted=true;
   if(Array.isArray(msg.peers)){
    for(const id of msg.peers.slice(0,3)){
     if(validPeer(id)&&id!==peer?.id&&id!==l.id)extraTargets.add(id);
    }
   }
   if(msg.type==='hello'){announce(l);callPeer(l);}
   update();
  }
 });
 dc.on('close',()=>{
  if(l.data!==dc)return;
  l.data=null;
  if(!l.media?.open){
   l.admitted=false;
   if(links.get(l.id)===l)links.delete(l.id);
  }
  update();
 });
 dc.on('error',()=>{
  if(l.data!==dc)return;
  l.data=null;
  if(!l.media?.open){l.admitted=false;links.delete(l.id);}
  update();
 });
 if(dc.open)onOpen();
}
function connectedCountExcluding(id){return activeLinks().filter(l=>l.id!==id).length;}
function onIncomingData(dc){
 if(stopping||!stream||!validPeer(dc.peer)||dc.peer===peer?.id){try{dc.close();}catch{}return;}
 const known=links.get(dc.peer);
 if(!known?.admitted&&connectedCountExcluding(dc.peer)>=MAX_PARTICIPANTS-1){
  rejectFull(dc);return;
 }
 const l=getLink(dc.peer);watchData(l,dc);
}
function onIncomingCall(c){
 if(stopping||!stream||!validPeer(c.peer)||c.peer===peer?.id){try{c.close();}catch{}return;}
 const known=links.get(c.peer);
 if(!known?.admitted&&connectedCountExcluding(c.peer)>=MAX_PARTICIPANTS-1){
  log('rejected fourth participant');try{c.close();}catch{}return;
 }
 const l=getLink(c.peer);
 if(l.media?.open&&l.remoteReady){
  log('rejected duplicate healthy call');try{c.close();}catch{}return;
 }
 l.admitted=true;l.seen=Date.now();
 watchMedia(l,c);
 try{c.answer(stream);}catch(e){stopMedia(l,'answer failed');}
}
function scan(){
 if(!peer?.open||!stream||stopping)return;
 const now=Date.now();
 if(activeLinks().length>=MAX_PARTICIPANTS-1){update();return;}
 const targets=[...slots,...extraTargets].filter(id=>id!==peer.id&&validPeer(id)&&peer.id>id);
 let remaining=2;
 for(const id of targets){
  if(!remaining)break;
  const l=links.get(id);
  if(l?.data?.open||l?.media?.open)continue;
  if(attempts.get(id)>now)continue;
  attempts.set(id,now+11000);
  remaining--;
  try{
   const conn=peer.connect(id,{reliable:true,metadata:{kind:'group-v1'}});
   const target=getLink(id);
   target.connectedAt=now;
   watchData(target,conn);
  }catch{attempts.set(id,now+13000);}
 }
 for(const l of links.values())if(l.admitted&&l.data?.open)callPeer(l);
 update();
}
function heartbeat(){
 if(!stream||stopping)return;
 const now=Date.now();
 for(const l of [...links.values()]){
  if(l.data?.open){
   send(l,{type:'heartbeat',session:instance,peers:[peer?.id,...activeLinks().map(x=>x.id)].slice(0,3)});
   if(now-l.seen>STALE_MS){log(shortId(l.id)+' signaling stale');stopData(l);if(!l.media?.open)removeLink(l);}
  }else if(l.data&&now-l.connectedAt>11000){
   stopData(l);
   if(!l.media?.open)removeLink(l);
  }
  if(l.media&&!l.remoteReady&&l.callAt&&now-l.callAt>17000){stopMedia(l,'call timed out');}
  if(l.iceBadAt&&now-l.iceBadAt>17000){stopMedia(l,'transport failed');}
  if(l.media?.open&&l.media.peerConnection&&now-l.lastStatsAt>5000){
   l.lastStatsAt=now;
   const mc=l.media,pc=mc.peerConnection;
   pc.getStats().then(stats=>{
    if(l.media!==mc)return;
    let received=null;
    stats.forEach(x=>{if(x.type==='inbound-rtp'&&(x.kind==='audio'||x.mediaType==='audio'))received=x.packetsReceived;});
    if(received!==null){
     if(l.packets!==received){l.packets=received;l.lastPacketsAt=Date.now();}
     if(!l.iceBadAt&&l.media?.open&&Date.now()-l.lastPacketsAt>40000){
      log(shortId(l.id)+' incoming audio packets stalled; retrying media');
      stopMedia(l,'no incoming audio packets');
     }
    }
   }).catch(()=>{});
  }
 }
 if(peer?.disconnected&&!peer.destroyed)try{peer.reconnect();}catch{}
 update();
}
function takeSlot(index,ticket){
 if(stopping||ticket!==joinEpoch||!stream)return;
 if(index>=slots.length){
  // The six deterministic slots may contain phantom IDs. A spare can still reach them.
  const id=randomSpare();
  try{
   const p=new Peer(id,{debug:0,config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]}});
   bindPeer(p,index,ticket);
  }catch(e){error('Could not register an emergency slot: '+e.message);}
  return;
 }
 try{
  const p=new Peer(slots[index],{debug:0,config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]}});
  bindPeer(p,index,ticket);
 }catch(e){error('Signaling error: '+e.message);}
}
function bindPeer(p,index,ticket){
 peer=p;
 p.on('open',()=>{
  if(ticket!==joinEpoch||stopping||peer!==p){try{p.destroy();}catch{}return;}
  slotIndex=index;
  log('joined three-person room as '+shortId(p.id));
  setStatus('waiting for people');
  update();
  scan();
  clearInterval(scanTimer);clearInterval(heartbeatTimer);
  scanTimer=setInterval(scan,SCAN_MS);
  heartbeatTimer=setInterval(heartbeat,HEARTBEAT_MS);
 });
 p.on('connection',dc=>{if(peer===p&&ticket===joinEpoch)onIncomingData(dc);else try{dc.close();}catch{}});
 p.on('call',c=>{if(peer===p&&ticket===joinEpoch)onIncomingCall(c);else try{c.close();}catch{}});
 p.on('error',e=>{
  if(peer!==p||ticket!==joinEpoch||stopping)return;
  log('signaling: '+e.type);
  if(e.type==='unavailable-id'){
   try{p.destroy();}catch{}
   if(peer===p)peer=null;
   takeSlot(index+1,ticket);
  }else if(e.type==='network'||e.type==='socket-error'||e.type==='socket-closed'||e.type==='server-error'){
   setStatus('reconnecting signaling');
  }
 });
 p.on('disconnected',()=>{
  if(peer!==p||stopping)return;
  log('signaling disconnected; keeping existing audio');
  try{p.reconnect();}catch{}
 });
 p.on('close',()=>{if(peer===p)log('signaling closed');});
}
async function reacquireMic(){
 if(!stream||stopping||micRecoveryBusy||document.hidden||Date.now()-lastMicRecovery<5000)return;
 const old=stream.getAudioTracks()[0];
 if(old?.readyState==='live'&&!old.muted)return;
 micRecoveryBusy=true;lastMicRecovery=Date.now();
 let replacement=null;
 try{
  replacement=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  const t=replacement.getAudioTracks()[0];
  if(!t||!stream||stopping){replacement.getTracks().forEach(x=>x.stop());return;}
  t.enabled=!muted;
  for(const l of links.values()){
   for(const sender of l.media?.peerConnection?.getSenders?.()||[]){
    if(sender.track?.kind==='audio')await sender.replaceTrack(t);
   }
  }
  const prior=stream;stream=replacement;
  prior.getTracks().forEach(x=>x.stop());
  log('microphone recovered');
 }catch(e){
  if(replacement)replacement.getTracks().forEach(x=>x.stop());
  error('Microphone interrupted. Tap Restore audio if needed. '+(e?.name||''));
 }finally{micRecoveryBusy=false;update();}
}
async function join(){
 if(starting||stream||peer)return;
 starting=true;joinButton.disabled=true;
 try{
  if(typeof window.Peer!=='function')throw Error('PeerJS is unavailable');
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone unavailable in this browser');
  const raw=password.value;
  const old=savedRoom();
  if(raw.length<4&&!old)throw Error('Enter the shared room password (4+ characters)');
  roomHash=raw.length>=4?await deriveRoom(raw):old;
  slots=makeSlots(roomHash);links=new Map();extraTargets.clear();attempts.clear();fullReports.clear();
  roomFull=false;stopping=false;muted=false;
  const ticket=++joinEpoch;
  if(navigator.audioSession&&'type' in navigator.audioSession)try{navigator.audioSession.type='play-and-record';}catch{}
  stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  if(ticket!==joinEpoch){stream.getTracks().forEach(t=>t.stop());stream=null;return;}
  const voice=stream.getAudioTracks()[0];
  if(voice&&'contentHint' in voice)try{voice.contentHint='speech';}catch{}
  if(voice)voice.addEventListener('ended',()=>{log('microphone ended');if(!document.hidden)reacquireMic();});
  rememberRoom();setButtons(true);hint.textContent='';update();
  log('starting three-person audio mesh');
  takeSlot(0,ticket);
 }catch(e){
  if(stream){stream.getTracks().forEach(x=>x.stop());stream=null;}
  error('Could not join: '+(e?.message||e));
  setStatus('offline','');
  setButtons(false);
 }finally{starting=false;joinButton.disabled=false;}
}
function leave(){
 if(stopping)return;
 stopping=true;joinEpoch++;
 clearInterval(scanTimer);clearInterval(heartbeatTimer);clearInterval(clockTimer);clearTimeout(attemptTimer);
 scanTimer=heartbeatTimer=clockTimer=attemptTimer=null;
 for(const l of links.values())send(l,{type:'leave'});
 for(const l of [...links.values()])removeLink(l);
 const p=peer;peer=null;
 if(p)try{p.destroy();}catch{}
 if(stream){stream.getTracks().forEach(x=>x.stop());stream=null;}
 links.clear();extraTargets.clear();attempts.clear();fullReports.clear();
 roomHash=null;slots=[];slotIndex=-1;roomFull=false;muted=false;
 stopClock();setButtons(false);setStatus('offline','');update();
 clearRoom();
 hint.textContent='';
}
joinButton.addEventListener('click',join);
muteButton.addEventListener('click',()=>{
 if(!stream)return;
 muted=!muted;
 for(const t of stream.getAudioTracks())t.enabled=!muted;
 muteButton.textContent=muted?'unmute':'mute';
 update();log(muted?'muted':'unmuted');
});
restoreButton.addEventListener('click',()=>{
 for(const l of links.values())playAudio(l);
 reacquireMic();
});
leaveButton.addEventListener('click',leave);
window.addEventListener('pagehide',()=>{
 if(!stream)return;
 for(const l of links.values())send(l,{type:'leave'});
});
window.addEventListener('pageshow',()=>{
 if(stream){for(const l of links.values())playAudio(l);reacquireMic();}
});
document.addEventListener('visibilitychange',()=>{
 if(!document.hidden&&stream){for(const l of links.values())playAudio(l);reacquireMic();}
});
if(savedRoom()){
 joinButton.textContent='Rejoin previous 3-person room';
 hint.textContent='Enter a password for a different room, or tap Rejoin previous room.';
}
setStatus('offline','');
})();