const reported=new Set();
export function reportSavedScreenshot(path,emit){
 if(typeof path!=='string'||!path||reported.has(path))return false;
 reported.add(path);
 if(reported.size>1000)reported.delete(reported.values().next().value);
 const name=path.split(/[\\/]/).at(-1);
 const win=/_([^_]+番[^_]+符[^_]+点)\.png$/.exec(name);
 const match=/_终局_第([^_]+)名_([^_]+)点_PT([^_]+)\.png$/.exec(name);
 if(match)emit(`终局结算，第${match[1]}名，${match[2]}点，积分${match[3]}，已保存图片${name}`);
 else if(win)emit(`和牌，${win[1]}，已保存图片${name}`);
 else emit(`已保存图片${name}`);
 return true;
}
