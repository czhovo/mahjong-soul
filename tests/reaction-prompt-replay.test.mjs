import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {currentDecision,promptDiscard} from '../current-decision.mjs';
import {samePassPrompt} from '../reaction-window.mjs';
import {CallWaitEvidence} from '../call-wait-evidence.mjs';
const load=name=>JSON.parse(readFileSync(new URL('./fixtures/'+name,import.meta.url)));
const pairs=load('reaction-prompts-1102.json'),states=['3 3 PLAY T2','3 1 PLAY B9','3 3 PLAY W5','3 2 PLAY W2','3 1 PLAY T7','3 2 PLAY W3','3 3 PLAY B3'];
for(const [i,[a,b]] of pairs.entries())test('actual call prompt '+states[i],()=>{
 assert.equal(promptDiscard(a)?.event.state,states[i]);
 const s={ledger:{hand:a.hand.tiles.map(t=>t.tile)},requests:[],responses:[]};
 assert.equal(currentDecision(s,a,b,a)?.requests.at(-1)?.state,states[i]);
});
test('actual five-man PASS retry tolerates unrelated incomplete left river but rejects a changed call',()=>{
 const [a,b]=pairs[2],e=promptDiscard(a).event;
 assert.equal(samePassPrompt(a,b,e),true);
 const next=structuredClone(b);next.rivers.right.tiles.at(-1).tile='Z7';
 assert.equal(samePassPrompt(a,next,e),false);
});
test('normal draw timer during slide does not erase the observed one-man wait',()=>{
 const frames=load('call-wait-draw-transition-1101.json'),events=[];
 const t=new CallWaitEvidence({onDetected:e=>events.push(e)});
 for(const f of frames)t.observe(f);
 assert.deepEqual(events.map(e=>e.tile),['W1']);
 const f=frames.find(f=>!f.hand.complete&&f.time_reserve.countdown_absent===false);
 assert.ok(f);assert.equal(Object.keys(f.controls).length,0);
 const veto=[];const t2=new CallWaitEvidence({onDetected:e=>veto.push(e)});
 for(const raw of frames)t2.observe(raw===f?{...raw,controls:{PENG:{},PASS:{}}}:raw);
 assert.equal(veto.length,0);
});
