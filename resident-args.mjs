export function parseResidentArgs(args){
 const tables=args.filter(a=>['-3','-4'].includes(a));
 if(tables.length>1)throw Error('场次人数最多只能选择一个：-3 三人场 / -4 四人场');
 const modes=args.filter(a=>['-b','-s','-g','-t'].includes(a));
 if(modes.length>1)throw Error('场次参数最多只能选择一个：-b 铜之间 / -s 银之间 / -g 金之间 / -t 玉之间');
 const paths=args.filter(a=>!['-b','-s','-g','-t','-d','-f','-l','-3','-4'].includes(a));
 if(paths.length>1||paths.some(a=>a.startsWith('-')))throw Error('用法：node resident.mjs [-3|-4] [配置文件绝对路径] [-b|-s|-g|-t] [-d] [-f] [-l]；不再支持版本号参数');
 if(!modes.length&&!args.includes('-f'))throw Error('未指定场次（-b / -s / -g / -t）时必须使用 -f');
 return {...(tables.length?{players:tables[0]==='-3'?3:4}:{}),configPath:paths[0]??null,briefPostMatch:modes[0]==='-b',singleMatch:args.includes('-f'),...(args.includes('-l')?{shortOnly:true}:{}),saveAllScreenshots:args.includes('-d'),...(modes[0]==='-g'?{goldRoom:true}:{}),...(modes[0]==='-t'?{jadeRoom:true}:{})};
}
