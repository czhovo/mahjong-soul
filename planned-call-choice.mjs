const norm=t=>t.endsWith('0')?t[0]+'5':t;
const rank=t=>Number(norm(t)[1]);
const compare=(a,b)=>rank(a)-rank(b)||Number(a[1])-Number(b[1]);
const key=tiles=>[...tiles].sort(compare).join(' ');

// Same sequence first, then red before ordinary five. Recorded choice frames
// include both W0 W6 / W5 W6 and two-/three-group centered layouts.
export function callCombinations(hand,kind,called){
  const result=new Map(),c=norm(called),n=rank(called);
  for(let i=0;i<hand.length;i++)for(let j=i+1;j<hand.length;j++){
    const pair=[hand[i],hand[j]].sort(compare),a=norm(pair[0]),b=norm(pair[1]);
    if(kind==='PENG'){
      if(a!==c||b!==c)continue;
    }else if(kind==='CHI'){
      if(c[0]==='Z'||a[0]!==c[0]||b[0]!==c[0])continue;
      const ranks=[n,rank(a),rank(b)].sort((x,y)=>x-y);
      if(ranks[1]!==ranks[0]+1||ranks[2]!==ranks[1]+1)continue;
    }else throw Error('Expected CHI or PENG');
    // The client excludes calls with no legal subsequent discard (kuikae).
    const forbidden=new Set([c]);
    if(kind==='CHI'){
      if(rank(a)===n+1&&rank(b)===n+2)forbidden.add(c[0]+(n+3));
      if(rank(a)===n-2&&rank(b)===n-1)forbidden.add(c[0]+(n-3));
    }
    if(!hand.some((t,k)=>k!==i&&k!==j&&!forbidden.has(norm(t))))continue;
    result.set(key(pair),pair);
  }
  return [...result.values()].sort((a,b)=>rank(a[0])-rank(b[0])||rank(a[1])-rank(b[1])||compare(a[0],b[0])||compare(a[1],b[1]));
}

export function plannedCallChoice(sequence,frame){
  const choices=callCombinations(sequence.before.hand,sequence.meld.kind,sequence.meld.tiles[0]);
  const index=choices.findIndex(c=>key(c)===key(sequence.consumed));
  if(index<0)throw Error('Chosen call combination is not legal in the input hand');
  if(choices.length===1)return null; // The client directly calls; no choice UI.
  const {clientWidth:w,clientHeight:h}=frame;
  if(!(w>0&&h>0))throw Error('Client size required for call choice');
  return {consumed:choices[index],index,count:choices.length,center:[
    1+w*(0.5-20/1920+(index-(choices.length-1)/2)*200/1920),
    31+h*542.5/768,
  ]};
}
