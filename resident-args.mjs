const ROOM_BY_FLAG = {'-b': 'bronze', '-s': 'silver', '-g': 'gold', '-t': 'jade'};
const KNOWN_FLAGS = new Set(['-b', '-s', '-g', '-t', '-d', '-f', '-l', '-3', '-4', '--naku']);

export function parseResidentArgs(args) {
  const tables = args.filter(a => ['-3', '-4'].includes(a));
  if (tables.length > 1) throw Error('场次人数最多只能选择一个：-3 三人场 / -4 四人场');
  const modes = args.filter(a => ['-b', '-s', '-g', '-t'].includes(a));
  if (modes.length > 1) throw Error('场次参数最多只能选择一个：-b 铜之间 / -s 银之间 / -g 金之间 / -t 玉之间');
  const paths = args.filter(a => !KNOWN_FLAGS.has(a));
  if (paths.length > 1 || paths.some(a => a.startsWith('-'))) {
    throw Error('用法：node resident.mjs [-3|-4] [配置文件绝对路径] [-b|-s|-g|-t] [-d] [-f] [-l] [--naku]');
  }
  const roomFlag = modes[0] ?? null;
  const fastStart = args.includes('-f');
  return {
    ...(tables.length ? {players: tables[0] === '-3' ? 3 : 4} : {}),
    ...(args.includes('--naku') ? {naku: true} : {}),
    configPath: paths[0] ?? null,
    room: roomFlag ? ROOM_BY_FLAG[roomFlag] : null,
    autoStart: roomFlag !== null,
    fastStart,
    briefPostMatch: roomFlag === '-b',
    singleMatch: fastStart,
    ...(args.includes('-l') ? {shortOnly: true} : {}),
    saveAllScreenshots: args.includes('-d'),
    ...(roomFlag === '-g' ? {goldRoom: true} : {}),
    ...(roomFlag === '-t' ? {jadeRoom: true} : {}),
  };
}
