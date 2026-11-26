const reported=new Set();
export function reportSavedScreenshot(path,emit){
 if(typeof path!=='string'||!path||reported.has(path))return false;
 reported.add(path);
 if(reported.size>1000)reported.delete(reported.values().next().value);
 const name=path.split(/[\\/]/).at(-1);
 const win=/_((?:\d+|未识别)番(?:\d+|未识别)符(?:\d+|未识别)点|(?:(?:[两三四五六]|\d+)倍)?役满(?:\d+|未识别)点)(?:_[^_]+)?\.png$/.exec(name);
 const limit=/_((?:\d+|未识别)点)_((?:(?:[两三四五六]|\d+)倍)?役满)_[^_]+\.png$/.exec(name);
 const winSummary=win?.[1]??(limit&&limit[2]+limit[1]);
 const match=/_终局_第([^_]+)名_([^_]+)点_PT([^_]+)\.png$/.exec(name);
 if(match)emit(`终局结算，第${match[1]}名，${match[2]}点，积分${match[3]}，已保存图片${name}`);
 else if(winSummary)emit(`和牌，${winSummary}，已保存图片${name}`);
 else emit(`已保存图片${name}`);
 return true;
}
