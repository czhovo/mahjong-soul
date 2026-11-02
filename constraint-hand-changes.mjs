const norm=t=>t.replace(/^([WBT])0$/,(_,s)=>s+'5');
const bag=tiles=>{const out={};for(const t of tiles)out[norm(t)]=(out[norm(t)]??0)+1;return out;};
const spent=t=>t.discardMode==='tsumogiri'&&t.discardEvidence?.inferred!==true?0:1;

// Journal entries survive called-away river tiles. Late discard-mode evidence
// updates the existing entry instead of charging the same discard twice.
export class ConstraintHandChanges {
 constructor(){this.sequence=0;this.players={};this.journal=[];}
 add(position,tile,count){const e={sequence:++this.sequence,position,tile:norm(tile),count};this.journal.push(e);return e;}
 observe(frame){
  const invalid=new Set();
  for(const position of ['left','opposite','right']){
   const p=this.players[position]??={river:null,melds:null};
   const river=frame.rivers?.[position];
   if(river?.complete){
    const next=river.tiles;
    if(p.river===null){p.river=next.map(t=>({tile:t.tile,entry:null}));invalid.add(position);}
    else {
     let prefix=0;while(prefix<p.river.length&&prefix<next.length&&p.river[prefix].tile===next[prefix].tile)prefix++;
     if(prefix<Math.min(p.river.length,next.length))invalid.add(position);
     const retained=p.river.slice(0,prefix);
     for(let i=0;i<prefix;i++)if(retained[i].entry)retained[i].entry.count=spent(next[i]);
     for(let i=prefix;i<next.length;i++)retained.push({tile:next[i].tile,entry:this.add(position,next[i].tile,spent(next[i]))});
     p.river=retained;
    }
   }
   const melds=frame.opponent_melds?.[position];
   if(melds?.complete){
    const next=melds.groups;
    if(p.melds===null){p.melds=structuredClone(next);invalid.add(position);}
    else {
     const unused=new Set(p.melds.map((_,i)=>i));
     for(const g of next){
      const now=bag(g.tiles);
      const match=[...unused].find(i=>{
       const old=p.melds[i];
       if(!(old.kind===g.kind||(old.kind==='PENG'&&g.kind==='BUGANG')))return false;
       return Object.entries(bag(old.tiles)).every(([t,n])=>(now[t]??0)>=n);
      });
      if(match!==undefined){
       unused.delete(match);for(const [t,n] of Object.entries(bag(p.melds[match].tiles)))now[t]-=n;
      }else if(g.kind!=='ANGANG'){
       if(!Number.isInteger(g.calledIndex)||!g.tiles[g.calledIndex]){invalid.add(position);continue;}
       now[norm(g.tiles[g.calledIndex])]--;
      }
      for(const [tile,n] of Object.entries(now))if(n>0)this.add(position,tile,n);
     }
     if(unused.size)invalid.add(position);
     p.melds=structuredClone(next);
    }
   }
  }
  return invalid;
 }
 lossSince(sequence,position,tile){return this.journal.filter(e=>e.sequence>sequence&&e.position===position&&e.tile===tile).reduce((n,e)=>n+e.count,0);}
}
