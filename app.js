(() => {
'use strict';
const $ = id => document.getElementById(id);
const ui=Object.fromEntries(['dot','status','timer','password','setup','callBtn','muteBtn','endBtn','restoreBtn','error','browserLink','localState','remoteState','diagnostics','remoteAudio'].map(id=>[id,$(id)]));
const events=[];
const deviceId=(()=>{try{let id=localStorage.getItem('muckyducky-device-v1');if(!id){id=crypto.randomUUID();localStorage.setItem('muckyducky-device-v1',id);}return id;}catch{return crypto.randomUUID?.()||String(Date.now())+'-'+Math.random();}})();

let peer=null,media=null,data=null,stream=null,ids=null,slot=-1,epoch=0,stopping=false,starting=false,connecting=false,dialTargetIndex=0,remoteDevice=null;
let healthTimer=null,redialTimer=null,clockTimer=null,startedAt=0,lastRemote=0,lastHeartbeat=0,remoteReason='',remoteState='offline',pendingAudio=false,callAttemptAt=0,dataAttemptAt=0;
let recoveryBusy=false,lastRecoveryAt=0,peerRetryAt=0,roomRetryTimer=null,presenceLost=false,hadPresence=false,mediaOpenedAt=0;
let lastStats=null,statsBusy=false,quality='unknown',retryCount=0,nextRetry=0,holdRemote=false,lastAudioFlow=0,lastInboundPackets=null,remoteSession=null,sessionId=crypto.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2),recoveryMode=false,heartbeatAt=0,remoteAudioInterruptedAt=0,remotePageHidden=false,remoteMicInterrupted=false,localMicInterruptedAt=0,userMuted=false,micRetryTimer=null,micRetryCount=0,audioSessionState='unknown',audioSessionInterrupted=false,audioResumeTimer=null,transportFailedAt=0;
function log(m){events.push(new Date().toLocaleTimeString()+'  '+m);if(events.length>100)events.shift();ui.diagnostics.textContent=events.join('\n');}
function state(m,t=''){if(ui.status.textContent!==m)log(m);ui.status.textContent=m;ui.dot.className='dot '+t;}
function problem(m,micBlocked=false){ui.error.textContent=m;ui.error.hidden=!m;ui.browserLink.hidden=!micBlocked;if(m)log('error: '+m);}
function remote(m){remoteState=m;ui.remoteState.textContent=m;}
function track(){return stream?.getAudioTracks()[0];}
function captureError(e,prefix='start failed'){
const denied=e?.name==='NotAllowedError'||e?.name==='SecurityError';
if(denied){
const standalone=!!navigator.standalone||!!window.matchMedia?.('(display-mode: standalone)').matches;
log('mic blocked: '+e.name+'; standalone: '+standalone);
problem('Microphone access is blocked in this browser context. Open the site directly in Safari, check its microphone permission, and try again. iOS restrictions cannot be overridden by this page.',true);
return;
}
problem(prefix+': '+(e?.message||e?.name||String(e)));
}
function refresh(){const t=track();ui.localState.textContent='signaling: '+(peer?.open?'online':'offline')+'\nmic: '+(!t?'off':t.readyState==='ended'?'ended':t.muted?'interrupted':t.enabled?'on':'muted')+'\naudio session: '+audioSessionState+'\npage: '+document.visibilityState+'\nnetwork: '+(navigator.onLine?'online':'offline')+'\ncall: '+(media?.open?'open':'not connected');}
function transmit(msg){if(data?.open){try{data.send(msg);}catch(e){log('diagnostic send failed');}}}
function heartbeat(){refresh();transmit({type:'status',session:sessionId,state:ui.localState.textContent,time:Date.now(),pageHidden:document.hidden,micInterrupted:!!track()?.muted,device:deviceId});heartbeatAt=Date.now();}
async function roomIds(password){
const bytes=new TextEncoder().encode('muckyducky-private-room-v2\u0000'+password);
const digest=await crypto.subtle.digest('SHA-256',bytes);
const h=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
return ['a','b','c','d'].map(s=>'md-'+h.slice(0,42)+'-'+s);
}
function stopClock(){clearInterval(clockTimer);clockTimer=null;ui.timer.textContent='00:00';}
function startClock(){if(clockTimer)return;startedAt=Date.now();clockTimer=setInterval(()=>{const n=Math.floor((Date.now()-startedAt)/1000);ui.timer.textContent=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');},1000);}
function requestAudioSession(){
const s=navigator.audioSession;
if(!s)return;
try{if('type' in s&&s.type!=='play-and-record')s.type='play-and-record';}catch(e){log('audio session request unavailable: '+e.name);}
}
function canRetryMicrophone(){
return !stopping&&!!stream&&!document.hidden&&!audioSessionInterrupted&&navigator.onLine!==false;
}
function scheduleMicRecovery(reason,immediate=false){
if(!canRetryMicrophone())return;
const t=track();
if(!t||t.readyState==='live'&&!t.muted){clearTimeout(micRetryTimer);micRetryTimer=null;micRetryCount=0;return;}
if(micRetryTimer||recoveryBusy)return;
const delays=[1800,5000,10000,20000,30000];
const delay=immediate?0:delays[Math.min(micRetryCount,delays.length-1)];
micRetryTimer=setTimeout(()=>{
micRetryTimer=null;
if(!canRetryMicrophone())return;
const current=track();
if(current&&(current.readyState==='ended'||current.muted)){
micRetryCount++;
recoverMicrophone(current.muted);
}
},delay);
log('microphone recovery scheduled: '+reason+' ('+delay+'ms)');
}
async function recoverMicrophone(force=false){
if(!canRetryMicrophone()||recoveryBusy)return;
const old=track();
if(old&&old.readyState==='live'&&(!force||!old.muted))return;
if(Date.now()-lastRecoveryAt<3500){scheduleMicRecovery('cooldown');return;}
recoveryBusy=true;lastRecoveryAt=Date.now();
let next=null;
try{
requestAudioSession();
next=await microphone();
if(!canRetryMicrophone()||stream?.getAudioTracks()[0]!==old){next.getTracks().forEach(t=>t.stop());return;}
const replacement=next.getAudioTracks()[0];
if(!replacement||replacement.readyState!=='live'||replacement.muted){
next.getTracks().forEach(t=>t.stop());log('new microphone not yet available');return;
}
replacement.enabled=!userMuted;
const pc=media?.peerConnection;
for(const sender of pc?.getSenders?.()||[]){
if(sender.track?.kind==='audio')await sender.replaceTrack(replacement);
}
if(!canRetryMicrophone()||stream?.getAudioTracks()[0]!==old){
next.getTracks().forEach(t=>t.stop());return;
}
const prior=stream;stream=next;watchMicrophone(next);
if(prior)prior.getTracks().forEach(t=>t.stop());
localMicInterruptedAt=0;micRetryCount=0;
log('microphone recovered');problem('');heartbeat();
}catch(e){
if(next&&stream!==next)next.getTracks().forEach(t=>t.stop());
log('microphone recovery: '+(e.name||e.message));
if(e.name==='NotAllowedError'||e.name==='SecurityError')captureError(e,'mic recovery failed');
}finally{
recoveryBusy=false;
if(canRetryMicrophone()&&(track()?.readyState==='ended'||track()?.muted))scheduleMicRecovery('still interrupted');
}
}
function scheduleAudioResume(reason){
if(!media||!ui.remoteAudio.srcObject||stopping||document.hidden||audioSessionInterrupted)return;
if(audioResumeTimer)return;
audioResumeTimer=setTimeout(()=>{
audioResumeTimer=null;
if(media&&ui.remoteAudio.srcObject&&!document.hidden&&!audioSessionInterrupted&&(ui.remoteAudio.paused||pendingAudio)){
log('resuming incoming audio: '+reason);
play();
}
},300);
}
function resumeCall(reason){
if(stopping||!stream)return;
requestAudioSession();
syncAudioSession();
if(audioSessionInterrupted)return;
if(track()?.readyState==='ended'||track()?.muted)scheduleMicRecovery(reason);
scheduleAudioResume(reason);
if(peer?.disconnected&&!peer.destroyed){try{peer.reconnect();}catch{}}
}
function syncAudioSession(){
const s=navigator.audioSession;
if(!s||!('state' in s))return;
const next=s.state;
if(next===audioSessionState)return;
audioSessionState=next;
audioSessionInterrupted=next==='interrupted';
log('audio session: '+next);
if(audioSessionInterrupted){
clearTimeout(micRetryTimer);micRetryTimer=null;
clearTimeout(audioResumeTimer);audioResumeTimer=null;
}else resumeCall('audio session resumed');
refresh();
}
function watchAudioSession(){
const s=navigator.audioSession;
if(!s)return;
requestAudioSession();
if(typeof s.addEventListener==='function'&&'state' in s){
s.addEventListener('statechange',syncAudioSession);
syncAudioSession();
}
}
function closeMedia(){callAttemptAt=0;mediaOpenedAt=0;lastStats=null;lastInboundPackets=null;let c=media;media=null;if(c)try{c.close();}catch{}ui.remoteAudio.srcObject=null;ui.restoreBtn.hidden=true;pendingAudio=false;stopClock();}
function clearTimers(){clearInterval(healthTimer);clearInterval(redialTimer);clearTimeout(roomRetryTimer);clearTimeout(micRetryTimer);clearTimeout(audioResumeTimer);micRetryTimer=audioResumeTimer=null;healthTimer=redialTimer=roomRetryTimer=null;}
function controls(active){ui.setup.hidden=active;ui.callBtn.hidden=active;ui.muteBtn.hidden=!active;ui.endBtn.hidden=!active;ui.callBtn.disabled=false;}
function teardown(reason='hang up button pressed'){
stopping=true;epoch++;transmit({type:'exit',reason});userMuted=false;micRetryCount=0;audioSessionInterrupted=false;transportFailedAt=0;log('you: '+reason);clearTimers();closeMedia();const d=data;data=null;const p=peer;peer=null;if(d||p)setTimeout(()=>{if(d)try{d.close();}catch{}if(p)try{p.destroy();}catch{}},650);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}ids=null;slot=-1;starting=false;connecting=false;lastRemote=0;remoteReason='';presenceLost=false;hadPresence=false;holdRemote=false;remoteSession=null;remoteDevice=null;dialTargetIndex=0;retryCount=0;nextRetry=0;lastAudioFlow=0;remoteAudioInterruptedAt=0;remotePageHidden=false;remoteMicInterrupted=false;localMicInterruptedAt=0;remote('offline');controls(false);ui.muteBtn.textContent='mute';state('offline');problem('');refresh();stopping=false;
}
async function play(){
if(!ui.remoteAudio.srcObject)return;
try{await ui.remoteAudio.play();pendingAudio=false;ui.restoreBtn.hidden=true;log('audio playing');}
catch(e){pendingAudio=true;ui.restoreBtn.hidden=false;log('playback blocked: '+e.name);problem('tap restore audio');}
}
function mediaEvents(c){
if(media&&media!==c){c.close();return;}
media=c;state('connecting','wait');
const rtc=c.peerConnection;
if(rtc){
const check=()=>{log('webrtc: '+rtc.connectionState+' / ice '+rtc.iceConnectionState);
const failed=rtc.connectionState==='failed'||rtc.iceConnectionState==='failed';
if(failed&&!transportFailedAt)transportFailedAt=Date.now();
if(!failed)transportFailedAt=0;
if(rtc.connectionState==='closed'&&media===c&&!stopping){closeMedia();state('reconnecting','wait');}
};
rtc.addEventListener('connectionstatechange',check);
rtc.addEventListener('iceconnectionstatechange',check);
}
c.on('stream',s=>{if(media!==c)return;remoteAudioInterruptedAt=0;callAttemptAt=0;mediaOpenedAt=Date.now();retryCount=0;nextRetry=0;lastAudioFlow=Date.now();ui.remoteAudio.srcObject=s;transportFailedAt=0;for(const t of s.getAudioTracks()){t.addEventListener('mute',()=>{remoteAudioInterruptedAt=Date.now();log('remote microphone temporarily interrupted; preserving call');});t.addEventListener('unmute',()=>{remoteAudioInterruptedAt=0;log('remote track resumed');play();});t.addEventListener('ended',()=>log('remote track ended'));}state('connected','live');holdRemote=false;problem('');startClock();play();heartbeat();});
c.on('close',()=>{if(media!==c)return;media=null;ui.remoteAudio.srcObject=null;stopClock();if(!stopping){if(slot>=2)dialTargetIndex=1-dialTargetIndex;nextRetry=Date.now()+1200;state('reconnecting','wait');remote('disconnected\nreason: '+(remoteReason||'unknown; connection ended'));}});
c.on('error',e=>{log('media error: '+(e.type||e.message));if(media===c){closeMedia();if(!stopping)state('reconnecting','wait');}});
}
function watchData(c){
if(data&&data!==c){if(data.open&&data.peer!==c.peer){c.close();return;}try{data.close();}catch{}}
data=c;
c.on('open',()=>{dataAttemptAt=0;presenceLost=false;hadPresence=true;lastRemote=Date.now();log('diagnostics linked');heartbeat();});
c.on('data',m=>{
if(c!==data||!m||typeof m!=='object')return;
lastRemote=Date.now();presenceLost=false;hadPresence=true;
if(m.type==='status'){if(m.device&&remoteDevice&&m.device!==remoteDevice&&media){log('ignored status from different participant');return;}if(m.device)remoteDevice=m.device;if(m.session&&remoteSession&&m.session!==remoteSession){log('new remote session; replacing stale connection');if(media)closeMedia();holdRemote=false;}remoteSession=m.session||remoteSession;holdRemote=false;remotePageHidden=!!m.pageHidden;remoteMicInterrupted=!!m.micInterrupted;if(remoteMicInterrupted&&!remoteAudioInterruptedAt)remoteAudioInterruptedAt=Date.now();if(!remoteMicInterrupted&&remoteAudioInterruptedAt)remoteAudioInterruptedAt=0;remote(m.state+'\nupdated: just now');}
if(m.type==='exit'){transmit({type:'exit-ack'});remoteReason=m.reason||'hang up';remote('offline\nreason: '+remoteReason);log('other person: '+remoteReason);holdRemote=true;closeMedia();state('waiting for rejoin','wait');const stale=data;data=null;if(stale)try{stale.close();}catch{}}
});
c.on('close',()=>{if(data!==c)return;data=null;if(!stopping){log('diagnostics disconnected');if(Date.now()-lastRemote>25000)remote('unreachable\nreason: unknown');}});
c.on('error',e=>log('diagnostics error: '+e.message));
}
function dial(){
if(stopping||holdRemote||slot<1||!peer?.open||!stream||media)return;
const target=ids[slot>=2?dialTargetIndex:0];
try{const c=peer.call(target,stream,{metadata:{device:deviceId,session:sessionId}});if(c){callAttemptAt=Date.now();mediaEvents(c);}}catch(e){log('dial failed: '+e.message);}
}
function dialData(){
if(stopping||slot<1||!peer?.open||data)return;
if(slot>=2&&!media?.open)return;
const target=slot>=2?media.peer:ids[0];
try{dataAttemptAt=Date.now();watchData(peer.connect(target,{reliable:true}));}catch(e){log('data dial failed: '+e.message);}
}
async function inspectAudio(){
if(statsBusy||!media?.peerConnection||stopping)return;
const pc=media.peerConnection;if(pc.connectionState==='closed')return;
statsBusy=true;
try{
const reports=await pc.getStats();let inbound=null,loss=0,jitter=0,rtt=null;
reports.forEach(x=>{if(x.type==='inbound-rtp'&&x.kind==='audio')inbound=x;if(x.type==='candidate-pair'&&x.state==='succeeded'&&x.currentRoundTripTime!=null)rtt=x.currentRoundTripTime;});
if(inbound){let count=inbound.packetsReceived||0;loss=inbound.packetsLost||0;jitter=inbound.jitter||0;
if(lastInboundPackets===null||count>lastInboundPackets)lastAudioFlow=Date.now();
lastInboundPackets=count;
const age=Date.now()-lastAudioFlow;
quality=age>15000?'dead':age>6500?'degraded':'good';
if(age>30000&&!document.hidden&&!audioSessionInterrupted&&(pc.connectionState==='failed'||pc.connectionState==='closed'||pc.iceConnectionState==='failed')){log('transport failed and RTP stalled; rebuilding');closeMedia();state('reconnecting','wait');}
const previous=lastStats?.quality;if(quality!==previous)log('audio flow: '+quality+'; jitter '+Math.round(jitter*1000)+'ms'+(rtt!==null?', RTT '+Math.round(rtt*1000)+'ms':''));
lastStats={quality,packets:count,loss,jitter,rtt};
}else{quality=pc.connectionState==='connected'?'unknown':'dead';}
refresh();ui.localState.textContent+='\naudio quality: '+quality+(lastStats?.rtt!=null?'\nRTT: '+Math.round(lastStats.rtt*1000)+'ms':'');
}catch(e){log('stats unavailable: '+e.name);}finally{statsBusy=false;}
}
function peerReady(p,index,ticket){
p.on('open',()=>{
if(p!==peer||ticket!==epoch||stopping){p.destroy();return;}
slot=index;state('waiting','wait');refresh();
if(index>=1){holdRemote=false;dial();dialData();}
clearTimers();
redialTimer=setInterval(()=>{
if(stopping||ticket!==epoch||!navigator.onLine)return;
if(peer?.disconnected&&!peer.destroyed){try{peer.reconnect();}catch{}}
if(slot>=1){if(media&&!media.open&&callAttemptAt&&Date.now()-callAttemptAt>(slot>=2?7500:14000)){log('outgoing call timed out; redialing');closeMedia();if(slot>=2)dialTargetIndex=1-dialTargetIndex;}if(data&&!data.open&&dataAttemptAt&&Date.now()-dataAttemptAt>12000){log('diagnostics timed out; reconnecting');const old=data;data=null;try{old.close();}catch{}}if(!media&&!holdRemote&&Date.now()>=nextRetry){dial();retryCount=Math.min(retryCount+1,7);nextRetry=Date.now()+Math.min(16000,1500*Math.pow(1.7,retryCount));}if(!data)dialData();}
},2000);
healthTimer=setInterval(()=>{
if(stopping||ticket!==epoch)return;
heartbeat();
inspectAudio();
if(hadPresence&&lastRemote&&!presenceLost&&!document.hidden&&!audioSessionInterrupted&&Date.now()-lastRemote>60000&&media?.peerConnection&&['failed','closed'].includes(media.peerConnection.connectionState)){
  presenceLost=true;
  log('remote transport failed and signaling absent; reconnecting');
  remote('reconnecting\nreason: transport failure');
  closeMedia();
  const stale=data;data=null;if(stale)try{stale.close();}catch{}
  state('waiting for rejoin','wait');
}
if(track()?.readyState==='ended'||track()?.muted)scheduleMicRecovery('health check');
if(ui.remoteAudio.srcObject&&(ui.remoteAudio.paused||pendingAudio))scheduleAudioResume('health check');
if(peer?.destroyed&&Date.now()-peerRetryAt>14000){peerRetryAt=Date.now();log('signaling closed; attempting recovery');const old=peer;peer=null;try{old.destroy();}catch{}if(slot>=0)openPeer(slot,ticket);}
if(media?.peerConnection?.connectionState==='failed'&&transportFailedAt&&Date.now()-transportFailedAt>30000&&!document.hidden&&!audioSessionInterrupted){log('webrtc failed persistently; redialing');closeMedia();state('reconnecting','wait');}
},3000);
});
p.on('call',c=>{
if(p!==peer||stopping||!stream||index>=2){c.close();return;}
const incomingDevice=c.metadata?.device;
if(media){
if(!incomingDevice||!remoteDevice||incomingDevice!==remoteDevice||!c.metadata?.session||c.metadata.session===remoteSession){log('rejected unrelated or duplicate incoming call');c.close();return;}
log('returning device verified; replacing previous media session');
closeMedia();
const old=data;data=null;if(old)try{old.close();}catch{}
remoteSession=null;
}
if(incomingDevice)remoteDevice=incomingDevice;
mediaEvents(c);c.answer(stream);
});
p.on('connection',c=>{
if(p!==peer){c.close();return;}
if(media&&c.peer!==media.peer){c.close();return;}
if(data?.open&&data.peer!==c.peer){c.close();return;}
watchData(c);
});
p.on('disconnected',()=>{log('signaling disconnected (reason unknown)');refresh();if(!stopping&&!p.destroyed){try{p.reconnect();}catch{}}});
p.on('close',()=>log('signaling closed'));
p.on('error',e=>{
if(p!==peer||ticket!==epoch||stopping)return;
log('PeerJS error: '+e.type);
if(e.type==='unavailable-id'&&index<ids.length-1){try{p.destroy();}catch{}if(peer===p)peer=null;openPeer(index+1,ticket);return;}
if(e.type==='unavailable-id'&&index===ids.length-1){
  log('all call slots occupied; waiting for stale sessions to expire');
  state('waiting for room','wait');
  try{p.destroy();}catch{}if(peer===p)peer=null;
  clearTimeout(roomRetryTimer);
  roomRetryTimer=setTimeout(()=>{if(ticket===epoch&&!stopping&&!peer&&stream)openPeer(0,ticket);},2500);
  return;
}
if(e.type==='peer-unavailable'){if(media)closeMedia();if(slot>=2)dialTargetIndex=1-dialTargetIndex;holdRemote=false;state('waiting','wait');return;}
if(['network','server-error','socket-error','socket-closed','disconnected'].includes(e.type)){state('reconnecting','wait');return;}
problem('connection: '+e.type);
});
}
function openPeer(index,ticket){
if(stopping||ticket!==epoch||!stream)return;
try{clearTimeout(roomRetryTimer);roomRetryTimer=null;const p=new Peer(ids[index],{debug:0,config:{iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]}});peer=p;peerReady(p,index,ticket);}
catch(e){problem('signaling setup failed: '+e.message);}
}
async function microphone(){
const supported=navigator.mediaDevices.getSupportedConstraints?.()||{};
const constraints={echoCancellation:true,autoGainControl:true,sampleRate:{ideal:48000},channelCount:{ideal:1}};
if(supported.noiseSuppression!==false)constraints.noiseSuppression=true;
let capture;
try{capture=await navigator.mediaDevices.getUserMedia({audio:constraints,video:false});}
catch(e){
if(e.name!=='OverconstrainedError'&&e.name!=='TypeError')throw e;
log('advanced audio constraints unavailable; using basic microphone');
capture=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
}
const voice=capture.getAudioTracks()[0];
if(voice&&'contentHint' in voice){try{voice.contentHint='speech';}catch{}}
if(voice?.getSettings){const settings=voice.getSettings();log('voice processing: '+(settings.noiseSuppression===true?'enabled':settings.noiseSuppression===false?'unavailable/disabled':'browser-managed'));}
return capture;
}
function watchMicrophone(s){
for(const t of s.getAudioTracks()){
t.addEventListener('mute',()=>{if(stream!==s)return;localMicInterruptedAt=Date.now();log('microphone interrupted by another app or system; preserving call');refresh();heartbeat();scheduleMicRecovery('track muted');});
t.addEventListener('unmute',()=>{if(stream!==s)return;clearTimeout(micRetryTimer);micRetryTimer=null;micRetryCount=0;localMicInterruptedAt=0;log('microphone resumed');refresh();heartbeat();resumeCall('microphone resumed');});
t.addEventListener('ended',()=>{if(stopping||stream!==s)return;log('microphone ended; attempting recovery');refresh();scheduleMicRecovery('track ended');});
}
}
async function begin(){
if(starting||stream||peer)return;
starting=true;ui.callBtn.disabled=true;problem('');
try{
if(!window.Peer)throw Error('PeerJS did not load');
if(!navigator.mediaDevices?.getUserMedia)throw Error('microphone unavailable (HTTPS required)');
const password=ui.password.value;
if(password.length<4)throw Error('enter a shared room password (4+ characters)');
state('starting','wait');
const ticket=++epoch;
const newIds=await roomIds(password);
if(ticket!==epoch)return;
ids=newIds;dialTargetIndex=0;remoteDevice=null;
watchAudioSession();
stream=await microphone();
if(ticket!==epoch){stream.getTracks().forEach(t=>t.stop());stream=null;return;}
userMuted=false;watchMicrophone(stream);controls(true);refresh();openPeer(0,ticket);
}catch(e){state('offline');captureError(e);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}}
finally{starting=false;ui.callBtn.disabled=false;}
}
ui.callBtn.addEventListener('click',begin);
ui.endBtn.addEventListener('click',()=>teardown());
ui.muteBtn.addEventListener('click',()=>{const t=track();if(!t)return;userMuted=!userMuted;t.enabled=!userMuted;ui.muteBtn.textContent=userMuted?'unmute':'mute';log(userMuted?'muted':'unmuted');heartbeat();});
ui.restoreBtn.addEventListener('click',()=>{requestAudioSession();play();if(track()?.muted||track()?.readyState==='ended')scheduleMicRecovery('manual restore',true);});
document.addEventListener('visibilitychange',()=>{log('page '+document.visibilityState);heartbeat();if(document.hidden){clearTimeout(micRetryTimer);micRetryTimer=null;}else resumeCall('page visible');});
window.addEventListener('pagehide',()=>{log('pagehide: navigation, tab closure, or browser suspension (unknown)');});
window.addEventListener('pageshow',()=>{log('page resumed');refresh();resumeCall('page shown');});
window.addEventListener('online',()=>{log('internet reported online');heartbeat();resumeCall('network online');});
window.addEventListener('offline',()=>{log('internet reported offline');quality='degraded';heartbeat();});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>{log('audio devices changed');refresh();resumeCall('audio device changed');});
ui.remoteAudio.addEventListener('pause',()=>{if(media){log('remote playback paused');scheduleAudioResume('playback paused');}});
ui.remoteAudio.addEventListener('playing',()=>{pendingAudio=false;ui.restoreBtn.hidden=true;});
ui.remoteAudio.addEventListener('error',()=>{log('audio element error');ui.restoreBtn.hidden=false;scheduleAudioResume('audio error');});
window.addEventListener('error',e=>problem('script error: '+e.message));
window.addEventListener('unhandledrejection',e=>problem('error: '+(e.reason?.message||String(e.reason))));
updateOnBoot();
function updateOnBoot(){refresh();}
})();