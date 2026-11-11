// Restrict an owner-requested serial pass without changing any admission gate.
export function maintenanceTarget(args:string[]):number|undefined {
 if(args.length===1&&args[0]==='--once')return;
 if(args.length===3&&args[0]==='--once'&&args[1]==='--pr'&&/^[1-9]\d*$/.test(args[2])&&Number.isSafeInteger(Number(args[2])))return Number(args[2]);
 throw Error('Usage: bun scripts/maintain-factory.ts --once [--pr NUMBER]');
}
