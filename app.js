(() => {
'use strict';
const $ = id => document.getElementById(id);
const ui=Object.fromEntries(['dot','status','timer','password','setup','callBtn','muteBtn','endBtn','scanBtn','slotCounts','restoreBtn','error','browserLink','localState','remoteState','diagnostics','remoteAudio'].map(id=>[id,$(id)]));
const events=[];
const REJOIN_KEY='muckyducky-rejoin-v1';
const REJOIN_TTL=24*60*60*1000;
const rescueJoin=new URLSearchParams(window.location.search).get('rescue')==='1';
let activeRoomPrimary=null,refreshRejoinActive=false,autoRescue=false;
function readSavedCall(){
try{
const raw=sessionStorage.getItem(REJOIN_KEY);
if(!raw)return null;
const saved=JSON.parse(raw);
if(!saved||typeof saved.roomPrimary!=='string'||!/^md-[a-f0-9]{42}-a$/.test(saved.roomPrimary)||
!Number.isFinite(saved.savedAt)||Date.now()-saved.savedAt>REJOIN_TTL||saved.savedAt>Date.now()+60000){
sessionStorage.removeItem(REJOIN_KEY);return null;
}
return saved;
}catch{return null;}
}
function rememberCall(){
if(!activeRoomPrimary)return;
try{sessionStorage.setItem(REJOIN_KEY,JSON.stringify({roomPrimary:activeRoomPrimary,muted:userMuted,savedAt:Date.now()}));}
catch{log('tab storage unavailable; refreshing may require joining manually');}
}
function forgetCall(){activeRoomPrimary=null;refreshRejoinActive=false;try{sessionStorage.removeItem(REJOIN_KEY);}catch{}}
function idsFromPrimary(primary){
if(!/^md-[a-f0-9]{42}-a$/.test(primary))throw Error('saved room is invalid');
const tag=primary.slice(3,-2);
const fresh=()=> 'md-'+tag.slice(0,32)+'-r-'+(crypto.randomUUID?.().replace(/-/g,'')||Math.random().toString(36).slice(2));
return [primary,'md-'+tag+'-b',...['c','d','e','f'].map(s=>'md-'+tag+'-'+s),fresh(),fresh()];
}
const deviceId=(()=>{try{let id=localStorage.getItem('muckyducky-device-v1');if(!id){id=crypto.randomUUID();localStorage.setItem('muckyducky-device-v1',id);}return id;}catch{return crypto.randomUUID?.()||String(Date.now())+'-'+Math.random();}})();

let peer=null,media=null,data=null,stream=null,ids=null,slot=-1,epoch=0,stopping=false,starting=false,connecting=false,dialTargetIndex=0,remoteDevice=null,targetHistory={},dialTargetName='none',occupiedSlots=new Set(),pendingInbound=null,manualScan=false,emptyReports={};
let healthTimer=null,redialTimer=null,clockTimer=null,startedAt=0,lastRemote=0,lastHeartbeat=0,remoteReason='',remoteState='offline',pendingAudio=false,callAttemptAt=0,dataAttemptAt=0;
let recoveryBusy=false,lastRecoveryAt=0,peerRetryAt=0,roomRetryTimer=null,presenceLost=false,hadPresence=false,mediaOpenedAt=0;
let playbackCheckAt=0,playbackCheckTime=null,playbackStalledAt=0,lastPlaybackRepair=0,playbackRepairCount=0,inboundStalledAt=0,lastTransportRepair=0,playbackRepairBusy=false;
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
const ios=/iPad|iPhone|iPod/.test(navigator.userAgent||'');
problem(ios?'Microphone access is blocked in this browser context. Open the site directly in Safari, check its microphone permission, and try again. iOS restrictions cannot be overridden by this page.':'Microphone access is blocked. Allow microphone access in Vivaldi or your browser site settings and check Linux microphone permissions.',ios);
return;
}
if(e?.name==='NotReadableError'||e?.name==='TrackStartError'){
problem('Microphone is unavailable to the browser. On Linux, check the selected input device, PipeWire/PulseAudio capture routing and Vivaldi microphone permission.');
return;
}
if(e?.name==='NotFoundError'||e?.name==='DevicesNotFoundError'){
problem('No microphone detected. Check the Linux audio input device and browser permissions.');
return;
}
problem(prefix+': '+(e?.message||e?.name||String(e)));
}
function allRoomSlots(){
if(!ids)return [];
const original=ids[0];
return [
{label:'A',id:ids[0]},
{label:'B',id:ids[1]},
{label:'C',id:original.slice(0,-1)+'c'},
{label:'D',id:original.slice(0,-1)+'d'},
{label:'E',id:original.slice(0,-1)+'e'},
{label:'F',id:original.slice(0,-1)+'f'}
];
}
function targetCandidates(){
if(!peer?.id)return [];
return allRoomSlots().filter(t=>t.id!==peer.id);
}
function updateSlotCounts(){
ui.slotCounts.hidden=!stream;
if(!stream)return;
const connectedPeer=media?.open?media.peer:null;
const lines=allRoomSlots().map(t=>{
if(t.id===peer?.id)return t.label+': 1 confirmed (you)';
if(t.id===connectedPeer)return t.label+': 1 confirmed (connected)';
const result=targetHistory[t.label];
if(result==='trying')return t.label+': checking…';
if(emptyReports[t.label]&&Date.now()-emptyReports[t.label]<30000)return t.label+': empty (not registered at last check)';
if(occupiedSlots.has(t.label))return t.label+': ID occupied (possibly stale)';
if(result==='no answer'||result==='closed before connected')return t.label+': no answer (occupancy unknown)';
return t.label+': not checked / unknown';
});
if(slot>=6&&peer?.open)lines.push('backup: 1 confirmed (you)');
ui.slotCounts.textContent=lines.join('\n');
}
function markTarget(label,result){
if(label&&label!=='none'){targetHistory[label]=result;if(result==='trying'||result==='connected')delete emptyReports[label];}
refresh();
}
function advanceTarget(reason){
const targets=targetCandidates();
if(!targets.length)return;
if(dialTargetName&&dialTargetName!=='none')targetHistory[dialTargetName]=reason;
dialTargetIndex=(dialTargetIndex+1)%targets.length;
nextRetry=(rescueJoin||autoRescue)?0:Date.now()+1200;
refresh();
}
function refresh(){
window.dispatchEvent(new CustomEvent('muckyducky:presence',{detail:{room:stream?activeRoomPrimary:null,connected:!!media?.open}}));
const t=track();
updateSlotCounts();
ui.scanBtn.hidden=false;ui.scanBtn.disabled=!!media?.open||starting;
const slots=Object.entries(targetHistory).map(([k,v])=>k+': '+v).join(', ')||'none';
ui.localState.textContent='signaling: '+(peer?.open?'online':'offline')+
'\nmic: '+(!t?'off':t.readyState==='ended'?'ended':t.muted?'interrupted':t.enabled?'on':'muted')+
'\naudio session: '+audioSessionState+
'\npage: '+document.visibilityState+
'\nnetwork: '+(navigator.onLine?'online':'offline')+
'\ncall: '+(media?.open?'open':'not connected')+
'\nyour slot: '+(slot<0?'not assigned':slot<6?String.fromCharCode(65+slot):'backup')+
'\ntrying: '+(media?.open?'connected':dialTargetName)+
'\nslot attempts: '+slots+'\noccupied IDs: '+(occupiedSlots.size?[...occupiedSlots].join(', ')+' (may be stale)':'none detected');
}
function transmit(msg){if(data?.open){try{data.send(msg);}catch(e){log('diagnostic send failed');}}}
function heartbeat(){refresh();transmit({type:'status',session:sessionId,state:ui.localState.textContent,time:Date.now(),pageHidden:document.hidden,micInterrupted:!!track()?.muted,device:deviceId});heartbeatAt=Date.now();}
async function roomIds(password){
const bytes=new TextEncoder().encode('muckyducky-private-room-v2\u0000'+password);
const digest=await crypto.subtle.digest('SHA-256',bytes);
const h=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
return idsFromPrimary('md-'+h.slice(0,42)+'-a');
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
function resetPlaybackTracking(){
playbackCheckAt=0;playbackCheckTime=null;playbackStalledAt=0;playbackRepairCount=0;lastPlaybackRepair=0;inboundStalledAt=0;playbackRepairBusy=false;
}
async function repairIncomingPlayback(reason){
if(playbackRepairBusy||!media?.open||!ui.remoteAudio.srcObject||stopping||document.hidden||audioSessionInterrupted)return;
if(Date.now()-lastPlaybackRepair<20000||playbackRepairCount>=2)return;
const call=media,original=ui.remoteAudio.srcObject;
playbackRepairBusy=true;lastPlaybackRepair=Date.now();playbackRepairCount++;
log('restarting incoming playback ('+reason+'), keeping call');
try{
ui.remoteAudio.pause();
ui.remoteAudio.srcObject=null;
await new Promise(resolve=>setTimeout(resolve,180));
if(stopping||media!==call||!call.open||document.hidden||audioSessionInterrupted)return;
ui.remoteAudio.srcObject=original;
ui.remoteAudio.autoplay=true;
ui.remoteAudio.playsInline=true;
await play();
}catch(e){log('playback restart failed: '+(e.name||e.message));}
finally{playbackRepairBusy=false;playbackStalledAt=0;playbackCheckTime=null;playbackCheckAt=0;}
}
function inspectPlayback(){
if(!media?.open||!ui.remoteAudio.srcObject||stopping||document.hidden||audioSessionInterrupted||playbackRepairBusy)return;
const a=ui.remoteAudio,now=Date.now();
if(a.paused||pendingAudio){scheduleAudioResume('playback watchdog');return;}
if(a.readyState<2){
if(!playbackStalledAt)playbackStalledAt=now;
}else if(playbackCheckTime!==null&&Number.isFinite(a.currentTime)&&a.currentTime>playbackCheckTime+0.12){
playbackStalledAt=0;
}else if(playbackCheckAt&&now-playbackCheckAt>1800){
if(!playbackStalledAt)playbackStalledAt=now;
}
if(playbackStalledAt&&now-playbackStalledAt>10000&&lastStats?.quality==='good'&&
!remoteMicInterrupted&&!remotePageHidden){
repairIncomingPlayback('incoming RTP arriving but playback time stalled');
}
playbackCheckAt=now;
playbackCheckTime=Number.isFinite(a.currentTime)?a.currentTime:null;
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
function closeMedia(){callAttemptAt=0;mediaOpenedAt=0;lastStats=null;lastInboundPackets=null;resetPlaybackTracking();let c=media;media=null;if(c)try{c.close();}catch{}ui.remoteAudio.srcObject=null;ui.restoreBtn.hidden=true;pendingAudio=false;stopClock();}
function clearTimers(){clearInterval(healthTimer);clearInterval(redialTimer);clearTimeout(roomRetryTimer);clearTimeout(micRetryTimer);clearTimeout(audioResumeTimer);micRetryTimer=audioResumeTimer=null;healthTimer=redialTimer=roomRetryTimer=null;}
function controls(active){ui.setup.hidden=active;ui.callBtn.hidden=active;ui.muteBtn.hidden=!active;ui.endBtn.hidden=!active;ui.scanBtn.hidden=false;ui.callBtn.disabled=false;}
function teardown(reason='hang up button pressed'){
stopping=true;epoch++;forgetCall();transmit({type:'exit',reason});userMuted=false;micRetryCount=0;audioSessionInterrupted=false;transportFailedAt=0;log('you: '+reason);clearTimers();closeMedia();const d=data;data=null;const p=peer;peer=null;if(d||p)setTimeout(()=>{if(d)try{d.close();}catch{}if(p)try{p.destroy();}catch{}},650);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}ids=null;slot=-1;starting=false;connecting=false;lastRemote=0;remoteReason='';presenceLost=false;hadPresence=false;holdRemote=false;remoteSession=null;remoteDevice=null;dialTargetIndex=0;dialTargetName='none';targetHistory={};occupiedSlots.clear();emptyReports={};manualScan=false;autoRescue=false;retryCount=0;nextRetry=0;lastAudioFlow=0;remoteAudioInterruptedAt=0;remotePageHidden=false;remoteMicInterrupted=false;localMicInterruptedAt=0;remote('offline');controls(false);ui.muteBtn.textContent='mute';state('offline');problem('');refresh();stopping=false;
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
c.on('stream',s=>{if(media!==c)return;remoteAudioInterruptedAt=0;callAttemptAt=0;mediaOpenedAt=Date.now();refreshRejoinActive=false;retryCount=0;nextRetry=0;lastAudioFlow=Date.now();resetPlaybackTracking();ui.remoteAudio.srcObject=s;transportFailedAt=0;markTarget(dialTargetName,'connected');for(const t of s.getAudioTracks()){t.addEventListener('mute',()=>{remoteAudioInterruptedAt=Date.now();log('remote microphone temporarily interrupted; preserving call');});t.addEventListener('unmute',()=>{remoteAudioInterruptedAt=0;log('remote track resumed');play();});t.addEventListener('ended',()=>{log('remote audio track ended; requesting a fresh call');if(media===c&&!stopping){closeMedia();state('reconnecting','wait');}});}state('connected','live');holdRemote=false;problem('');if(!data?.open||remoteState==='offline'||remoteState.startsWith('disconnected'))remote('audio connected\ndiagnostics: '+(data?.open?'waiting for status':'connecting')+'\nincoming sound: not yet verified');startClock();play();heartbeat();dialData();});
c.on('close',()=>{if(media!==c)return;media=null;ui.remoteAudio.srcObject=null;stopClock();if(!stopping){if(!c.open)advanceTarget('closed before connected');nextRetry=Date.now()+1200;state('reconnecting','wait');remote('disconnected\nreason: '+(remoteReason||'unknown; connection ended'));}});
c.on('error',e=>{log('media error: '+(e.type||e.message));if(media===c){closeMedia();if(!stopping)state('reconnecting','wait');}});
}
function watchData(c){
if(data&&data!==c){if(data.open&&media?.open&&data.peer===media.peer){c.close();return;}if(data.open&&data.peer!==c.peer){c.close();return;}try{data.close();}catch{}}
data=c;
c.on('open',()=>{dataAttemptAt=0;presenceLost=false;hadPresence=true;lastRemote=Date.now();log('diagnostics linked');heartbeat();});
c.on('data',m=>{
if(c!==data||!m||typeof m!=='object')return;
lastRemote=Date.now();presenceLost=false;hadPresence=true;
if(m.type==='status'){if(m.device&&remoteDevice&&m.device!==remoteDevice&&media){log('ignored status from different participant');return;}if(m.device)remoteDevice=m.device;if(m.session&&remoteSession&&m.session!==remoteSession){log('remote session changed; preserving media until a new call is established');}remoteSession=m.session||remoteSession;holdRemote=false;remotePageHidden=!!m.pageHidden;remoteMicInterrupted=!!m.micInterrupted;if(remoteMicInterrupted&&!remoteAudioInterruptedAt)remoteAudioInterruptedAt=Date.now();if(!remoteMicInterrupted&&remoteAudioInterruptedAt)remoteAudioInterruptedAt=0;remote(m.state+'\nupdated: just now');}
if(m.type==='exit'){transmit({type:'exit-ack'});remoteReason=m.reason||'hang up';remote('offline\nreason: '+remoteReason);log('other person: '+remoteReason);holdRemote=true;closeMedia();state('waiting for rejoin','wait');const stale=data;data=null;if(stale)try{stale.close();}catch{}}
});
c.on('close',()=>{if(data!==c)return;data=null;if(!stopping){log('diagnostics disconnected');if(media?.open)remote('audio connected\ndiagnostics: reconnecting');else if(Date.now()-lastRemote>25000)remote('unreachable\nreason: unknown');}});
c.on('error',e=>log('diagnostics error: '+e.message));
}
function dial(){
if(stopping||holdRemote||(slot<1&&!manualScan&&!rescueJoin&&!autoRescue)||!peer?.open||!stream||media)return;
const targets=targetCandidates();
if(!targets.length)return;
const selected=targets[dialTargetIndex%targets.length];
if(!selected||selected.id===peer.id){log('skipped own peer ID');advanceTarget('self skipped');return;}
dialTargetName=selected.label;
markTarget(selected.label,'trying');
log('trying room slot '+selected.label);
try{
const c=peer.call(selected.id,stream,{metadata:{device:deviceId,session:sessionId,rejoin:refreshRejoinActive}});
if(c){callAttemptAt=Date.now();mediaEvents(c);}
else advanceTarget('no call created');
}catch(e){log('dial failed: '+e.message);advanceTarget('dial error');}
}
function dialData(){
if(stopping||!peer?.open||data||!media?.open||!media.peer)return;
try{dataAttemptAt=Date.now();log('connecting diagnostics to current audio peer');watchData(peer.connect(media.peer,{reliable:true}));}catch(e){log('data dial failed: '+e.message);}
}
async function inspectAudio(){
if(statsBusy||!media?.peerConnection||stopping)return;
const pc=media.peerConnection;if(pc.connectionState==='closed')return;
statsBusy=true;
try{
const reports=await pc.getStats();let inbound=null,outbound=null,loss=0,jitter=0,rtt=null;
reports.forEach(x=>{if(x.type==='inbound-rtp'&&(x.kind==='audio'||x.mediaType==='audio'))inbound=x;if(x.type==='outbound-rtp'&&(x.kind==='audio'||x.mediaType==='audio'))outbound=x;if(x.type==='candidate-pair'&&x.state==='succeeded'&&x.currentRoundTripTime!=null)rtt=x.currentRoundTripTime;});
if(inbound){let count=inbound.packetsReceived||0;loss=inbound.packetsLost||0;jitter=inbound.jitter||0;
if(lastInboundPackets===null||count>lastInboundPackets)lastAudioFlow=Date.now();
lastInboundPackets=count;
const age=Date.now()-lastAudioFlow;
quality=age>15000?'dead':age>6500?'degraded':'good';
const energy=typeof inbound.totalAudioEnergy==='number'?inbound.totalAudioEnergy:null;
const emitted=typeof inbound.jitterBufferEmittedCount==='number'?inbound.jitterBufferEmittedCount:null;
const level=typeof inbound.audioLevel==='number'?inbound.audioLevel:null;
const energyGrowing=energy!==null&&lastStats?.energy!==null&&lastStats?.energy!==undefined&&energy>lastStats.energy;
const decodedGrowing=emitted!==null&&lastStats?.emitted!==null&&lastStats?.emitted!==undefined&&emitted>lastStats.emitted;
if(age>40000&&mediaOpenedAt&&Date.now()-mediaOpenedAt>45000&&!remotePageHidden&&!remoteMicInterrupted&&
!document.hidden&&!audioSessionInterrupted&&Date.now()-lastTransportRepair>60000&&media?.open){
lastTransportRepair=Date.now();
log('incoming audio packets stopped for 40s; reconnecting call');
closeMedia();state('reconnecting','wait');return;
}
if(age>30000&&!document.hidden&&!audioSessionInterrupted&&(pc.connectionState==='failed'||pc.connectionState==='closed'||pc.iceConnectionState==='failed')){log('transport failed and RTP stalled; rebuilding');closeMedia();state('reconnecting','wait');}
const previous=lastStats?.quality;if(quality!==previous)log('audio flow: '+quality+'; jitter '+Math.round(jitter*1000)+'ms'+(rtt!==null?', RTT '+Math.round(rtt*1000)+'ms':''));
lastStats={quality,packets:count,loss,jitter,rtt,energy,emitted,level,energyGrowing,decodedGrowing};
}else{
 quality='unknown (no inbound audio stats)';
 if(media?.open&&mediaOpenedAt&&Date.now()-mediaOpenedAt>12000)remote('audio connected\nincoming RTP: not confirmed');
}
refresh();ui.localState.textContent+='\naudio quality: '+quality+(lastStats?.rtt!=null?'\nRTT: '+Math.round(lastStats.rtt*1000)+'ms':'')+
'\nincoming packets: '+(inbound?.packetsReceived??'unknown')+'\noutgoing packets: '+(outbound?.packetsSent??'unknown')+
'\ndecoding: '+(lastStats?.emitted==null?'unknown':lastStats.decodedGrowing?'active':'no new frames in last sample')+
'\nincoming sound: '+(lastStats?.energy==null?'unknown':lastStats.energyGrowing?'detected recently':'quiet / not detected')+
'\nplayback: '+(ui.remoteAudio.paused?'paused':ui.remoteAudio.readyState<2?'buffering':'playing (not proof of audible sound)')+
'\nplayback restarts: '+playbackRepairCount;
}catch(e){log('stats unavailable: '+e.name);}finally{statsBusy=false;}
}
function peerReady(p,index,ticket){
p.on('open',()=>{
if(p!==peer||ticket!==epoch||stopping){p.destroy();return;}
slot=index;dialTargetIndex=0;state((rescueJoin||autoRescue)?'finding existing call':'waiting','wait');refresh();
if(index>=1||manualScan||rescueJoin||autoRescue){holdRemote=false;dial();}
clearTimers();
redialTimer=setInterval(()=>{
if(stopping||ticket!==epoch||!navigator.onLine)return;
if(peer?.disconnected&&!peer.destroyed){try{peer.reconnect();}catch{}}
if(slot>=1||manualScan||rescueJoin||autoRescue){if(media&&!media.open&&callAttemptAt&&Date.now()-callAttemptAt>((rescueJoin||autoRescue)?4500:8000)){log('outgoing call timed out on slot '+dialTargetName+'; trying another slot');advanceTarget('no answer');closeMedia();if(rescueJoin||autoRescue)nextRetry=0;}if(data&&!data.open&&dataAttemptAt&&Date.now()-dataAttemptAt>12000){log('diagnostics timed out; reconnecting');const old=data;data=null;try{old.close();}catch{}}if(!media&&!holdRemote&&Date.now()>=nextRetry){dial();retryCount=Math.min(retryCount+1,7);nextRetry=Date.now()+((rescueJoin||autoRescue)?600:Math.min(9000,1200*Math.pow(1.5,retryCount)));}if(!data&&media?.open)dialData();}
},2000);
healthTimer=setInterval(()=>{
if(stopping||ticket!==epoch)return;
heartbeat();
inspectAudio();
inspectPlayback();
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
if(p!==peer||stopping||!stream){c.close();return;}
const incomingDevice=c.metadata?.device;
const incomingSession=c.metadata?.session;
if(media){
const prior=media.peerConnection;
const transportBad=prior?.connectionState==='failed'||prior?.connectionState==='closed'||prior?.iceConnectionState==='failed';
const oldUnresponsive=lastRemote>0&&Date.now()-lastRemote>30000;
const previousSession=remoteSession;
const sameDeviceRejoin=!!(c.metadata?.rejoin&&incomingDevice&&remoteDevice&&incomingDevice===remoteDevice&&
incomingSession&&previousSession&&incomingSession!==previousSession);
if(!sameDeviceRejoin&&(!incomingDevice||!remoteDevice||incomingDevice!==remoteDevice||!incomingSession||incomingSession===previousSession||(!transportBad&&!oldUnresponsive))){
log('rejected incoming duplicate while existing call is protected');
c.close();return;
}
log(sameDeviceRejoin?'returning device reclaiming call after refresh':'returning device taking over unresponsive call');
closeMedia();
const old=data;data=null;if(old)try{old.close();}catch{}
}
if(incomingDevice)remoteDevice=incomingDevice;
if(incomingSession)remoteSession=incomingSession;
dialTargetName=allRoomSlots().find(t=>t.id===c.peer)?.label||'incoming';
mediaEvents(c);c.answer(stream);
});
p.on('connection',c=>{
if(p!==peer){c.close();return;}
if(media&&c.peer!==media.peer){c.close();return;}
if(data?.open&&data.peer!==c.peer){c.close();return;}
watchData(c);
});
p.on('disconnected',()=>{if(p!==peer)return;log('signaling disconnected (reason unknown)');refresh();if(!stopping&&!p.destroyed){try{p.reconnect();}catch{}}});
p.on('close',()=>{if(p===peer)log('signaling closed');});
p.on('error',e=>{
if(p!==peer||ticket!==epoch||stopping)return;
log('PeerJS error: '+e.type);
if(e.type==='unavailable-id'&&index<ids.length-1){
const label=index<6?String.fromCharCode(65+index):'backup';
occupiedSlots.add(label);
log('slot '+label+' occupied (possibly a stale signaling session)');
try{p.destroy();}catch{}if(peer===p)peer=null;
if(index===0&&!rescueJoin){
  autoRescue=true;manualScan=true;
  log('A occupied: using an independent rescue ID and scanning A-F, without claiming B');
  state('finding existing call','wait');
  openPeer(ids.length-1,ticket);
}else openPeer(index+1,ticket);
return;
}
if(e.type==='unavailable-id'&&index===ids.length-1){occupiedSlots.add('backup');
  log('fresh reconnect identifiers unavailable; creating new identifiers');
  state('waiting for room','wait');
  try{p.destroy();}catch{}if(peer===p)peer=null;
  clearTimeout(roomRetryTimer);
  roomRetryTimer=setTimeout(()=>{if(ticket===epoch&&!stopping&&!peer&&stream){ids[6]='md-'+ids[0].slice(3,35)+'-r-'+(crypto.randomUUID?.().replace(/-/g,'')||Math.random().toString(36).slice(2));ids[7]='md-'+ids[0].slice(3,35)+'-r-'+(crypto.randomUUID?.().replace(/-/g,'')||Math.random().toString(36).slice(2));openPeer((rescueJoin||autoRescue)?7:6,ticket);}},2500);
  return;
}
if(e.type==='peer-unavailable'){if(media&&!media.open){const unavailableId=media.peer;const target=allRoomSlots().find(t=>t.id===unavailableId);if(target){emptyReports[target.label]=Date.now();markTarget(target.label,'empty (server says peer unavailable)');log('slot '+target.label+' not registered at last check');}advanceTarget('empty (not registered)');closeMedia();}if(!media)state('waiting','wait');return;}
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
capture=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
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
async function begin(scanRequested=false,options={}){
if(starting||stream||peer)return;
if(!options.roomPrimary&&ui.password.value==='1'){
window.dispatchEvent(new Event('muckyducky:admin-open'));
return;
}
starting=true;ui.callBtn.disabled=true;problem('');
try{
if(!window.Peer)throw Error('PeerJS did not load');
if(!navigator.mediaDevices?.getUserMedia)throw Error('microphone unavailable (HTTPS required)');
const savedPrimary=options.roomPrimary||null;
const password=ui.password.value;
if(!savedPrimary&&password.length<4)throw Error('enter a shared room password (4+ characters)');
state(savedPrimary?'rejoining':'starting','wait');
const ticket=++epoch;
const newIds=savedPrimary?idsFromPrimary(savedPrimary):await roomIds(password);
if(ticket!==epoch)return;
ids=newIds;dialTargetIndex=0;remoteDevice=null;targetHistory={};dialTargetName='none';occupiedSlots.clear();emptyReports={};manualScan=scanRequested;autoRescue=false;
refreshRejoinActive=!!savedPrimary;
watchAudioSession();
const acquired=await microphone();
if(ticket!==epoch){acquired.getTracks().forEach(t=>t.stop());return;}
stream=acquired;
userMuted=!!options.muted;
const t=track();if(t)t.enabled=!userMuted;
ui.muteBtn.textContent=userMuted?'unmute':'mute';
activeRoomPrimary=ids[0];rememberCall();
watchMicrophone(stream);controls(true);ui.restoreBtn.textContent='restore audio';ui.restoreBtn.hidden=true;refresh();if(rescueJoin){log('rescue join: using fresh ID, calling existing A/B slots without claiming them');state('finding existing call','wait');manualScan=true;openPeer(ids.length-1,ticket);}else openPeer(0,ticket);
}catch(e){
if(options.auto){
state('tap to rejoin','wait');
captureError(e,'automatic rejoin failed');
controls(true);
ui.muteBtn.hidden=true;
ui.restoreBtn.textContent='tap to rejoin';
ui.restoreBtn.hidden=false;
log('automatic rejoin needs a tap or microphone permission');
}else{state('offline');captureError(e);controls(false);}
if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
}
finally{starting=false;ui.callBtn.disabled=false;}
}
ui.callBtn.addEventListener('click',()=>begin(false));
ui.endBtn.addEventListener('click',()=>teardown());
ui.muteBtn.addEventListener('click',()=>{const t=track();if(!t)return;userMuted=!userMuted;t.enabled=!userMuted;ui.muteBtn.textContent=userMuted?'unmute':'mute';rememberCall();log(userMuted?'muted':'unmuted');heartbeat();});
ui.scanBtn.addEventListener('click',()=>{
if(stopping||media?.open)return;
if(!stream){begin(true);return;}
manualScan=true;
if(media){closeMedia();}
if(dialTargetName!=='none')advanceTarget('skipped manually');
nextRetry=0;retryCount=0;
log('manual room scan requested');
if(peer?.open)dial();else state('waiting for signaling','wait');
refresh();
});
ui.restoreBtn.addEventListener('click',()=>{
if(!stream&&!peer){const saved=readSavedCall();if(saved){begin(true,{roomPrimary:saved.roomPrimary,muted:!!saved.muted,auto:true});return;}}
requestAudioSession();play();if(track()?.muted||track()?.readyState==='ended')scheduleMicRecovery('manual restore',true);
});
document.addEventListener('visibilitychange',()=>{log('page '+document.visibilityState);heartbeat();if(document.hidden){clearTimeout(micRetryTimer);micRetryTimer=null;}else resumeCall('page visible');});
window.addEventListener('pagehide',()=>{log('pagehide: navigation, tab closure, or browser suspension (unknown)');});
window.addEventListener('pageshow',()=>{log('page resumed');refresh();resumeCall('page shown');});
window.addEventListener('focus',()=>{if(stream)resumeCall('window focused');});
window.addEventListener('online',()=>{log('internet reported online');heartbeat();resumeCall('network online');});
window.addEventListener('offline',()=>{log('internet reported offline');quality='degraded';heartbeat();});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>{log('audio devices changed');refresh();resumeCall('audio device changed');});
ui.remoteAudio.addEventListener('pause',()=>{if(media&&!playbackRepairBusy){log('remote playback paused');scheduleAudioResume('playback paused');}});
ui.remoteAudio.addEventListener('stalled',()=>{if(media){log('incoming media playback stalled');scheduleAudioResume('stalled event');}});
ui.remoteAudio.addEventListener('waiting',()=>{if(media)log('incoming media buffering');});
ui.remoteAudio.addEventListener('playing',()=>{pendingAudio=false;ui.restoreBtn.hidden=true;});
ui.remoteAudio.addEventListener('error',()=>{log('audio element error');ui.restoreBtn.hidden=false;scheduleAudioResume('audio error');});
window.addEventListener('error',e=>problem('script error: '+e.message));
window.addEventListener('unhandledrejection',e=>problem('error: '+(e.reason?.message||String(e.reason))));
updateOnBoot();
function updateOnBoot(){
const saved=readSavedCall();
if(!saved){refresh();return;}
activeRoomPrimary=saved.roomPrimary;
controls(true);ui.muteBtn.hidden=true;
ui.restoreBtn.textContent='tap to rejoin';ui.restoreBtn.hidden=true;
state('rejoining','wait');refresh();
log('restoring previous active call after full refresh');
begin(true,{roomPrimary:saved.roomPrimary,muted:!!saved.muted,auto:true});
}
})();